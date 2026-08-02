/**
 * The MCP server itself (Resource Server side).
 *
 * SDK v2 `McpServer` factory handed to `createMcpHandler` from
 * `agents/mcp/server`. Stateless — no Durable Objects. The `legacy` option is
 * left at its default `'stateless'` so 2025-era handshakes still work; today's
 * Claude Code connects that way.
 *
 * Only reached for requests that already carry a valid token: OAuthProvider
 * validates the bearer token, decrypts the grant's props into `ctx.props`, and
 * only then calls this handler. The agents wrapper lifts `ctx.props` into an
 * AsyncLocalStorage context that `getMcpAuthContext()` reads.
 */
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME, SERVER_VERSION } from "./config";
import type { Props } from "./types";

/** Reads the authenticated identity for the request currently being served. */
function currentProps(): Partial<Props> {
  return (getMcpAuthContext()?.props ?? {}) as Partial<Props>;
}

/** Exported so tests can mount it with an explicit auth context. */
export const createTodoMcpServer = () => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Personal todo server (auth skeleton). Only `whoami` exists so far; it reports the signed-in GitHub identity.",
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Returns the GitHub identity this connection is authenticated as. Use it to confirm the server sees you as the expected user.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const { login, user_id } = currentProps();
      if (!login || !user_id) {
        // Should be unreachable: OAuthProvider rejects unauthenticated requests
        // before this handler runs. Surfacing it as a tool error rather than
        // returning a fake identity keeps a props-plumbing regression visible.
        return {
          content: [
            {
              type: "text" as const,
              text: "Authenticated identity is unavailable on this request.",
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
 * [scope enforcement] index.ts's onError() advertises `scope="todo"` on
 * every 401 (RFC 6750 §3), but until now nothing on the resource-server side
 * ever checked a token's *granted* scope against it — any authenticated
 * token reached every tool regardless of what resolveGrantedScopes()
 * actually granted it at /callback time. This is the missing enforcement
 * point the 401 response was implying already existed.
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
 * Wrapped in an ExportedHandler shape because OAuthProvider's `apiHandler`
 * expects `fetch(request, env, ctx)`, while the object returned by
 * createMcpHandler exposes `fetch(request, options)`.
 *
 * Also the scope-enforcement point: OAuthProvider decrypts the grant's props
 * into `ctx.props` before calling this handler (see index.ts), so this is
 * the earliest place `props.scopes` is available to check, before the
 * request ever reaches a tool.
 */
export const mcpApiHandler = {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> => {
    const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
    if (!hasRequiredScope(props)) return Promise.resolve(insufficientScopeResponse());
    return handler(request, env, ctx);
  },
};
