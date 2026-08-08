/**
 * ドメインの語彙。workspace / status の値集合と Task の形をここ 1 箇所で決める。
 *
 * DB 側（schema.sql）は TEXT のままで CHECK 制約を持たない。値を変えるたびに
 * テーブル再作成が要るのを避けるためで、代わりに「書き込みの入口を全部この
 * Zod enum に通す」という構造で正しさを担保する（チケット 03 の決定）。
 * 入口は MCP サーバーと CLI の 2 つだけで、どちらもこのパッケージを経由する。
 */
import { z } from "zod";

/** work = 職場の業務 / life = それ以外。「会社 PC の既定レンズに映ってよいか」が境界。 */
export const WORKSPACES = ["work", "life"] as const;
export const workspaceSchema = z.enum(WORKSPACES);
export type Workspace = (typeof WORKSPACES)[number];

export const STATUSES = [
  "todo",
  "in_progress",
  "waiting",
  "someday",
  "done",
  "cancelled",
] as const;
export const statusSchema = z.enum(STATUSES);
export type Status = (typeof STATUSES)[number];

/**
 * まだ結末が出ていない status。
 *
 * someday を open 側に入れているのは、「やらないと決めた」わけではないから。
 * agenda に出さないのは表示側の判断であって、状態としては生きている。
 */
export const OPEN_STATUSES = ["todo", "in_progress", "waiting", "someday"] as const;

/** done / cancelled = 終端。どちらも closed_at を持つ（チケット 03 で done_at を一般化した）。 */
export function isClosedStatus(status: Status): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * tasks 1 行。
 *
 * user_id を含めないのは、クエリ関数がすべて呼び出し元の user_id で絞った後の
 * 行しか返さないため。行ごとに持たせても常に同じ値で、情報量がゼロの列を
 * 表示層まで引き回すことになる（漏らす経路を増やすだけ）。
 */
export interface Task {
  id: number;
  workspace: Workspace;
  project: string | null;
  title: string;
  status: Status;
  /** YYYY-MM-DD。締切は瞬間ではなく日なので、他のタイムスタンプと形が違う。 */
  due: string | null;
  memo: string | null;
  /** ISO 8601 UTC（秒精度）。 */
  created_at: string;
  updated_at: string;
  /** done / cancelled になった時刻。open の間は null。 */
  closed_at: string | null;
}

/** Task のうち upsert で書き換えうる列。変更差分の表示に使う。 */
export type TaskField = "title" | "workspace" | "project" | "status" | "due" | "memo";

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * SELECT の行を Task にする。
 *
 * ここで Zod による検証をあえてしない。DB に CHECK 制約がない以上、手で書き換えた
 * 行などで status が未知の値になる余地は残るが、その 1 行のために一覧全体を
 * 例外で落とすのは代償が大きすぎる。検証は「書き込みの入口」に置く、が 03 の設計。
 */
export function taskFromRow(row: Record<string, unknown>): Task {
  return {
    id: Number(row.id),
    workspace: String(row.workspace) as Workspace,
    project: textOrNull(row.project),
    title: String(row.title),
    status: String(row.status) as Status,
    due: textOrNull(row.due),
    memo: textOrNull(row.memo),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    closed_at: textOrNull(row.closed_at),
  };
}
