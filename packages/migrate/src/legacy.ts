/**
 * 移行元（旧 Python CLI の `todos.db`）の読み出し。
 *
 * 開くときは必ず `readOnly: true`。旧 DB は「アーカイブとして凍結する」が地図の
 * 既決事項なので、書ける口を持たないことをコード側で担保する（実測: このフラグ付きの
 * ハンドルへの書き込みは `attempt to write a readonly database` で拒否される）。
 *
 * **ここに出てくる `tasks` は旧スキーマのテーブル**（id / title / category / status /
 * due / created_at / done_at / memo）で、Turso 側の新 `tasks` とは名前が同じだけの別物。
 * このファイルは `TaskDb` を一切受け取らず `node:sqlite` でローカルファイルを開くだけなので、
 * 新 DB に文を送る手段を構造的に持たない —— `packages/core/src/tasks.ts` 冒頭の
 * 「`TaskDb` に対する SQL は全部あそこにある」という不変条件の対象外。
 * 確認手順そのものは tasks.ts 側の doc コメントに書いてある。
 */
import { DatabaseSync } from "node:sqlite";

/** 旧 tasks の 1 行。列は旧スキーマそのまま（`.schema` で実測した順）。 */
export interface LegacyRow {
  id: number;
  title: string;
  category: string | null;
  status: string;
  due: string | null;
  created_at: string;
  done_at: string | null;
  memo: string | null;
}

export interface LegacySnapshot {
  /** 移行対象の行（id 昇順）。`onlyOpen` で done を除いたあとの集合。 */
  rows: LegacyRow[];
  /** 旧 DB の全行数（`onlyOpen` の有無に関わらず）。 */
  totalRows: number;
  /**
   * 旧 DB の最大 id。`onlyOpen` でも done を含めた全体から取る ——
   * 移行しなかった done の id を新規タスクが再利用しないように、
   * sqlite_sequence はここまで進める（チケット 10）。
   */
  maxId: number;
  /** 旧 DB 側の status 別件数（移行対象に絞る前の全体）。突き合わせ用。 */
  statusCounts: Record<string, number>;
}

/** 旧 DB で「生きている」の定義。旧 CLI に cancelled は無いので done 以外が生存。 */
const OPEN_FILTER = "status != 'done'";

export function readLegacy(path: string, options: { onlyOpen: boolean }): LegacySnapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, title, category, status, due, created_at, done_at, memo
           FROM tasks
          ${options.onlyOpen ? `WHERE ${OPEN_FILTER}` : ""}
          ORDER BY id`,
      )
      .all() as unknown as LegacyRow[];

    const totals = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS max_id FROM tasks").get() as
      | { n: number; max_id: number | null }
      | undefined;

    const statusRows = db
      .prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status ORDER BY status")
      .all() as unknown as { status: string; n: number }[];

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) statusCounts[row.status] = Number(row.n);

    return {
      rows,
      totalRows: Number(totals?.n ?? 0),
      maxId: Number(totals?.max_id ?? 0),
      statusCounts,
    };
  } finally {
    db.close();
  }
}
