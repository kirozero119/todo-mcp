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
import { z } from "zod";

import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME, SERVER_VERSION } from "./config";
import type { Props } from "./types";

/** 現在処理中のリクエストの認証済みアイデンティティを読む。 */
function currentProps(): Partial<Props> {
  return (getMcpAuthContext()?.props ?? {}) as Partial<Props>;
}

/** テストが明示的な認証コンテキストでマウントできるように export。 */
export const createTodoMcpServer = () => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "個人用 Todo サーバー（認証スケルトン）。今のところ `whoami` のみが存在し、サインイン中の GitHub アイデンティティを報告します。",
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

  return server;
};

const handler = createMcpHandler(createTodoMcpServer, { route: MCP_ROUTE });

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
 * ExportedHandler 形状でラップ: OAuthProvider の apiHandler は
 * `fetch(request, env, ctx)` を期待するが、createMcpHandler が返すのは
 * `fetch(request, options)`。スコープ強制の場所でもある（詳細は
 * docs/design-notes.md 参照）。
 */
export const mcpApiHandler = {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> => {
    const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
    if (!hasRequiredScope(props)) return Promise.resolve(insufficientScopeResponse());
    return handler(request, env, ctx);
  },
};
