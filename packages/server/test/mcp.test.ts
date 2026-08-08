import type { TaskDb } from "@todo-mcp/core";
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

/**
 * `url` defaults to the same bare `/mcp` used everywhere else in this file;
 * tests that need a `?workspace=` query pass it explicitly (see the
 * "get_agenda workspace resolution" describe block below).
 */
function buildMcpRequest(
  method: string,
  params: Record<string, unknown>,
  url = "http://localhost:8788/mcp",
): Request {
  return new Request(url, {
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
  url?: string,
): Promise<Record<string, unknown>> {
  const response = await handler.fetch(buildMcpRequest(method, params, url));
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

/**
 * [09] Builds a bare `TaskDb` fake (plain `all`/`get`, no `node:sqlite`) that
 * records the `workspace` argument each `listOpenTasks()` call passed to
 * `db.all()`. server's tsconfig carries no node types, so the in-memory
 * `node:sqlite` harness used in packages/core/test can't run here — but
 * get_agenda only needs to observe *which* workspace value reached the
 * query, not exercise real SQL, so this fake is enough (see
 * docs/design-notes.md's "TaskDb を最小インターフェースにして node:sqlite で
 * テストする" for why the real DB harness is core-only).
 */
function fakeTaskDb(): { db: TaskDb; workspacesQueried: unknown[] } {
  const workspacesQueried: unknown[] = [];
  const db: TaskDb = {
    // listOpenTasks() (packages/core/src/tasks.ts) binds args in the order
    // [userId, workspace, ...OPEN_STATUSES], so the workspace is args[1].
    all: async (_sql: string, args: unknown[] = []) => {
      workspacesQueried.push(args[1]);
      return [];
    },
    get: async () => undefined,
  };
  return { db, workspacesQueried };
}

describe("get_agenda workspace resolution ([09])", () => {
  it("falls back to the ?workspace= URL default when the tool argument is omitted, and a tool argument overrides it", async () => {
    const { db, workspacesQueried } = fakeTaskDb();
    const handler = createMcpHandler(createTodoMcpServer({ openDb: () => db }), {
      route: "/mcp",
      authContext: { props: PROPS },
    });

    const defaulted = await call(
      handler,
      "tools/call",
      { name: "get_agenda", arguments: {} },
      "http://localhost:8788/mcp?workspace=work",
    );
    expect(defaulted.isError).toBeFalsy();

    const overridden = await call(
      handler,
      "tools/call",
      { name: "get_agenda", arguments: { workspace: "life" } },
      "http://localhost:8788/mcp?workspace=work",
    );
    expect(overridden.isError).toBeFalsy();

    // First call used the connection's ?workspace=work default; the second
    // call's explicit tool argument ("life") won even though the URL default
    // was still "work" — the tool argument always wins (todo-tools.ts's
    // resolveWorkspace: `argument ?? deps.defaultWorkspace`).
    expect(workspacesQueried).toEqual(["work", "life"]);
  });
});

// [09/レビュー] The today-agenda *resource* handler (distinct from the
// get_agenda *tool*) used to carry its own hardcoded "既定 workspace が
// 未設定" string and never received an invalid `?workspace=` value at all —
// the same defect fix 4 addressed for the three tool paths, left unfixed on
// the resource path. These tests pin the resource to the same
// workspaceMissingError wording (via workspaceMissingText) so that
// asymmetry can't silently come back. Neither case ever reaches the DB
// (workspace resolution fails before `deps.openDb()` is called), so TEST_DEPS'
// throwing openDb is safe to use here too.
describe("today-agenda resource workspace resolution ([09/レビュー])", () => {
  it("uses the same wording as workspaceMissingError when ?workspace= is absent from the connection URL", async () => {
    const handler = createMcpHandler(createTodoMcpServer(TEST_DEPS), {
      route: "/mcp",
      authContext: { props: PROPS },
    });

    const result = await call(handler, "resources/read", { uri: "todo://today" });

    const contents = result.contents as Array<{ uri: string; text: string }>;
    expect(contents[0]?.text).toContain("不正な値: workspace=(未指定)");
    // Pins that the old hardcoded resource-only string is gone for good.
    expect(contents[0]?.text).not.toContain("既定 workspace が未設定のため表示できません");
  });

  it("echoes an invalid ?workspace= query value instead of the generic missing message", async () => {
    const handler = createMcpHandler(createTodoMcpServer(TEST_DEPS), {
      route: "/mcp",
      authContext: { props: PROPS },
    });

    const result = await call(
      handler,
      "resources/read",
      { uri: "todo://today" },
      "http://localhost:8788/mcp?workspace=lif",
    );

    const contents = result.contents as Array<{ uri: string; text: string }>;
    expect(contents[0]?.text).toContain('不正な値: workspace="lif"');
  });
});
