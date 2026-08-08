/**
 * MCP サーバー本体（Resource Server 側）。
 *
 * SDK v2 の `McpServer` ファクトリを `agents/mcp/server` の
 * `createMcpHandler` に渡す。ステートレス（Durable Objects なし）。`legacy`
 * オプションは既定の `'stateless'` のままにし、2025年当時のハンドシェイクも
 * 動くようにしている（今の Claude Code もその方式で接続する）。
 *
 * 有効なトークンを持つリクエストにしか到達しない: OAuthProvider がベアラー
 * トークンを検証し、grant の props を `ctx.props` に復号してからこのハンドラを
 * 呼ぶ。`getMcpAuthContext()` はそれを AsyncLocalStorage 経由で読む。
 */
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { createTaskDb, type TaskDb, type Workspace } from "@todo-mcp/core";
import { z } from "zod";

import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME, SERVER_VERSION } from "./config";
import { registerTodoTools } from "./todo-tools";
import { tursoConfigFromEnv } from "./turso";
import type { Env, Props } from "./types";

/** 現在処理中のリクエストの認証済みアイデンティティを読む。 */
function currentProps(): Partial<Props> {
  return (getMcpAuthContext()?.props ?? {}) as Partial<Props>;
}

export interface TodoServerDeps {
  /** Turso 接続を 1 本開く。未設定なら投げる（詳細は tursoOpener）。 */
  openDb: () => TaskDb;
}

/**
 * マシンごとの既定 workspace は接続 URL の `?workspace=work|life`（チケット 04）。
 *
 * 会社 PC は `?workspace=work`、私物 Mac は `?workspace=life` で接続する。
 * 07 の実会話ではモデルが毎回 workspace を明示したため、この既定値が実際に
 * 使われた回数は 0 —— それでも残すのは、明示し忘れたときに life が会社 PC の
 * 画面に出ないための保険だから。
 */
function resolveDefaultWorkspace(request: Request | undefined): Workspace | undefined {
  if (!request) return undefined;
  const value = new URL(request.url).searchParams.get("workspace");
  return value === "work" || value === "life" ? value : undefined;
}

/**
 * ログ行に付けるリクエスト識別子。
 *
 * 07 の観察では、どの呼び出しがどのセッション由来か分からず 3 件を帰属不能な
 * まま記録に残す羽目になった。その反省で、リクエストヘッダ由来の識別子を
 * ツールログに載せる。`mcp-session-id` は 2025 系ハンドシェイクのセッション、
 * `cf-ray` は Cloudflare のリクエスト単位。
 */
function resolveRequestId(request: Request | undefined): string | undefined {
  return request?.headers.get("mcp-session-id") ?? request?.headers.get("cf-ray") ?? undefined;
}

/**
 * テストが明示的な認証コンテキストでマウントできるように export。
 *
 * deps を引数に取る形（ファクトリを返すファクトリ）にしているのは、
 * `agents/mcp/server` の stateless ハンドラが `env` をファクトリに渡さないため
 * （実装は `callable = (request, _env, ctx) => serve(request, undefined, ctx)`）。
 * env をモジュール変数に退避する手もあるが、リクエスト間で共有される可変状態を
 * 増やすことになるので、依存はクロージャで閉じて渡す。
 */
export const createTodoMcpServer =
  (deps: TodoServerDeps) =>
  (ctx: { requestInfo?: Request }): McpServer => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        instructions:
          "個人タスク管理サーバー。タスクの状況を把握するときは、まず get_agenda を呼ぶ。",
      },
    );

    server.registerTool(
      "whoami",
      {
        title: "サインイン中のユーザー",
        description:
          "この接続が認証されている GitHub アイデンティティを返します。サーバーが想定通りのユーザーとして認識しているかを確認するために使用してください。",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async () => {
        const { login, user_id } = currentProps();
        if (!login || !user_id) {
          // 到達不能パス（OAuthProvider が未認証リクエストを先に拒否するため）。
          // props 配線の将来リグレッションを見えるようにするため、偽の
          // アイデンティティではなくツールエラーとして表面化させる。
          return {
            content: [
              {
                type: "text" as const,
                text: "この接続に認証済みアイデンティティがありません。",
              },
            ],
            isError: true as const,
          };
        }
        return {
          content: [{ type: "text" as const, text: `login: ${login}\nuser_id: ${user_id}` }],
          structuredContent: { login, user_id },
        };
      },
    );

    registerTodoTools(server, {
      openDb: deps.openDb,
      defaultWorkspace: resolveDefaultWorkspace(ctx.requestInfo),
      requestId: resolveRequestId(ctx.requestInfo),
    });

    return server;
  };

const REQUIRED_SCOPE = "todo";

/**
 * [scope enforcement] `props.scopes` に `todo` が含まれるかを確認する。
 * 401 の scope 広告に対応する実際の強制ポイント。詳細は
 * docs/design-notes.md 参照。
 */
function hasRequiredScope(props: Partial<Props> | undefined): boolean {
  return Array.isArray(props?.scopes) && props.scopes.includes(REQUIRED_SCOPE);
}

function insufficientScopeResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "insufficient_scope",
      error_description: `This token's grant does not include the "${REQUIRED_SCOPE}" scope`,
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${SCOPES_SUPPORTED.join(" ")}"`,
      },
    },
  );
}

/**
 * Turso 接続を開くクロージャ。設定が無ければ投げる。
 *
 * リクエスト全体を 500 で落とさないのは、`whoami` と `tools/list` を生かして
 * おくため —— 設定ミスの診断にまさに使いたい道具だから。ツールハンドラ内の
 * 例外は SDK が isError のツール結果に変換する（この文言がそのままモデルに
 * 届く）ので、黙って 0 件を返す事故にはならない。
 */
function tursoOpener(env: Partial<Env>): () => TaskDb {
  return () => {
    const config = tursoConfigFromEnv(env);
    if (!config) {
      console.log(`[mcp] ${JSON.stringify({ event: "turso_unconfigured" })}`);
      throw new Error(
        "サーバー設定エラー: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN が設定されていません。",
      );
    }
    return createTaskDb(config);
  };
}

/**
 * ExportedHandler 形状でラップ: OAuthProvider の apiHandler は
 * `fetch(request, env, ctx)` を期待するが、createMcpHandler が返すのは
 * `fetch(request, options)`。スコープ強制の場所でもある（詳細は
 * docs/design-notes.md 参照）。
 *
 * ハンドラをここで組み立てているのは、env を受け取れるのがこの位置だけだから
 * （createTodoMcpServer の doc コメント参照）。組み立てるのは薄いラッパーで、
 * McpServer 自体は元々リクエストごとに作られる（stateless 設計）。
 */
export const mcpApiHandler = {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> => {
    const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
    if (!hasRequiredScope(props)) return Promise.resolve(insufficientScopeResponse());

    const handler = createMcpHandler(
      createTodoMcpServer({ openDb: tursoOpener((env ?? {}) as Partial<Env>) }),
      { route: MCP_ROUTE },
    );
    return handler(request, env, ctx);
  },
};
