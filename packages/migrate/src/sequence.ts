/**
 * AUTOINCREMENT の採番カウンタ（`sqlite_sequence`）の引き上げ。
 *
 * ここだけ生 SQL を書いている。tasks への SQL は全部 core にある（そして
 * user_id を持たない文が 1 つも無い）という不変条件を保つために、tasks 以外の
 * テーブルを触るこの操作を core に入れなかった —— `sqlite_sequence` は
 * ユーザーの行ではなく SQLite 内部の採番状態で、user_id で絞る対象が存在しない。
 * core に置くと「user_id 無しの文」が 1 本混ざり、grep で不変条件を確認できなくなる。
 *
 * 何のために要るか: 移行は旧 id を明示して INSERT する。SQLite は明示 id でも
 * カウンタを上げるが、`--only-open` で移行しなかった done の id（最大 153）が
 * カウンタに載らない場合、新規タスクがアーカイブ済みの番号を再利用しうる。
 * 会話 UI で「12 番終わった」と言える設計（03 §5）では、番号の重複は
 * 履歴の取り違えに直結する。
 *
 * **Turso がこの 2 文を受けるかは実測済み**（2026-08-08、todo-mcp-dev に対して
 * `@tursodatabase/serverless` 経由）。`sqlite_sequence` は SQLite の内部テーブルで、
 * 通常の INSERT / UPDATE は `SQLITE_DBCONFIG_DEFENSIVE` が off のときだけ許される。
 * dev では UPDATE（値を変える / 変えない）・DELETE・INSERT の 4 通りすべてが通った。
 * 呼び出し順（INSERT より前に引き上げる）の理由は execute.ts を参照。
 */
import type { TaskDb } from "@todo-mcp/core";

export interface SequenceResult {
  /** 実行前の値。行自体が無ければ null。 */
  before: number | null;
  after: number;
  changed: boolean;
}

/**
 * `tasks` のカウンタを `target` 以上にする。下げることはしない。
 *
 * 既存値のほうが大きいときに下げると、既に使われた id を再発番する DB を
 * 作ってしまう。移行の目的は「これ以降の新規が最大 id + 1 から始まる」ことなので、
 * 引き上げだけで足りる。
 */
export async function raiseTaskSequence(db: TaskDb, target: number): Promise<SequenceResult> {
  const before = await readTaskSequence(db);

  if (before === null) {
    // AUTOINCREMENT の行は最初の INSERT で作られる。1 行も入っていない DB を
    // 相手にしたときだけここに来る。
    await db.all("INSERT INTO sqlite_sequence (name, seq) VALUES ('tasks', ?)", [target]);
    return { before: null, after: target, changed: true };
  }
  if (before >= target) return { before, after: before, changed: false };

  await db.all("UPDATE sqlite_sequence SET seq = ? WHERE name = 'tasks'", [target]);
  return { before, after: target, changed: true };
}

/** 現在値を読むだけ（dry-run 用）。 */
export async function readTaskSequence(db: TaskDb): Promise<number | null> {
  const row = await db.get("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'");
  return row === undefined ? null : Number(row.seq);
}
