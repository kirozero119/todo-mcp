/**
 * 書き込みの順番そのもの。`main.ts` から切り出してあるのは、この順番が
 * 「途中で落ちたときに何が壊れるか」を決めているから —— テストから
 * 故意に途中で失敗させて確かめられる形にしておく必要がある。
 *
 * 順番は 4 段階で、最初の 1 段が本題。
 *
 * 1. **採番カウンタを、行を書くより先に引き上げる**。
 * 2. 旧 id を明示した INSERT を 1 行ずつ（トランザクションは張らない）。
 * 3. カウンタを冪等に再アサートして最終値を報告する。
 * 4. 全行を読み直して、書いたはずの値と全列一致するかを確認する。
 *
 * **なぜ 1 を先にやるか**: 以前は引き上げが INSERT ループの**後**にあった。
 * ループが途中で落ちる経路（ネットワーク断など）はカウンタを上げずに終了するので、
 * 例えば 3 件だけ入って落ちると `seq=13` のまま残る。すると次に MCP 経由で
 * 作られるタスクが id 14 を取るが、**id 14 は旧 DB に実在するアーカイブ済みタスク**
 * （done「レイヤーX社専用の職務経歴書を作成する」）で、会話 UI で「14 番」と
 * 言ったときに履歴の取り違えが起きる。しかも ids 14〜148 がアーカイブのものだと
 * 記録している場所がどこにも無いので、後から気付いて直すこともできない。
 * 露出窓は本番実行そのもの。
 *
 * **先に上げても安全な理由**: SQLite は `sqlite_sequence.seq` を下げない。
 * 153 に上げてから明示 id=5 を INSERT しても seq は 153 のままで、次の自動発番は 154 になる
 * （実測）。つまり「先に上げる」ことで失うものは無く、落ちたときだけ効く。
 */
import { importTask, type ImportTaskInput, type TaskDb } from "@todo-mcp/core";

import { raiseTaskSequence } from "./sequence";
import { verifyImported } from "./verify";

/**
 * 採番カウンタの操作だけが失敗した。汎用ハンドラと区別するために専用の型にしてある。
 *
 * `phase` で復旧手順が正反対になる:
 * - `"before"` — 行はまだ 1 件も書いていない。そのまま安全にやり直せる。
 * - `"after"` — **行は全件入っている**。DB を空にしてはいけない。
 */
export class SequenceRaiseError extends Error {
  constructor(
    readonly phase: "before" | "after",
    readonly inserted: number,
    readonly total: number,
    options?: { cause?: unknown },
  ) {
    super(
      phase === "before"
        ? `sqlite_sequence(tasks) を引き上げられなかった（INSERT の前なので 0/${total} 件・DB は変わっていない）`
        : `sqlite_sequence(tasks) の再確認に失敗した（${inserted}/${total} 件は投入済み）`,
      options,
    );
    this.name = "SequenceRaiseError";
  }
}

/** 投入した行と読み直した値が食い違った。行は書き込まれている。 */
export class ImportVerificationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `投入した行と DB の実際の値が食い違う（${problems.length} 件）:\n  ${problems.join("\n  ")}`,
    );
    this.name = "ImportVerificationError";
  }
}

export interface ExecuteImportParams {
  inputs: readonly ImportTaskInput[];
  /** `sqlite_sequence(tasks)` をここまで引き上げる。旧 DB の最大 id（done を含む）。 */
  sequenceTarget: number;
  /** 進捗の出力先。テストからは捨てる。 */
  log?: (line: string) => void;
}

export interface ExecuteImportResult {
  inserted: number;
  sequenceBefore: number | null;
  sequenceAfter: number;
  /** 全列一致を確認できた行数（= inputs.length のはず。違えば throw している）。 */
  verified: number;
}

export async function executeImport(
  db: TaskDb,
  params: ExecuteImportParams,
): Promise<ExecuteImportResult> {
  const log = params.log ?? ((): void => {});
  const total = params.inputs.length;

  // 1. 先にカウンタを安全域へ。ここで落ちれば 1 行も書いていない。
  let raised;
  try {
    raised = await raiseTaskSequence(db, params.sequenceTarget);
  } catch (error) {
    throw new SequenceRaiseError("before", 0, total, { cause: error });
  }
  log(
    `sqlite_sequence(tasks): ${raised.before ?? "(行なし)"} → ${raised.after}` +
      `${raised.changed ? "（INSERT より前に引き上げた）" : "（既に十分大きいので変更なし）"}`,
  );

  // 2. INSERT。トランザクションは張っていないので、落ちたら「入った分」が残る。
  //    何件入ったかを必ず出す —— 復旧は「入った id だけを消してやり直す」で、
  //    そのために件数が要る（README の復旧手順を参照）。
  let inserted = 0;
  try {
    for (const input of params.inputs) {
      await importTask(db, input);
      inserted += 1;
      if (inserted % 25 === 0) log(`  ${inserted}/${total} 件`);
    }
  } catch (error) {
    log(`INSERT に失敗（${inserted}/${total} 件を投入済み）`);
    throw error;
  }
  log(`  ${inserted}/${total} 件 — 完了`);

  // 3. 冪等な再アサート。1 が成功していれば書き込みは起きず、最終値を読むだけになる。
  let confirmed;
  try {
    confirmed = await raiseTaskSequence(db, params.sequenceTarget);
  } catch (error) {
    throw new SequenceRaiseError("after", inserted, total, { cause: error });
  }

  // 4. 値レベルの確認。件数の増分だけでは、全行の created_at が 1 年ずれていても通ってしまう。
  const verification = await verifyImported(db, params.inputs);
  if (verification.problems.length > 0) throw new ImportVerificationError(verification.problems);
  log(`読み直し: ${verification.matched}/${total} 件が全列一致`);

  return {
    inserted,
    sequenceBefore: raised.before,
    sequenceAfter: confirmed.after,
    verified: verification.matched,
  };
}
