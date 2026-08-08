/**
 * Todo ツール本体（wayfinder 07 で確定したツールセット v1）。
 *
 * ツール名・引数・description・レスポンス形は、プロトタイプを Claude Code から
 * 実際に叩いた観察の結果として決まっている。ここを書き換えるときは、
 * 07 の観察ログの「機能した設計」を壊していないか確認すること。
 *
 * 削除ツールは存在しない（チケット 03 の決定）。「やめる」は status=cancelled
 * で表現する ——「やらないと決めた」はドメインの結末であって行の抹消ではない。
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

import {
  completeTask,
  createTask,
  getTask,
  isCalendarDate,
  jstDateOffset,
  listOpenTaskIds,
  listOpenTasks,
  searchTasks,
  statusSchema,
  todayInJst,
  updateTask,
  workspaceSchema,
  type TaskDb,
  type Workspace,
} from "@todo-mcp/core";

import {
  AGENDA_HORIZON_DAYS,
  buildAgenda,
  buildSearchResult,
  errText,
  fmtDetail,
  fmtLine,
  fmtResultTail,
  invalidDueError,
  ok,
  taskNotFoundError,
  titleRequiredError,
  workspaceMissingError,
  type ToolText,
} from "./todo-format";
import type { Props } from "./types";

/** search_tasks が 1 回に返す上限。超えた分は件数だけ示して絞り込みに誘導する。 */
const SEARCH_LIMIT = 20;

export interface TodoToolDeps {
  /** Turso 接続を 1 本開く。Workers にはプールがないのでツール呼び出しごとに開く。 */
  openDb: () => TaskDb;
  /**
   * 接続 URL の `?workspace=work|life` で決まるマシン既定（チケット 04）。
   * ツール引数の workspace が来たら、そちらが常に勝つ。
   */
  defaultWorkspace: Workspace | undefined;
  /**
   * 接続 URL に `?workspace=` は付いていたが "work"/"life" のどちらでもなかった
   * 場合の生値。クエリ自体が無い場合は undefined（[09] 参照）。
   * workspaceMissingError() がこれを見て、エラー文を「未指定」と「不正値」で
   * 出し分ける。
   */
  invalidWorkspaceQuery: string | undefined;
  /** ログ 1 行に載せるリクエスト識別子（07 の反省: 呼び出しの帰属を追えるように）。 */
  requestId: string | undefined;
}

// ---------- 共通 description（06 で確定した文言） ----------

const WS_DESC =
  'このタスクが属するワークスペース。"work" = 職場の業務。"life" = 私事とそれ以外の活動（境界: 職場の PC の画面に映ってよいものだけが work）。会話の文脈からどちらの話か明らかな場合は必ず明示すること。省略した場合は接続ごとの既定値が使われる。';

const DUE_DESC =
  "期限日。YYYY-MM-DD 形式（例: 2026-08-09）。「明日」「来週金曜」などの相対表現は、今日の日付から計算して絶対日付にしてから渡すこと。";

const STATUS_DESC =
  "タスク状態。todo=未着手 / in_progress=進行中 / waiting=他者や外部要因の返答待ち / someday=いつかやる（agenda に出ない）/ done=完了 / cancelled=やめると決めた";

// ---------- 入力スキーマ ----------

const getAgendaInput = z.object({
  workspace: workspaceSchema.optional().describe(WS_DESC),
});

const getTaskInput = z.object({
  id: z.number().int().describe("タスク番号（例: 12）"),
});

const upsertTaskInput = z.object({
  id: z.number().int().optional().describe("更新対象のタスク番号（例: 12）。省略で新規作成"),
  // .min(1): 更新経路（id あり）は元々ここ以外で title を検証していなかった。
  // 空文字を通すと `upsert_task(id, title: "")` が空タイトル行を作れてしまい、
  // 一覧表示が `#12 [todo] ` になって可読性とモデルの参照性を壊す（[09] 参照）。
  title: z.string().min(1).optional().describe("タスクの内容（新規作成時は必須）"),
  workspace: workspaceSchema.optional().describe(WS_DESC),
  project: z
    .string()
    .nullable()
    .optional()
    .describe("プロジェクトラベル（自由テキスト。例: 'エンジニア学習'）。null で外す"),
  status: statusSchema.optional().describe(STATUS_DESC),
  due: z.string().nullable().optional().describe(`${DUE_DESC} null で期限を外す`),
  memo: z.string().nullable().optional().describe("補足メモ・背景・リンクなど。null で消す"),
});

const completeTaskInput = z.object({
  id: z.number().int().describe("完了にするタスク番号（例: 12）"),
});

const searchTasksInput = z.object({
  // .min(1): 空文字は `if (params.project)` / `if (params.query)`（core 側）で
  // 黙ってフィルタが外れ、絞ったつもりの全件が返ってしまう（[09] 参照）。
  query: z.string().min(1).optional().describe("title / memo の部分一致キーワード"),
  workspace: workspaceSchema.optional().describe(WS_DESC),
  status: statusSchema.optional().describe(STATUS_DESC),
  project: z.string().min(1).optional().describe("プロジェクトラベルの完全一致"),
  include_closed: z
    .boolean()
    .optional()
    .describe("done / cancelled も検索対象に含める（既定 false）"),
});

type GetAgendaArgs = z.infer<typeof getAgendaInput>;
type GetTaskArgs = z.infer<typeof getTaskInput>;
type UpsertTaskArgs = z.infer<typeof upsertTaskInput>;
type CompleteTaskArgs = z.infer<typeof completeTaskInput>;
type SearchTasksArgs = z.infer<typeof searchTasksInput>;

// ---------- 認証コンテキスト ----------

/**
 * 現在のリクエストの user_id（`github:<数値id>`）。
 *
 * user_id をツール引数から受け取る経路は作らない。引数にすると、モデルが
 * 別の値を渡した瞬間に他人のタスクへ到達できてしまう。出どころは
 * OAuth の grant に封じた props ただ 1 つ。
 */
function currentUserId(): string | undefined {
  const props = getMcpAuthContext()?.props as Partial<Props> | undefined;
  return props?.user_id;
}

/**
 * 認証済み user_id を解決してからハンドラを呼ぶ包み。
 *
 * 全ツールをこれで包むことで「user_id を渡し忘れたハンドラ」が書けなくなる
 * ——ハンドラの第 1 引数が userId なので、省略すると型が合わない。
 */
function withUser<A>(
  handler: (userId: string, args: A) => Promise<ToolText>,
): (args: A) => Promise<ToolText> {
  return async (args: A) => {
    const userId = currentUserId();
    // 到達不能パス（OAuthProvider が未認証リクエストを先に弾く）。それでも
    // 偽の身元で動かさず、props 配線のリグレッションが見えるようにする。
    if (!userId) return errText(["この接続に認証済みアイデンティティがありません。"]);
    return handler(userId, args);
  };
}

// ---------- 本体 ----------

export function registerTodoTools(server: McpServer, deps: TodoToolDeps): void {
  const resolveWorkspace = (argument: Workspace | undefined): Workspace | undefined =>
    argument ?? deps.defaultWorkspace;

  /** タスクの中身（title / memo）はログに出さない。個人のタスクが Workers のログに残る。 */
  const log = (event: Record<string, unknown>): void => {
    console.log(`[todo] ${JSON.stringify({ req: deps.requestId ?? null, ...event })}`);
  };

  server.registerTool(
    "get_agenda",
    {
      title: "今日のアジェンダ",
      description:
        "今日の行動対象を返す。期限切れ・今日が期限・7日以内に期限・進行中・待ちの open タスクをまとめて一覧する。「今日何やる？」「タスク状況は？」と聞かれたら最初に呼ぶツール。someday と期限なしの todo は含まれない（それらは search_tasks で見る）。",
      inputSchema: getAgendaInput,
      annotations: { readOnlyHint: true },
    },
    withUser(async (userId, args: GetAgendaArgs) => {
      const workspace = resolveWorkspace(args.workspace);
      log({ tool: "get_agenda", ws: workspace ?? null });
      if (!workspace) return workspaceMissingError(deps.invalidWorkspaceQuery);

      const tasks = await listOpenTasks(deps.openDb(), { userId, workspace });
      return ok(
        buildAgenda(workspace, tasks, todayInJst(), jstDateOffset(AGENDA_HORIZON_DAYS)),
      );
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "タスク詳細",
      description:
        "タスク 1 件の全詳細（memo 含む）を返す。一覧（get_agenda / search_tasks）には memo の中身が出ない（+memo マーカーのみ）ので、タスクのメモ・背景・経緯を読みたいときはこのツールを使う。",
      inputSchema: getTaskInput,
      annotations: { readOnlyHint: true },
    },
    withUser(async (userId, args: GetTaskArgs) => {
      const db = deps.openDb();
      const task = await getTask(db, { userId, id: args.id });
      log({ tool: "get_task", id: args.id, found: task !== null });
      if (!task) return taskNotFoundError(args.id, await listOpenTaskIds(db, { userId }), true);
      return ok(fmtDetail(task));
    }),
  );

  server.registerTool(
    "upsert_task",
    {
      title: "タスク作成・更新",
      description:
        'タスクを 1 件作成または更新する。id を省略すると新規作成（title 必須）、id を渡すと既存タスクの部分更新（渡したフィールドだけ変わる）。やめると決めたタスクは status を "cancelled" にする（タスクを削除するツールは存在しない）。project は自由ラベル — 新しいラベルを作る前に search_tasks で既存ラベルを確認し、同じ意味のものがあれば同じ表記を再利用すること。',
      inputSchema: upsertTaskInput,
    },
    withUser(async (userId, args: UpsertTaskArgs) => {
      const db = deps.openDb();

      // due だけスキーマではなくここで検証する。理由は todo-format.ts の
      // invalidDueError を参照（エラー文に「今日」を注入するため）。
      if (args.due != null && !isCalendarDate(args.due)) {
        return invalidDueError(args.due, todayInJst());
      }

      if (args.id !== undefined) {
        const result = await updateTask(db, {
          userId,
          id: args.id,
          title: args.title,
          workspace: args.workspace,
          project: args.project,
          status: args.status,
          due: args.due,
          memo: args.memo,
        });
        log({ tool: "upsert_task", mode: "update", id: args.id, changed: result?.changed ?? null });
        if (!result) {
          // workspace は「移動先として設定したい値」であってアンカーを絞る
          // レンズではない。get_task / complete_task と同じく、id を打ち間違えた
          // ときの「実在する id」一覧は全 workspace から出す（[09] 参照）。
          const openIds = await listOpenTaskIds(db, { userId });
          return taskNotFoundError(args.id, openIds, true);
        }
        const changed = result.changed.length > 0 ? result.changed.join(", ") : "なし";
        return ok(`更新 #${result.task.id}（変更: ${changed}）\n${fmtResultTail(result.task)}`);
      }

      if (!args.title) {
        log({ tool: "upsert_task", mode: "create", error: "title_missing" });
        return titleRequiredError();
      }
      const workspace = resolveWorkspace(args.workspace);
      if (!workspace) {
        log({ tool: "upsert_task", mode: "create", error: "workspace_missing" });
        return workspaceMissingError(deps.invalidWorkspaceQuery);
      }

      const created = await createTask(db, {
        userId,
        workspace,
        title: args.title,
        status: args.status,
        project: args.project,
        due: args.due,
        memo: args.memo,
      });
      log({ tool: "upsert_task", mode: "create", id: created.id, ws: workspace });
      return ok(`作成 #${created.id}\n${fmtResultTail(created)}`);
    }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "タスク完了",
      description:
        "タスクを完了（done）にする。完了の報告を受けたらこのツールを使う（upsert_task で status を変えるよりこちらを優先）。",
      inputSchema: completeTaskInput,
    },
    withUser(async (userId, args: CompleteTaskArgs) => {
      const db = deps.openDb();
      const result = await completeTask(db, { userId, id: args.id });
      log({
        tool: "complete_task",
        id: args.id,
        outcome: result ? (result.alreadyDone ? "already_done" : "done") : "not_found",
      });
      if (!result) return taskNotFoundError(args.id, await listOpenTaskIds(db, { userId }), false);
      if (result.alreadyDone) {
        return ok(
          `#${result.task.id} は既に done です（closed_at: ${result.task.closed_at}）。変更なし。`,
        );
      }
      return ok(`完了 ✔\n${fmtLine(result.task)} — workspace: ${result.task.workspace}`);
    }),
  );

  server.registerTool(
    "search_tasks",
    {
      title: "タスク検索",
      description:
        "タスクを検索・絞り込み一覧する。query は title と memo の部分一致。既定では open（todo / in_progress / waiting / someday）のみが対象で、done / cancelled も含めるには include_closed を true にする。",
      inputSchema: searchTasksInput,
      annotations: { readOnlyHint: true },
    },
    withUser(async (userId, args: SearchTasksArgs) => {
      const workspace = resolveWorkspace(args.workspace);
      log({ tool: "search_tasks", ws: workspace ?? null, closed: args.include_closed ?? false });
      if (!workspace) return workspaceMissingError(deps.invalidWorkspaceQuery);

      const { total, tasks } = await searchTasks(deps.openDb(), {
        userId,
        workspace,
        query: args.query,
        status: args.status,
        project: args.project,
        includeClosed: args.include_closed,
        limit: SEARCH_LIMIT,
      });
      return ok(
        buildSearchResult(workspace, total, tasks, {
          status: args.status,
          includeClosed: args.include_closed ?? false,
        }),
      );
    }),
  );

  // 学習枠として維持している Resource（チケット 04 の決定）。実会話では 0 回
  // 読まれなかった —— Claude Code では resource は人間が @ で添付する UI であって、
  // エージェントが自発的に読むものではない、という実測が 07 で取れている。
  server.registerResource(
    "today-agenda",
    "todo://today",
    {
      title: "今日のアジェンダ（読み取り専用ビュー）",
      description: "get_agenda と同じ内容の読み取り専用リソース。接続既定の workspace を使う。",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const userId = currentUserId();
      log({ resource: "todo://today", ws: deps.defaultWorkspace ?? null });

      let text: string;
      if (!userId) {
        text = "この接続に認証済みアイデンティティがありません。";
      } else if (!deps.defaultWorkspace) {
        text =
          "既定 workspace が未設定のため表示できません（接続 URL に ?workspace=work|life を付けてください）。";
      } else {
        const tasks = await listOpenTasks(deps.openDb(), {
          userId,
          workspace: deps.defaultWorkspace,
        });
        text = buildAgenda(
          deps.defaultWorkspace,
          tasks,
          todayInJst(),
          jstDateOffset(AGENDA_HORIZON_DAYS),
        );
      }
      return { contents: [{ uri: uri.href, text }] };
    },
  );

  // 学習枠として維持している Prompt。観察では本文の指示（agenda + someday 検索 →
  // ①②③の順で対話）をモデルがそのまま忠実に実行した。
  server.registerPrompt(
    "todo-review",
    {
      title: "タスク棚卸しレビュー",
      description:
        "open タスク全体を見渡して、今日やるもの・期限切れの処遇・someday の棚卸しを対話で進める",
    },
    () => {
      log({ prompt: "todo-review" });
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "今のタスク状況をレビューしたい。get_agenda と search_tasks（status=someday も）で全体を把握してから、①今日やるべきもの ②期限切れタスクの処遇（やる/リスケ/cancelled）③someday の棚卸し、の順に 1 件ずつ対話で確認して。",
            },
          },
        ],
      };
    },
  );
}
