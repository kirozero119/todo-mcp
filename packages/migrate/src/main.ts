/**
 * 旧 todos.db → Turso 移行スクリプトの I/O シェル（wayfinder チケット 10）。
 *
 *   npm run migrate --workspace @todo-mcp/migrate -- --target dev --dry-run --only-open
 *
 * このファイルがやるのは「実際の世界に触ること」だけ —— `process.argv` と
 * `process.env` を読み、旧 SQLite を開き、Turso に接続し、結果を標準出力に出す。
 * 判定と手順はテストできる隣のモジュールに置いてある:
 *
 * - `cli.ts`     引数と接続先のガード（純粋関数。誤って本番に書くのを止める仕組み）
 * - `legacy.ts`  旧 todos.db の読み出し（readOnly）
 * - `transform.ts` 旧 1 行 → 新 1 行の変換規則（純粋関数）
 * - `execute.ts` 書き込みの順番（カウンタ先行 → INSERT → 再アサート → 値の読み直し）
 *
 * **tasks への SQL はこのパッケージに 1 行も無い**。INSERT は core の `importTask()`、
 * 件数確認は `searchTasks()`、値の読み直しは `getTask()` を通す。生 SQL を書いているのは
 * `sqlite_sequence`（tasks ではない）だけで、理由は sequence.ts に書いた。
 */
import { createTaskDb, searchTasks, type TaskDb, type Workspace } from "@todo-mcp/core";

import { parseArgs, resolveTarget, UsageError, USAGE } from "./cli";
import {
  executeImport,
  ImportVerificationError,
  SequenceRaiseError,
  type ExecuteImportResult,
} from "./execute";
import { readLegacy } from "./legacy";
import { readTaskSequence } from "./sequence";
import { formatInput, MigrationDataError, transformRows } from "./transform";

/** この user_id・workspace の現在の行数。core のクエリ関数を通して読む。 */
async function countRows(db: TaskDb, userId: string, workspace: Workspace): Promise<number> {
  const { total } = await searchTasks(db, { userId, workspace, includeClosed: true, limit: 1 });
  return total;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connection = resolveTarget(options.target, process.env);

  const legacy = readLegacy(options.source, { onlyOpen: options.onlyOpen });
  const { inputs, notes } = transformRows(legacy.rows, {
    userId: options.userId,
    workspace: options.workspace,
  });

  const statusCounts: Record<string, number> = {};
  let withDue = 0;
  for (const input of inputs) {
    statusCounts[input.status] = (statusCounts[input.status] ?? 0) + 1;
    if (input.due !== null && input.due !== undefined) withDue += 1;
  }

  console.log("=== 移行計画 ===");
  console.log(
    `モード          : ${options.execute ? "EXECUTE（書き込む）" : "DRY-RUN（書かない）"}`,
  );
  console.log(`移行元          : ${options.source}（読み取り専用で開いた）`);
  console.log(`移行先          : ${options.target} / ${connection.host}`);
  console.log(`user_id         : ${options.userId}`);
  console.log(`workspace       : ${options.workspace}（全行同じ）`);
  console.log(`絞り込み        : --only-open（done を除く。全件移行は保留中）`);
  console.log(`旧 DB の全行数  : ${legacy.totalRows}`);
  console.log(`旧 DB の status : ${JSON.stringify(legacy.statusCounts)}`);
  console.log(`旧 DB の最大 id : ${legacy.maxId}`);
  console.log(`移行対象        : ${inputs.length} 件`);
  console.log(`  status 内訳   : ${JSON.stringify(statusCounts)}`);
  console.log(`  期限つき      : ${withDue} 件`);
  console.log(`正規化の発火    : ${notes.length} 件`);
  for (const note of notes) console.log(`  - #${note.id} [${note.kind}] ${note.detail}`);

  console.log("");
  console.log(`=== 投入される行（${inputs.length} 件・id 昇順） ===`);
  for (const input of inputs) console.log(formatInput(input));
  console.log("");

  const db = createTaskDb({ url: connection.url, authToken: connection.authToken });
  const existing = await countRows(db, options.userId, options.workspace);
  const sequence = await readTaskSequence(db);
  console.log("=== 移行先の現状 ===");
  console.log(`既存行（${options.userId} / ${options.workspace}）: ${existing} 件`);
  console.log(`sqlite_sequence(tasks): ${sequence ?? "(行なし)"}`);
  console.log("");

  if (!options.execute) {
    console.log("DRY-RUN のため書き込みは行っていない。");
    console.log(
      `--execute で実行すると、まず sqlite_sequence(tasks) を ${legacy.maxId} 以上へ引き上げ、` +
        `その後 ${inputs.length} 件を INSERT し、全行を読み直して全列一致を確認する。`,
    );
    return;
  }

  console.log("=== 実行 ===");
  let result: ExecuteImportResult;
  try {
    result = await executeImport(db, {
      inputs,
      sequenceTarget: legacy.maxId,
      log: (line) => console.log(line),
    });
  } catch (error) {
    // 失敗しても行数の実測を出してから投げ直す（復旧の起点になる）。
    const failed = await countRows(db, options.userId, options.workspace).catch(() => null);
    console.error(
      `失敗時点の行数（${options.userId} / ${options.workspace}）: ${existing} → ${failed ?? "(読めなかった)"}`,
    );
    throw error;
  }

  console.log("");
  console.log("=== 投入後の確認（core の searchTasks / getTask で読み直した） ===");
  const after = await countRows(db, options.userId, options.workspace);
  if (after - existing !== inputs.length) {
    throw new Error(
      `行数の増分が投入件数と一致しない（増分 ${after - existing} / 投入 ${inputs.length}）`,
    );
  }
  console.log(`件数: 増分が投入件数と一致した（${existing} → ${after}）。`);
  console.log(
    `値レベル: ${result.verified}/${inputs.length} 件が全 10 列一致` +
      `（id・workspace・project・title・status・due・memo・created_at・updated_at・closed_at を 1 件ずつ突き合わせた）。`,
  );
  console.log(
    `sqlite_sequence(tasks): ${result.sequenceBefore ?? "(行なし)"} → ${result.sequenceAfter}`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`引数エラー: ${error.message}`);
    console.error("");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (error instanceof MigrationDataError) {
    console.error(`移行元データが想定と違う: ${error.message}`);
    console.error("（1 行も書き込んでいない。変換は全行を作り終えてから投入する）");
    process.exitCode = 1;
    return;
  }
  if (error instanceof SequenceRaiseError) {
    console.error(`採番カウンタの操作に失敗: ${error.message}`);
    if (error.phase === "before") {
      console.error(
        "（引き上げは INSERT より前に行う設計なので、行は 1 件も入っていない。そのままやり直せる）",
      );
    } else {
      console.error(
        `【重要】行は全件（${error.inserted}/${error.total} 件）入っている。失敗したのは採番カウンタの操作のみ。`,
      );
      console.error(
        "**DB を空にしないこと** —— README の復旧手順（投入した id だけを消す）は、この状態には要らない。",
      );
      console.error(
        "やることは 1 つだけ: turso db shell <db> \"SELECT * FROM sqlite_sequence WHERE name='tasks'\" で値を見て、",
      );
      console.error("旧 DB の最大 id 以上でなければ UPDATE で引き上げる。");
    }
    process.exitCode = 1;
    return;
  }
  if (error instanceof ImportVerificationError) {
    console.error(`投入後の検証に失敗: ${error.message}`);
    console.error(
      "（行は書き込まれている。DB を空にする前に、上の列がなぜ食い違ったのかを確認すること）",
    );
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
