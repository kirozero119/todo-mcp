/**
 * 時刻まわり。「今日」の境界がここにあるのが重要な点。
 *
 * 期限切れかどうかは JST の日付で決まる（松本さんの 1 日の境界であって、
 * UTC の境界ではない）。この判定が MCP サーバーと CLI で 1 日ずれると、
 * 同じタスクが片方では期限切れ・片方ではまだ間に合う、という状態になる。
 * だから表示ではなくドメインとして core に置いている。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 保存用タイムスタンプ: ISO 8601 UTC の秒精度（例 `2026-08-08T05:14:22Z`）。
 *
 * ミリ秒を落とすのは、旧 todos.db から移行してくる行（チケット 10）が
 * 日付だけを持っていて `T00:00:00Z` で埋まるため。桁が揃っていれば
 * created_at の文字列比較がそのまま時刻順になる。
 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** JST での今日（YYYY-MM-DD）。 */
export function todayInJst(now: Date = new Date()): string {
  return jstDateOffset(0, now);
}

/** JST での今日から days 日後（負の値なら過去）の日付（YYYY-MM-DD）。 */
export function jstDateOffset(days: number, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * YYYY-MM-DD として実在する日付か。
 *
 * 形式チェックだけだと 2026-02-31 が通ってしまうので、Date に通した結果が
 * 同じ文字列に戻るかで実在性まで見る。エラー文の組み立ては呼び出し側の仕事
 * （MCP と CLI で読み手が違う）なので、ここは真偽値だけ返す。
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 日付文字列（YYYY-MM-DD）の曜日番号（0=日）。ラベル文字列は表示側で作る。 */
export function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
