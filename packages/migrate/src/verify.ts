/**
 * 「書いたはずの値」と「実際に DB にある値」の突き合わせ。
 *
 * 投入後の確認が総件数の増分しか見ていなかったので、`created_at` が全行 1 年
 * ずれていても行数さえ合えば成功終了していた。チケット 10 の完了条件は
 * 「件数一致・status 別件数一致・期限付きタスクの欠落なし」で、増分だけでは満たせない。
 *
 * **この検証が答えられる問いと、答えられない問い**を分けておくこと。
 *
 * - 答えられる: **スクリプトが書こうとした値どおりに DB に入ったか**。
 *   `ImportTaskInput` は手元にあるので、読み直した行と全列で突き合わせられる。
 *   列が 1 つでも食い違えば id と列名を挙げて止まる。
 * - 答えられない: **旧 DB と一致するか**。`transformRow()` が値を取り違えていれば、
 *   その間違った値が「書いたはずの値」になるので、ここは一致してしまう。
 *   変換ロジックの正しさは `test/transform.test.ts` の管轄で、両方が揃って
 *   初めて「旧 DB → Turso」の経路全体が担保される。
 *
 * 読み直しは core の `getTask()` を使う（このパッケージに tasks への SQL を書かない）。
 * `getTask()` は user_id で絞るので、**間違った user_id で書かれた行は「見つからない」**
 * として検出される —— user_id 列も実質ここで確認できている。
 */
import { getTask, type ImportTaskInput, type Task, type TaskDb } from "@todo-mcp/core";

/**
 * `importTask()` が実際に書く値。core の `nullIfEmpty()` と同じ正規化を写している。
 *
 * ここが core とずれると、正しい書き込みを「食い違い」と誤検出する。core 側の
 * 正規化を変えるなら、この関数も一緒に変えること（`packages/core/src/tasks.ts` の
 * `nullIfEmpty()` / `importTask()`）。
 */
function asStored(value: string | null | undefined): string | null {
  return value === "" || value === undefined ? null : value;
}

/**
 * 1 行分の食い違いを列名つきで並べる。空配列なら全列一致。
 *
 * 見つからなかった場合を最初に返し切るのは、そこから先の列比較が全部
 * 「null と食い違う」で埋まって読めなくなるため。
 */
export function diffImportedTask(expected: ImportTaskInput, actual: Task | null): string[] {
  if (actual === null) {
    return [
      `#${expected.id}: 読み直しても行が無い（user_id=${expected.userId} で検索）。` +
        `user_id が違う値で書かれた場合もここに出る`,
    ];
  }

  const problems: string[] = [];
  const check = (column: string, want: unknown, got: unknown): void => {
    if (want === got) return;
    problems.push(
      `#${expected.id} ${column}: 書いたはず=${JSON.stringify(want)} / DB の実際=${JSON.stringify(got)}`,
    );
  };

  check("id", expected.id, actual.id);
  check("workspace", expected.workspace, actual.workspace);
  check("project", asStored(expected.project), actual.project);
  check("title", expected.title, actual.title);
  check("status", expected.status, actual.status);
  check("due", asStored(expected.due), actual.due);
  check("memo", asStored(expected.memo), actual.memo);
  check("created_at", expected.createdAt, actual.created_at);
  check("updated_at", expected.updatedAt, actual.updated_at);
  check("closed_at", asStored(expected.closedAt), actual.closed_at);
  return problems;
}

export interface VerifyResult {
  /** 全列一致した行数。 */
  matched: number;
  /** 食い違いの説明（id と列名つき）。空なら全行一致。 */
  problems: string[];
}

/** 投入した全行を 1 件ずつ読み直して突き合わせる。往復は 1 行 1 回（本番スコープは 8 行）。 */
export async function verifyImported(
  db: TaskDb,
  inputs: readonly ImportTaskInput[],
): Promise<VerifyResult> {
  const problems: string[] = [];
  let matched = 0;
  for (const input of inputs) {
    const actual = await getTask(db, { userId: input.userId, id: input.id });
    const rowProblems = diffImportedTask(input, actual);
    if (rowProblems.length === 0) matched += 1;
    else problems.push(...rowProblems);
  }
  return { matched, problems };
}
