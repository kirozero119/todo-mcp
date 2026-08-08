/**
 * ツールが返す本文の組み立て。読み手は人間ではなくモデル。
 *
 * core に置かずここに置いてあるのは、この層が「AI に読ませる中間表現」だから。
 * 実会話の観察（wayfinder 07）では、モデルはこの行形式をそのまま人間に見せず、
 * Markdown テーブルに整形し直していた。人間向けの見せ方はモデルの仕事、という
 * 前提でサーバー側は情報密度を優先する。CLI（チケット 11）は同じ Task から
 * まったく別の整形を持つので、共有すると両方が歪む。
 */
import { weekdayIndex, type Status, type Task, type Workspace } from "@todo-mcp/core";

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

/** エコーする値の上限（エスケープ後の文字数）。超えた分は切って全長を添える。 */
const ECHO_MAX_CHARS = 80;

/** 1 文字を「行を壊さない・引用符を閉じ損なわない」表現に置き換える。 */
function escapeEchoChar(char: string): string {
  switch (char) {
    case "\\":
      return "\\\\";
    case '"':
      return '\\"';
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      break;
  }
  const code = char.codePointAt(0) ?? 0;
  // C0 制御文字 / DEL / Unicode の行区切り（U+2028, U+2029）。生のまま通すと
  // 表示側で改行になりうるので、見える形に落とす。
  if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
    return `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return char;
}

/**
 * エラー文に載せる外部由来の値（接続 URL のクエリ値・ツール引数）を無害化して引用符で包む。
 *
 * 3 部品の①「受け取った不正値のエコー」はモデルが原因を特定するための情報なので消さない。
 * ただし生値をそのままテンプレートリテラルへ差し込むと、値の中の改行が応答本文の行構造を
 * 割ってしまう。実測では `?workspace=life"%0A%0A<IMPORTANT>...` が 3 行のエラー文を 6 行に
 * 割り、注入文が独立した段落として応答に入り、閉じ引用符が 3 行下に流れた。長さも無制限で、
 * 5000 文字の値がそのまま 5123 文字の応答になった。
 *
 * そこで①のエコーは必ずこの関数を通す:
 * - 制御文字・改行・行区切りをエスケープ表記にして、値が 1 行を超えられないようにする
 * - `"` と `\` もエスケープして、引用符の閉じ位置を値の中身から動かせないようにする
 * - エスケープ後 80 文字で切り、元の文字数を添える（何が来たかは分かり、長さは有界）
 *
 * これは「エラー文フォーマット規約」側の対策なので、値をエコーするエラーは全部ここを通す。
 * 個々のエラー関数側で生値を埋め込むと、次に足すエラーで同じ穴が開く。
 */
export function echoValue(value: string): string {
  const chars = Array.from(value);
  let escaped = "";
  for (const char of chars) {
    const token = escapeEchoChar(char);
    // 切るのはエスケープ単位。1 文字分の表記の途中では切らない。
    if (escaped.length + token.length > ECHO_MAX_CHARS) {
      return `"${escaped}…"（全 ${chars.length} 文字）`;
    }
    escaped += token;
  }
  return `"${escaped}"`;
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

/**
 * workspace が未解決のときの 3 部品のうち、①（不正値のエコー）と②（期待する形式）。
 *
 * `invalidQueryValue` は接続 URL に `?workspace=` は付いていたが不正だった
 * 場合の生値。指定があれば「未指定」ではなく実際に来た不正値をエコーする
 * （3 部品の①）。マシン設定のタイプミス（例: `?workspace=lif`）を、
 * 「そもそも指定していない」場合と区別して特定できるようにするため。
 * 生値は必ず `echoValue()` を通す（理由はその doc コメント）。
 *
 * ツール（`workspaceMissingError`）とリソース（`workspaceMissingText`）で共有するのは
 * ここまで。③（回復手順）は経路ごとに実行できる操作が違うので共有しない。
 */
function workspaceProblemLines(invalidQueryValue: string | undefined): string[] {
  return [
    invalidQueryValue === undefined
      ? "不正な値: workspace=(未指定)"
      : `不正な値: workspace=${echoValue(invalidQueryValue)}`,
    '期待する値: "work" または "life"',
  ];
}

/**
 * ツール経路（get_agenda / upsert_task / search_tasks）で workspace が未解決のときの本文。
 *
 * ③はツール引数 `workspace` を明示して呼び直す手順。この 3 ツールはどれも
 * `workspace` 引数を持つので、モデルはこの手順をその場で実行できる。
 *
 * 引数は optional にしない。省略できると、4 つ目の呼び出しを足すときに
 * `deps.invalidWorkspaceQuery` を渡し忘れてもコンパイルが通り、「不正値を
 * 受け取ったのに『未指定』と答える」という直前まであった挙動へ静かに戻る。
 */
export function workspaceMissingError(invalidQueryValue: string | undefined): ToolText {
  return errText([
    ...workspaceProblemLines(invalidQueryValue),
    invalidQueryValue === undefined
      ? "この接続には既定 workspace が設定されていません（接続 URL に ?workspace=work|life を付けると設定されます）。ツール引数 workspace を明示して呼び直してください。"
      : "接続 URL の ?workspace= の値が不正です。work または life に直すか、ツール引数 workspace を明示して呼び直してください。",
  ]);
}

/**
 * today-agenda リソース経路で workspace が未解決のときの本文（プレーンテキスト）。
 *
 * ①②はツール側と同じ（`workspaceProblemLines`）。③だけが違う ——
 * `resources/read` のこの Resource には workspace 引数が無いので、「ツール引数
 * workspace を明示して呼び直す」はこの経路では実行できない手順になる。
 * 実行できる手順は「接続 URL の `?workspace=` を直して繋ぎ直す」か
 * 「workspace を引数で渡せる get_agenda ツールを使う」の 2 つ。
 */
export function workspaceMissingText(invalidQueryValue: string | undefined): string {
  return [
    ...workspaceProblemLines(invalidQueryValue),
    invalidQueryValue === undefined
      ? "この接続には既定 workspace が設定されていません。接続 URL に ?workspace=work|life を付けて接続し直すか、workspace を引数で指定できる get_agenda ツールを使ってください（このリソースには workspace 引数がありません）。"
      : "接続 URL の ?workspace= の値を work または life に直して接続し直すか、workspace を引数で指定できる get_agenda ツールを使ってください（このリソースには workspace 引数がありません）。",
  ].join("\n");
}

/**
 * due の不正値。3 部品の ③ に「今日」を注入するのがこのエラーの本体。
 *
 * だから due は Zod スキーマではなくハンドラ内で検証している。スキーマ検証に
 * 落とすと SDK 自動生成の文言になり、今日の日付をアンカーとして渡せない。
 */
export function invalidDueError(value: string, today: string): ToolText {
  return errText([
    `不正な値: due=${echoValue(value)}`,
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

/**
 * complete_task の UPDATE が 0 行で、読み直したらそのタスクが done ではなかった
 * （core の `completeTask` が `outcome: "reopened"` を返した）。
 *
 * 「既に done です」と答えられないのはもちろん、「完了 ✔」とも答えられない
 * ——実際にはどちらも起きていない。応答本文と行の中身を一致させるための第 3 の文言。
 * `isError` で返すのは、この状況で正しい次の一手（呼び直し）をモデルに促すため。
 */
export function completeReopenedError(id: number, status: Status): ToolText {
  return errText([
    `#${id} は done になりませんでした（現在の status: ${echoValue(status)}）。`,
    "完了にしようとした直後に別の更新が入り、このタスクは open に戻っています。",
    "完了させたいなら complete_task を同じ id で呼び直してください（done 以外にしたいなら upsert_task で status を明示してください）。",
  ]);
}

/**
 * 空文字（`""`）を弾く 3 フィールドのエラー文は、なぜスキーマではなくここにあるか。
 *
 * `title` / `query` / `project` を `z.string().min(1)` にすると、検証位置がハンドラから
 * Zod スキーマへ移り、モデルに届く文言が SDK 自動生成の英語 1 行になる:
 * `Input validation error: Invalid arguments for tool upsert_task: title: Too small:
 * expected string to have >=1 characters`。これは 06 で確定した 3 部品
 * （①不正値のエコー ②期待する形式 ③アンカー・回復手順）のどれも満たさず、とくに
 * 「新規作成なら title 必須 / 既存を更新したいなら id を指定」という回復手順が消える。
 * due について既に下していた判断（「[09] due だけスキーマ検証にしない理由」）と同じ理由で、
 * この 3 フィールドもハンドラ側で検証し、ここで日本語 3 部品を組み立てる。
 *
 * 各エラーは「実際にその経路へ到達する条件」だけを説明する。到達しない条件を
 * 書くと、文言と経路が食い違ったまま誰も気付けない。
 */

/**
 * 新規作成（id 省略）なのに title が無い。`received` は実際に来た値
 * （`undefined` = 未指定 / `""` = 空文字）で、そのままエコーする。
 */
export function titleRequiredError(received: string | undefined): ToolText {
  return errText([
    `不正な値: title=${received === undefined ? "(未指定)" : echoValue(received)}`,
    "新規作成には title が必須です。",
    "既存タスクを更新したい場合は id を指定してください。",
  ]);
}

/**
 * 更新経路（id あり）で title に空文字が来た。
 *
 * ここでは id が既に渡っているので、`titleRequiredError` の③（「id を指定してください」）
 * は回復手順にならない。空にしたいのではなく「触りたくない」はずなので、省略に誘導する。
 */
export function emptyTitleError(): ToolText {
  return errText([
    '不正な値: title=""',
    "title は空にできません（一覧行が `#12 [todo] ` になり、タスクを識別できなくなります）。",
    "タイトルを変えないなら title を省略してください。変えるなら 1 文字以上を指定してください。",
  ]);
}

/** search_tasks の query に空文字が来た。空文字は「絞り込まない」の意味にはならない。 */
export function emptyQueryError(): ToolText {
  return errText([
    '不正な値: query=""',
    "query は 1 文字以上のキーワードで指定してください（title / memo の部分一致）。",
    "キーワードで絞らないなら query を省略してください（workspace 内の open タスクが返ります）。",
  ]);
}

/** search_tasks の project に空文字が来た。ラベル無しのタスクを引く指定にはならない。 */
export function emptyProjectError(): ToolText {
  return errText([
    '不正な値: project=""',
    "project はラベル名の完全一致で指定してください。",
    "ラベルで絞らないなら project を省略してください。既存ラベルは検索結果の各行に {ラベル} として出ます。",
  ]);
}

/** search_tasks が実際に検索した条件。0 件時のスコープ表示を実効条件に合わせるために使う。 */
export interface SearchScope {
  /** searchTasks() 内で status 指定は includeClosed より優先される（SQL 側の分岐と一致させる）。 */
  status: Status | undefined;
  includeClosed: boolean;
}

/**
 * search_tasks の結果本文。CAP を超えた分は件数だけ示して絞り込みに誘導する。
 *
 * 0 件時のスコープ表示は `scope`（実際に SQL が使った検索条件）から組み立てる。
 * `status` 指定時は SQL がそれを優先し `includeClosed` を無視するため、
 * `include_closed: true` にしても範囲は広がらない —— その場合は誘導文を出さない。
 * 同様に `includeClosed: true` は既に最大範囲なので、これ以上広げる案内は不要。
 * 誘導文が意味を持つのは「status 未指定 かつ includeClosed が false」のときだけ。
 */
export function buildSearchResult(
  workspace: Workspace,
  total: number,
  tasks: readonly Task[],
  scope: SearchScope,
): string {
  if (total === 0) {
    const scopeLabel = scope.status
      ? `、status: "${scope.status}" のみ`
      : scope.includeClosed
        ? "、closed 含む"
        : "、open のみ";
    const hint =
      !scope.status && !scope.includeClosed
        ? " done / cancelled も探すには include_closed: true。"
        : "";
    return `該当 0 件（workspace: ${workspace}${scopeLabel}）。${hint}`;
  }
  const lines = [`該当 ${total} 件（workspace: ${workspace}）`, ...tasks.map(fmtLine)];
  if (total > tasks.length) {
    lines.push(
      `_${total - tasks.length} 件は表示していない。query / status / project で絞り込んで再検索すること。_`,
    );
  }
  return lines.join("\n");
}
