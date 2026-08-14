/**
 * [provider response shape] Our hand-built 401/403 against the *real*
 * `@cloudflare/workers-oauth-provider`.
 *
 * `identityNotAllowedResponse()` re-assembles, by hand, what the provider's own
 * `buildWwwAuthenticateHeader()` / `handleApiRequest()` / `createErrorResponse()`
 * produce: the `resource_metadata` URL, the `Bearer realm="OAuth", ...` header
 * and the no-cache headers. Today they agree byte for byte, but nothing made
 * them agree — a version bump that changes the provider's format would leave
 * ours silently different, and a client that only understands the provider's
 * form would stop treating our refusal as "re-authenticate".
 *
 * So this file drives the real provider (not the stub used elsewhere) to
 * produce its own 401 for `/mcp`, and compares. Same charter as
 * test/oauth-grants.test.ts: the checks that earn their keep in ticket 13, when
 * the library version moves. Running the real dist in the node pool needs the
 * two vitest.config.ts provisions documented there (`cloudflare:workers` virtual
 * module + `server.deps.inline`).
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";

import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME } from "../src/config";
import { mcpApiHandler, withAllowlistGate } from "../src/mcp";

const MCP_URL = `http://localhost:8788${MCP_ROUTE}`;

function ctxStub(props: Record<string, unknown>): ExecutionContext {
  return {
    props,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

function mcpRequest(authorization?: string): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      Host: "localhost:8788",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

/**
 * The provider's own `invalid_token` 401 for `/mcp`. Deliberately built
 * *without* index.ts's
 * `onError()` hook so this is the library's unmodified shape.
 */
async function providerOwn401(): Promise<Response> {
  const unusedHandler = { fetch: async () => new Response("unused in these tests") };
  const provider = new OAuthProvider({
    apiRoute: MCP_ROUTE,
    apiHandler: unusedHandler,
    defaultHandler: unusedHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    scopesSupported: [...SCOPES_SUPPORTED],
    resourceMetadata: {
      resource_name: SERVER_NAME,
      scopes_supported: [...SCOPES_SUPPORTED],
    },
  } as unknown as OAuthProviderOptions);

  const response = await (
    provider as unknown as {
      fetch: (r: Request, e: unknown, c: ExecutionContext) => Promise<Response>;
    }
  ).fetch(
    mcpRequest("Bearer not-a-valid-token"),
    { OAUTH_KV: { get: async () => null } },
    ctxStub({}),
  );
  expect(response.status).toBe(401);
  return response;
}

/** Our refusal for an identity that is no longer on the allowlist. */
function ourIdentityNotAllowed401(): Promise<Response> {
  return withAllowlistGate(mcpApiHandler).fetch(
    mcpRequest(),
    { ALLOWED_GITHUB_USERS: "someone-else" },
    ctxStub({ login: "octocat", user_id: "github:583231", scopes: ["todo"] }),
  );
}

/** Our refusal for a listed identity whose grant lacks the `todo` scope. */
function ourInsufficientScope403(): Promise<Response> {
  return withAllowlistGate(mcpApiHandler).fetch(
    mcpRequest(),
    { ALLOWED_GITHUB_USERS: "octocat" },
    ctxStub({ login: "octocat", user_id: "github:583231", scopes: [] }),
  );
}

describe("[provider response shape] our refusals still match the library's", () => {
  it("the 401 reproduces the provider's WWW-Authenticate prefix verbatim", async () => {
    const providerHeader = (await providerOwn401()).headers.get("WWW-Authenticate") ?? "";
    const ourHeader = (await ourIdentityNotAllowed401()).headers.get("WWW-Authenticate") ?? "";

    expect(providerHeader).toContain('resource_metadata="');
    expect(providerHeader).toContain('error="invalid_token"');
    expect(providerHeader).toContain(`scope="${SCOPES_SUPPORTED.join(" ")}"`);
    expect(ourHeader).toBe(providerHeader);
  });

  it("both of our refusals carry the same no-cache headers the provider sets", async () => {
    const providerHeaders = (await providerOwn401()).headers;
    // Whatever the library considers "do not cache an auth error", we set too.
    const noCache = ["Cache-Control", "Pragma"].map(
      (name) => [name, providerHeaders.get(name)] as const,
    );
    expect(noCache).toEqual([
      ["Cache-Control", "no-store"],
      ["Pragma", "no-cache"],
    ]);

    for (const response of [await ourIdentityNotAllowed401(), await ourInsufficientScope403()]) {
      for (const [name, value] of noCache) {
        expect(response.headers.get(name), `${response.status} is missing ${name}`).toBe(value);
      }
    }
  });

  it("the 401 body is the same two-field OAuth error object the provider returns", async () => {
    const providerBody = (await (await providerOwn401()).json()) as Record<string, unknown>;
    const ourBody = (await (await ourIdentityNotAllowed401()).json()) as Record<string, unknown>;

    expect(Object.keys(providerBody).sort()).toEqual(["error", "error_description"]);
    expect(Object.keys(ourBody).sort()).toEqual(Object.keys(providerBody).sort());
    expect(ourBody.error).toBe(providerBody.error);
  });
});
