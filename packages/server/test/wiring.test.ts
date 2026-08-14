/**
 * [15/allowlist per request] The gate is a property of the *wiring*, not of one
 * function body.
 *
 * `mcpApiHandler` no longer refuses anyone by itself — `withAllowlistGate()`
 * does, and index.ts is where the two are composed. That makes the invariant
 * "every authenticated route re-evaluates the allowlist" a claim about what
 * index.ts hands OAuthProvider, so this file reads exactly that: the options
 * object the provider was constructed with.
 *
 * It walks *every* configured API handler rather than assuming there is one.
 * The provider also accepts `apiHandlers` (route → handler), and a second route
 * added there without the gate would be an ungated hole reachable with the same
 * token. Enumerating whatever is configured is what makes this test notice.
 *
 * The provider itself is replaced by a constructor that only records its
 * options: nothing here needs a real OAuth flow, only the wiring. The real
 * library is exercised in test/oauth-grants.test.ts and
 * test/provider-response-shape.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

const { capturedOptions } = vi.hoisted(() => ({
  capturedOptions: [] as Record<string, unknown>[],
}));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: class {
    constructor(options: Record<string, unknown>) {
      capturedOptions.push(options);
    }
    fetch(): Promise<Response> {
      return Promise.resolve(new Response("the provider itself is not under test here"));
    }
  },
}));

/** Minimal ExecutionContext stub carrying `props`, as OAuthProvider hands it to `apiHandler`. */
function ctxWithProps(props: Record<string, unknown>): ExecutionContext {
  return {
    props,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

/** A token that was minted while this identity was still on the allowlist. */
const SCOPED_PROPS = { login: "octocat", user_id: "github:583231", scopes: ["todo"] };

interface FetchHandler {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
}

/**
 * Every (route, handler) pair index.ts configured, whichever of the provider's
 * two shapes it used — `apiRoute` + `apiHandler` (single, possibly an array of
 * routes) or `apiHandlers` (a map). Switching between them must not silently
 * shrink what this file checks.
 */
function configuredApiHandlers(
  options: Record<string, unknown>,
): { route: string; handler: FetchHandler }[] {
  const multi = options.apiHandlers as Record<string, FetchHandler> | undefined;
  if (multi) return Object.entries(multi).map(([route, handler]) => ({ route, handler }));

  const handler = options.apiHandler as FetchHandler | undefined;
  expect(handler, "index.ts configured neither apiHandler nor apiHandlers").toBeDefined();
  const routes = Array.isArray(options.apiRoute)
    ? (options.apiRoute as string[])
    : [options.apiRoute as string];
  return routes.map((route) => ({ route, handler: handler as FetchHandler }));
}

async function providerOptions(): Promise<Record<string, unknown>> {
  await import("../src/index");
  expect(capturedOptions).toHaveLength(1);
  return capturedOptions[0]!;
}

function toolsListRequest(route: string): Request {
  return new Request(`http://localhost:8788${route}`, {
    method: "POST",
    headers: {
      Host: "localhost:8788",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("index.ts wiring [15]", () => {
  it("configures at least one authenticated route", async () => {
    // Guards the two tests below from passing vacuously over an empty list.
    expect(configuredApiHandlers(await providerOptions()).length).toBeGreaterThan(0);
  });

  it("every configured API handler refuses an identity that is no longer allowed", async () => {
    for (const { route, handler } of configuredApiHandlers(await providerOptions())) {
      const response = await handler.fetch(
        toolsListRequest(route),
        { ALLOWED_GITHUB_USERS: "someone-else" },
        ctxWithProps(SCOPED_PROPS),
      );

      expect(response.status, `${route} let a dropped identity through`).toBe(401);
      expect(((await response.json()) as { error?: string }).error).toBe("invalid_token");
    }
  });

  it("every configured API handler still serves an identity that is allowed", async () => {
    // The other half: the gate wired above is the allowlist gate, not a
    // blanket refusal that would make the previous test meaningless.
    for (const { route, handler } of configuredApiHandlers(await providerOptions())) {
      const response = await handler.fetch(
        toolsListRequest(route),
        { ALLOWED_GITHUB_USERS: "octocat" },
        ctxWithProps(SCOPED_PROPS),
      );

      expect(response.status, `${route} refused a listed identity`).toBe(200);
    }
  });

  it("[13] advertises the resource scope once and leaves provider errors unmodified", async () => {
    const options = await providerOptions();
    const resourceMetadata = options.resourceMetadata as { scopes_supported?: string[] };
    expect(resourceMetadata.scopes_supported).toEqual(["todo"]);

    const onError = options.onError as (error: {
      code: string;
      description: string;
      status: number;
      headers: Record<string, string>;
    }) => Response | undefined;
    const response = onError({
      code: "invalid_token",
      description: "Invalid access token",
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer error="invalid_token", scope="todo"',
      },
    });

    expect(response).toBeUndefined();
  });
});
