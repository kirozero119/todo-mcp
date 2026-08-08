/**
 * ツールが返す本文の組み立て。読み手は人間ではなくモデル。
 *
 * core に置かずここに置いてあるのは、この層が「AI に読ませる中間表現」だから。
 * 実会話の観察（wayfinder 07）では、モデルはこの行形式をそのまま人間に見せず、
 * Markdown テーブルに整形し直していた。人間向けの見せ方はモデルの仕事、という
 * 前提でサーバー側は情報密度を優先する。CLI（チケット 11）は同じ Task から
 * まったく別の整形を持つので、共有すると両方が歪む。
 */
import { weekdayIndex, type Task, type Workspace } from "@todo-mcp/core";

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

/**
 * ツール応答の形。SDK の CallToolResult のうち、このサーバーが使う部分だけ。
 *
 * interface ではなく type にしてあるのは TypeScript の仕様のため。SDK 側の
 * 戻り値型は `[x: string]: unknown` のインデックスシグネチャを持つが、
 * interface には暗黙のインデックスシグネチャが与えられず代入できない
 * （type エイリアスには与えられる）。
 */
export type ToolText = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

export function ok(text: string): ToolText {
  return { content: [{ type: "text", text }] };
}

/**
 * エラー応答。isError で返すのは、モデルに自己修正の機会を与えるため
 * （JSON-RPC error にすると会話の外側の失敗になり、モデルは直せない）。
 *
 * 中身は 06 で確定した 3 部品: ①受け取った不正値のエコー ②期待する形式
 * ③モデルが機械的に計算できるアンカー。③ がないと「正しい値」を推測で
 * 埋めることになり、同じ間違いを繰り返す。
 */
export function errText(lines: string[]): ToolText {
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

/** `2026-08-08 (土)`。日付だけだと曜日の相対表現（「金曜まで」）を解けない。 */
export function dateLabel(date: string): string {
  return `${date} (${WEEKDAYS_JA[weekdayIndex(date)]})`;
}

/**
 * 一覧 1 行 `#id [status] title (due YYYY-MM-DD) {project} +memo`。
 *
 * memo は中身を出さず存在マーカーだけにする。全文を載せると一覧が長くなり、
 * かつ「読むべき memo がある」という合図が埋もれる。観察では、このマーカーを
 * 見たモデルが自発的に get_task を呼んで memo を読みに行った。
 */
export function fmtLine(task: Task): string {
  let line = `#${task.id} [${task.status}] ${task.title}`;
  if (task.due) line += ` (due ${task.due})`;
  if (task.project) line += ` {${task.project}}`;
  if (task.memo) line += " +memo";
  return line;
}

/** get_task の詳細ビュー。created/updated は「塩漬け」判定の材料として出す。 */
export function fmtDetail(task: Task): string {
  const lines = [fmtLine(task), `workspace: ${task.workspace}`];
  if (task.memo) lines.push(`memo: ${task.memo}`);
  if (task.closed_at) lines.push(`closed_at: ${task.closed_at}`);
  lines.push(`created: ${task.created_at} / updated: ${task.updated_at}`);
  return lines.join("\n");
}

/** upsert / complete の応答末尾。1 行 + workspace + memo（あれば）。 */
export function fmtResultTail(task: Task): string {
  return `${fmtLine(task)} — workspace: ${task.workspace}${task.memo ? `\nmemo: ${task.memo}` : ""}`;
}

/** agenda に載せる期限の地平（今日から何日先まで）。 */
export const AGENDA_HORIZON_DAYS = 7;

/**
 * agenda 本文。tool と resource で共用する。
 *
 * someday と「期限なし todo」を出さないのが設計の要。今日の行動対象だけを
 * 見せ、残りは件数と回復経路（search_tasks）だけ示す。観察では、この
 * フッターをモデルが人間に転送し、次の依頼で search_tasks に正しく繋いだ。
 */
export function buildAgenda(
  workspace: Workspace,
  openTasks: readonly Task[],
  today: string,
  horizon: string,
): string {
  const dated = (task: Task): boolean => task.status !== "someday";
  const overdue = openTasks.filter((task) => dated(task) && task.due !== null && task.due < today);
  const dueToday = openTasks.filter((task) => dated(task) && task.due === today);
  const upcoming = openTasks.filter(
    (task) => dated(task) && task.due !== null && task.due > today && task.due <= horizon,
  );
  const inProgress = openTasks.filter((task) => task.status === "in_progress" && !task.due);
  const waiting = openTasks.filter((task) => task.status === "waiting" && !task.due);

  const shown = new Set([...overdue, ...dueToday, ...upcoming, ...inProgress, ...waiting]);
  const rest = openTasks.filter((task) => !shown.has(task));

  const section = (label: string, tasks: readonly Task[]): string[] =>
    tasks.length === 0 ? [] : [`## ${label} (${tasks.length})`, ...tasks.map(fmtLine), ""];

  const lines = [
    `# Agenda — workspace: ${workspace}（今日: ${dateLabel(today)}）`,
    "",
    ...section("期限切れ", overdue),
    ...section("今日が期限", dueToday),
    ...section(`${AGENDA_HORIZON_DAYS}日以内`, upcoming),
    ...section("進行中（期限なし）", inProgress),
    ...section("待ち（期限なし）", waiting),
  ];

  if (shown.size === 0) lines.push("今日の行動対象はありません。");

  if (rest.length > 0) {
    const someday = rest.filter((task) => task.status === "someday").length;
    lines.push(
      `_他に open ${rest.length} 件（someday ${someday} 件・期限なし or ${AGENDA_HORIZON_DAYS}日より先 ${rest.length - someday} 件）は含まれていない。見るには search_tasks。_`,
    );
  }
  return lines.join("\n");
}

/** id を間違えたときに載せる「実在する id」。多すぎるときは頭を出して件数で示す。 */
export function openIdsAnchor(ids: readonly number[]): string {
  if (ids.length === 0) return "(なし)";
  const CAP = 20;
  const shown = ids
    .slice(0, CAP)
    .map((id) => `#${id}`)
    .join(", ");
  return ids.length > CAP ? `${shown} …他${ids.length - CAP}件` : shown;
}

export function workspaceMissingError(): ToolText {
  return errText([
    "不正な値: workspace=(未指定)",
    '期待する値: "work" または "life"',
    "この接続には既定 workspace が設定されていません（接続 URL に ?workspace=work|life を付けると設定されます）。ツール引数 workspace を明示して呼び直してください。",
  ]);
}

/**
 * due の不正値。3 部品の ③ に「今日」を注入するのがこのエラーの本体。
 *
 * だから due は Zod スキーマではなくハンドラ内で検証している。スキーマ検証に
 * 落とすと SDK 自動生成の文言になり、今日の日付をアンカーとして渡せない。
 */
export function invalidDueError(value: string, today: string): ToolText {
  return errText([
    `不正な値: due="${value}"`,
    "期待する形式: YYYY-MM-DD（例: 2026-08-09）",
    `今日は ${dateLabel(today)} です。相対表現はこの日付を起点に絶対日付へ計算してから指定し直してください。`,
  ]);
}

/**
 * id 不在。open な id の一覧をアンカーとして返す。
 *
 * `withClosedHint` は「閉じたタスクの探し方」まで案内するかどうか。
 * complete_task だけ案内しないのは、そこで探している対象が定義上 open だから。
 */
export function taskNotFoundError(
  id: number,
  openIds: readonly number[],
  withClosedHint: boolean,
): ToolText {
  const anchor = `存在する open タスク: ${openIdsAnchor(openIds)}`;
  return errText([
    `不正な値: id=${id}`,
    "該当するタスクが存在しません。",
    withClosedHint
      ? `${anchor}。閉じたタスクも含めて探すには search_tasks を include_closed: true で。`
      : anchor,
  ]);
}

export function titleRequiredError(): ToolText {
  return errText([
    "不正な値: title=(未指定)",
    "新規作成には title が必須です。",
    "既存タスクを更新したい場合は id を指定してください。",
  ]);
}

/** search_tasks の結果本文。CAP を超えた分は件数だけ示して絞り込みに誘導する。 */
export function buildSearchResult(
  workspace: Workspace,
  total: number,
  tasks: readonly Task[],
  includeClosed: boolean,
): string {
  if (total === 0) {
    const scope = includeClosed ? "、closed 含む" : "、open のみ";
    const hint = includeClosed ? "" : " done / cancelled も探すには include_closed: true。";
    return `該当 0 件（workspace: ${workspace}${scope}）。${hint}`;
  }
  const lines = [`該当 ${total} 件（workspace: ${workspace}）`, ...tasks.map(fmtLine)];
  if (total > tasks.length) {
    lines.push(
      `_${total - tasks.length} 件は表示していない。query / status / project で絞り込んで再検索すること。_`,
    );
  }
  return lines.join("\n");
}
