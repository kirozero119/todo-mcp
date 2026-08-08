import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";

import { createTodoMcpServer, mcpApiHandler } from "../src/mcp";

/**
 * `whoami` never touches Turso, so these tests hand it a database that fails
 * loudly if anything reaches for it. The todo tools' own query behaviour is
 * covered against a real SQLite in packages/core/test/tasks.test.ts.
 */
const TEST_DEPS = {
  openDb: (): never => {
    throw new Error("whoami must not open a database");
  },
};

/** Minimal ExecutionContext stub carrying `props`, mirroring the shape OAuthProvider hands to `apiHandler`. */
function ctxWithProps(props: Record<string, unknown>): ExecutionContext {
  return {
    props,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

/**
 * Exercises the tool surface with an explicit auth context.
 *
 * In production the props come from OAuthProvider via `ctx.props`; here they
 * are injected through `authContext`, which lands in the same
 * AsyncLocalStorage that `getMcpAuthContext()` reads. That makes the
 * props-to-tool wiring testable without running the interactive OAuth flow.
 */
const PROPS = { login: "octocat", user_id: "github:583231" };

function handlerWithProps(props: Record<string, unknown> | undefined) {
  return createMcpHandler(createTodoMcpServer(TEST_DEPS), {
    route: "/mcp",
    ...(props ? { authContext: { props } } : {}),
  });
}

function buildMcpRequest(method: string, params: Record<string, unknown>): Request {
  return new Request("http://localhost:8788/mcp", {
    method: "POST",
    headers: {
      // workerd always supplies Host; Node's Request does not, and the
      // handler's DNS-rebinding guard rejects a missing Host with 403.
      Host: "localhost:8788",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // 2025-era handshake: this is how today's Claude Code connects, and
      // `legacy: 'stateless'` (the default) is what keeps it working.
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function parseMcpResult(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  const body = await response.text();
  // Streamable HTTP answers as SSE when the client accepts text/event-stream,
  // which is what a real MCP client sends.
  const json = body.startsWith("event:")
    ? body.slice(body.indexOf("data: ") + "data: ".length).split("\n")[0]!
    : body;
  const payload = JSON.parse(json) as { result?: Record<string, unknown> };
  expect(payload.result).toBeDefined();
  return payload.result as Record<string, unknown>;
}

async function call(
  handler: ReturnType<typeof handlerWithProps>,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await handler.fetch(buildMcpRequest(method, params));
  return parseMcpResult(response);
}

describe("mcp handler", () => {
  it("exposes whoami alongside the toolset v1 surface", async () => {
    const result = await call(handlerWithProps(PROPS), "tools/list", {});
    const tools = result.tools as Array<{ name: string }>;
    // Sorted so the assertion pins the exact surface without pinning
    // registration order. Deliberately absent: any delete tool — cancelling is
    // a status, not a row removal (ticket 03).
    expect(tools.map((t) => t.name).sort()).toEqual([
      "complete_task",
      "get_agenda",
      "get_task",
      "search_tasks",
      "upsert_task",
      "whoami",
    ]);
  });

  it("returns the authenticated identity from props", async () => {
    const result = await call(handlerWithProps(PROPS), "tools/call", {
      name: "whoami",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(PROPS);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("login: octocat");
    expect(content[0]?.text).toContain("user_id: github:583231");
  });

  it("reports an error rather than inventing an identity when props are absent", async () => {
    const result = await call(handlerWithProps(undefined), "tools/call", {
      name: "whoami",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  // [production wiring] Every test above injects props through `authContext`,
  // which the underlying handler prefers *over* `ctx.props` whenever both are
  // present. In production, OAuthProvider only ever sets `ctx.props` (see
  // index.ts's `apiHandler: mcpApiHandler`) and never passes an `authContext`
  // option at all — so this exercises the actual production channel directly,
  // calling the handler positionally (`handler(request, env, ctx)`) instead
  // of through `.fetch(request, options)`.
  it("[production wiring] reads identity from ctx.props when called positionally, not via authContext injection", async () => {
    const handler = createMcpHandler(createTodoMcpServer(TEST_DEPS), { route: "/mcp" });
    const response = await handler(
      buildMcpRequest("tools/call", { name: "whoami", arguments: {} }),
      {},
      ctxWithProps(PROPS),
    );
    const result = await parseMcpResult(response);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(PROPS);
  });
});

// [scope enforcement] mcpApiHandler is the actual OAuthProvider apiHandler
// (index.ts). OAuthProvider decrypts the grant's props into `ctx.props`
// before calling it, which is exactly what these tests inject directly —
// unlike the `mcp handler` tests above, which go through the raw SDK handler
// via `authContext` and never exercise this scope check at all.
describe("scope enforcement (mcpApiHandler)", () => {
  it("returns 403 insufficient_scope when props.scopes lacks \"todo\"", async () => {
    const response = await mcpApiHandler.fetch(
      buildMcpRequest("tools/call", { name: "whoami", arguments: {} }),
      {},
      ctxWithProps({ ...PROPS, scopes: [] }),
    );

    expect(response.status).toBe(403);
    const wwwAuthenticate = response.headers.get("WWW-Authenticate");
    expect(wwwAuthenticate).toContain('error="insufficient_scope"');
    expect(wwwAuthenticate).toContain('scope="todo"');
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("insufficient_scope");
  });

  it("allows the call through when props.scopes includes \"todo\" (ctx.props, the real OAuthProvider channel)", async () => {
    const response = await mcpApiHandler.fetch(
      buildMcpRequest("tools/call", { name: "whoami", arguments: {} }),
      {},
      ctxWithProps({ ...PROPS, scopes: ["todo"] }),
    );
    const result = await parseMcpResult(response);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(PROPS);
  });
});
