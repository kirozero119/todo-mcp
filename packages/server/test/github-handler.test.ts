import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addApprovedClient, approveOAuthState, bindStateToSession, createOAuthState } from "../src/approval";
import { GitHubHandler } from "../src/github-handler";
import type { Env } from "../src/types";

/** [L-9] importKey() rejects any secret shorter than 32 chars. */
const SECRET = "s".repeat(32);

const ctxStub = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function kvStub(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (async (key: string) => store.get(key) ?? null) as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      store.set(key, value);
    }) as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as KVNamespace["delete"],
  } as unknown as KVNamespace;
}

function oauthProviderStub(overrides: {
  parseAuthRequest?: (request: Request) => Promise<AuthRequest>;
  completeAuthorization?: OAuthHelpers["completeAuthorization"];
} = {}): OAuthHelpers {
  return {
    parseAuthRequest:
      overrides.parseAuthRequest ??
      (async () => {
        throw new Error("parseAuthRequest not stubbed for this test");
      }),
    lookupClient: async () => null,
    completeAuthorization:
      overrides.completeAuthorization ??
      (async () => ({ redirectTo: "https://client.example/unused" })),
    createClient: async () => {
      throw new Error("createClient not implemented in stub");
    },
    listClients: async () => ({ items: [] }),
    updateClient: async () => null,
    deleteClient: async () => {},
    listUserGrants: async () => ({ items: [] }),
    revokeGrant: async () => {},
    unwrapToken: async () => null,
    exchangeToken: async () => {
      throw new Error("exchangeToken not implemented in stub");
    },
    purgeExpiredData: async () => ({
      grantsChecked: 0,
      grantsPurged: 0,
      tokensChecked: 0,
      tokensPurged: 0,
      done: true,
    }),
  } as unknown as OAuthHelpers;
}

function makeEnv(opts: {
  kv?: KVNamespace;
  allowedUsers?: string;
  provider?: OAuthHelpers;
} = {}): Env {
  return {
    OAUTH_KV: opts.kv ?? kvStub(),
    GITHUB_CLIENT_ID: "gh-client-id",
    GITHUB_CLIENT_SECRET: "gh-client-secret",
    COOKIE_ENCRYPTION_KEY: SECRET,
    ALLOWED_GITHUB_USERS: opts.allowedUsers ?? "octocat",
    OAUTH_PROVIDER: opts.provider ?? oauthProviderStub(),
  };
}

/** Stubs global fetch for the two upstream GitHub endpoints exercised in /callback. */
function stubGitHubFetch(identity: { login: string; id: number }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gh-upstream-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("https://api.github.com/user")) {
        return new Response(JSON.stringify(identity), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = response.headers.get("Set-Cookie");
  return single ? [single] : [];
}

const BASE_AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://client.example/callback",
  scope: [],
  state: "client-state",
  codeChallenge: "challenge-abc",
  codeChallengeMethod: "S256",
};

describe("GET /authorize", () => {
  it("does not issue consent cookies before the user approves (CSRF cookie only)", async () => {
    const env = makeEnv({
      provider: oauthProviderStub({ parseAuthRequest: async () => BASE_AUTH_REQUEST }),
    });
    const request = new Request("http://localhost:8788/authorize?response_type=code");

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    expect(response.status).toBe(200);
    const cookies = getSetCookies(response);
    expect(cookies.some((c) => c.startsWith("__Host-CSRF_TOKEN="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("__Host-APPROVED_CLIENTS="))).toBe(false);
    expect(cookies.some((c) => c.startsWith("__Host-CONSENTED_STATE="))).toBe(false);
  });

  it("[M-1/P1-1] rejects code_challenge_method=S256 without a code_challenge", async () => {
    const env = makeEnv({
      provider: oauthProviderStub({
        parseAuthRequest: async () => ({ ...BASE_AUTH_REQUEST, codeChallenge: undefined }),
      }),
    });
    const request = new Request("http://localhost:8788/authorize?code_challenge_method=S256");

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    expect(response.status).toBe(400);
  });

  it("[M-1/P1-1] rejects response_type=token", async () => {
    const env = makeEnv({
      provider: oauthProviderStub({
        parseAuthRequest: async () => ({ ...BASE_AUTH_REQUEST, responseType: "token" }),
      }),
    });
    const request = new Request("http://localhost:8788/authorize?response_type=token");

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    expect(response.status).toBe(400);
  });

  it("[H-1] still shows the dialog for an approved client when the redirect_uri is a loopback address", async () => {
    const loopbackAuthRequest: AuthRequest = {
      ...BASE_AUTH_REQUEST,
      redirectUri: "http://127.0.0.1:54321/callback",
    };
    const approvedCookie = await addApprovedClient(
      new Request("http://localhost:8788/authorize"),
      loopbackAuthRequest.clientId,
      loopbackAuthRequest.redirectUri,
      SECRET,
    );
    const approvedCookiePair = approvedCookie.split(";")[0]!;

    const env = makeEnv({
      provider: oauthProviderStub({ parseAuthRequest: async () => loopbackAuthRequest }),
    });
    const request = new Request("http://localhost:8788/authorize", {
      headers: { Cookie: approvedCookiePair },
    });

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    // A preapproved fast path would answer 302 straight to GitHub; loopback
    // redirect_uris must always re-show the consent dialog instead.
    expect(response.status).not.toBe(302);
    const body = await response.text();
    expect(body).toContain("Approve");
  });

  // [redesign 2] redirect_uri policy / CIMD parity: a CIMD client's
  // redirect_uris come from a fetched metadata document and never pass
  // through clientRegistrationCallback (the DCR-only enforcement point), so
  // parseAuthRequest() alone accepting it must not be enough to reach
  // completeAuthorization() with a non-loopback plain-http redirect_uri.
  it("rejects a non-loopback http redirect_uri even when parseAuthRequest() itself accepts it (CIMD path)", async () => {
    const env = makeEnv({
      provider: oauthProviderStub({
        parseAuthRequest: async () => ({
          ...BASE_AUTH_REQUEST,
          clientId: "https://cimd.example/client-metadata.json",
          redirectUri: "http://192.168.1.10/cb",
        }),
      }),
    });
    const request = new Request("http://localhost:8788/authorize");

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    expect(response.status).toBe(400);
  });
});

describe("POST /authorize", () => {
  /** Extracts a hidden input's `value` attribute out of the rendered dialog HTML. */
  function extractHiddenInputValue(html: string, name: string): string {
    const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
    if (!match) throw new Error(`hidden input "${name}" not found in dialog HTML`);
    return match[1]!;
  }

  // [redesign 5] state ownership regression: an attacker's own CSRF
  // cookie/form-field pair is internally consistent (it matches itself), but
  // must not be usable to approve a *different* browser's/flow's state —
  // otherwise a link like `/authorize?...&state=<victim-state>` combined with
  // the attacker's own session could approve someone else's pending request.
  it("[state ownership] rejects a POST whose CSRF pair is valid for a different flow's state", async () => {
    const kv = kvStub();

    const responseA = await GitHubHandler.fetch(
      new Request("http://localhost:8788/authorize"),
      makeEnv({
        kv,
        provider: oauthProviderStub({
          parseAuthRequest: async () => ({ ...BASE_AUTH_REQUEST, clientId: "client-a" }),
        }),
      }),
      ctxStub,
    );
    const bodyA = await responseA.text();
    const csrfTokenA = extractHiddenInputValue(bodyA, "csrf_token");
    const csrfCookieA = getSetCookies(responseA)
      .find((c) => c.startsWith("__Host-CSRF_TOKEN="))!
      .split(";")[0]!;

    const responseB = await GitHubHandler.fetch(
      new Request("http://localhost:8788/authorize"),
      makeEnv({
        kv,
        provider: oauthProviderStub({
          parseAuthRequest: async () => ({ ...BASE_AUTH_REQUEST, clientId: "client-b" }),
        }),
      }),
      ctxStub,
    );
    const bodyB = await responseB.text();
    const stateB = extractHiddenInputValue(bodyB, "state");

    // Attacker's own internally-consistent CSRF pair (cookie A / token A),
    // submitted against flow B's stateToken.
    const formData = new FormData();
    formData.set("csrf_token", csrfTokenA);
    formData.set("state", stateB);
    const maliciousRequest = new Request("http://localhost:8788/authorize", {
      method: "POST",
      headers: { Cookie: csrfCookieA },
      body: formData,
    });

    const maliciousResponse = await GitHubHandler.fetch(
      maliciousRequest,
      makeEnv({ kv }),
      ctxStub,
    );

    expect(maliciousResponse.status).toBe(400);
  });

  // [dialog denial] The dialog's Cancel button is a same-form submit
  // (name="decision" value="deny"), since the CSP has no script-src and the
  // old inline onclick="window.history.back()" never ran a request at all —
  // leaving the waiting OAuth client stranded with no callback. This must
  // deny via the server (never approve, never reach GitHub or issue consent
  // cookies) and the state must not be usable a second time afterwards.
  it("[dialog denial] decision=deny denies without approving, without consent cookies, and burns the state", async () => {
    const kv = kvStub();

    const getResponse = await GitHubHandler.fetch(
      new Request("http://localhost:8788/authorize"),
      makeEnv({
        kv,
        provider: oauthProviderStub({ parseAuthRequest: async () => BASE_AUTH_REQUEST }),
      }),
      ctxStub,
    );
    const dialogHtml = await getResponse.text();

    // The Cancel button must be a real submit control, not dead client-side JS.
    expect(dialogHtml).not.toContain("onclick");
    expect(dialogHtml).toMatch(/name="decision"\s+value="deny"/);
    expect(dialogHtml).toMatch(/name="decision"\s+value="approve"/);

    const csrfToken = extractHiddenInputValue(dialogHtml, "csrf_token");
    const stateToken = extractHiddenInputValue(dialogHtml, "state");
    const csrfCookiePair = getSetCookies(getResponse)
      .find((c) => c.startsWith("__Host-CSRF_TOKEN="))!
      .split(";")[0]!;

    const completeAuthorization = vi.fn(async () => ({
      redirectTo: "https://should-not-be-called.example",
    }));
    const env = makeEnv({ kv, provider: oauthProviderStub({ completeAuthorization }) });

    function buildDenyRequest(): Request {
      const formData = new FormData();
      formData.set("csrf_token", csrfToken);
      formData.set("state", stateToken);
      formData.set("decision", "deny");
      return new Request("http://localhost:8788/authorize", {
        method: "POST",
        headers: { Cookie: csrfCookiePair },
        body: formData,
      });
    }

    const denyResponse = await GitHubHandler.fetch(buildDenyRequest(), env, ctxStub);

    expect(denyResponse.status).toBe(302);
    const location = denyResponse.headers.get("Location") ?? "";
    expect(location.startsWith(BASE_AUTH_REQUEST.redirectUri)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
    expect(new URL(location).searchParams.get("state")).toBe(BASE_AUTH_REQUEST.state);

    const cookies = getSetCookies(denyResponse);
    expect(cookies.some((c) => c.startsWith("__Host-APPROVED_CLIENTS="))).toBe(false);
    expect(cookies.some((c) => c.startsWith("__Host-CONSENTED_STATE="))).toBe(false);

    expect(completeAuthorization).not.toHaveBeenCalled();

    // The one-time state must not be reusable, whether to deny again or to approve.
    const secondDenyResponse = await GitHubHandler.fetch(buildDenyRequest(), env, ctxStub);
    expect(secondDenyResponse.status).toBe(400);
  });
});

describe("GET /callback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[L-13] denies a non-allowlisted user via redirect, without ever calling completeAuthorization", async () => {
    stubGitHubFetch({ login: "mallory", id: 999 });

    const kv = kvStub();
    const { stateToken } = await createOAuthState(BASE_AUTH_REQUEST, kv);
    await approveOAuthState(stateToken, kv);
    const { setCookie } = await bindStateToSession(stateToken);
    const sessionCookiePair = setCookie.split(";")[0]!;

    const completeAuthorization = vi.fn(async () => ({
      redirectTo: "https://should-not-be-called.example",
    }));
    const env = makeEnv({
      kv,
      allowedUsers: "octocat",
      provider: oauthProviderStub({ completeAuthorization }),
    });

    const request = new Request(
      `http://localhost:8788/callback?code=upstream-code&state=${stateToken}`,
      { headers: { Cookie: sessionCookiePair } },
    );

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(BASE_AUTH_REQUEST.redirectUri)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
    expect(new URL(location).searchParams.get("state")).toBe(BASE_AUTH_REQUEST.state);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  // [redesign 4] GitHub itself can refuse the upstream authorization (user
  // hits Cancel on GitHub's own consent screen) — reported back as
  // `?error=...` with no `code` at all. Before this fix that fell through to
  // exchangeGitHubCode()'s "missing code" branch and surfaced as a bare 502.
  it("[GitHub-side denial] relays GitHub's own access_denied instead of failing with 502", async () => {
    // No stubGitHubFetch(): exchangeGitHubCode() must never be reached, so a
    // stray fetch call here would itself be a signal something is wrong.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called for an upstream-denied callback");
      }),
    );

    const kv = kvStub();
    const { stateToken } = await createOAuthState(BASE_AUTH_REQUEST, kv);
    await approveOAuthState(stateToken, kv);
    const { setCookie } = await bindStateToSession(stateToken);
    const sessionCookiePair = setCookie.split(";")[0]!;

    const completeAuthorization = vi.fn(async () => ({
      redirectTo: "https://should-not-be-called.example",
    }));
    const env = makeEnv({ kv, provider: oauthProviderStub({ completeAuthorization }) });

    const request = new Request(
      `http://localhost:8788/callback?error=access_denied&error_description=User+denied&state=${stateToken}`,
      { headers: { Cookie: sessionCookiePair } },
    );

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(BASE_AUTH_REQUEST.redirectUri)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
    expect(new URL(location).searchParams.get("state")).toBe(BASE_AUTH_REQUEST.state);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("completes authorization for an allowlisted user", async () => {
    stubGitHubFetch({ login: "octocat", id: 1 });

    const kv = kvStub();
    const { stateToken } = await createOAuthState(BASE_AUTH_REQUEST, kv);
    await approveOAuthState(stateToken, kv);
    const { setCookie } = await bindStateToSession(stateToken);
    const sessionCookiePair = setCookie.split(";")[0]!;

    const completeAuthorization = vi.fn(
      async (_options: Parameters<OAuthHelpers["completeAuthorization"]>[0]) => ({
        redirectTo: "https://client.example/callback?code=final-code",
      }),
    );
    const env = makeEnv({
      kv,
      allowedUsers: "octocat",
      provider: oauthProviderStub({ completeAuthorization }),
    });

    const request = new Request(
      `http://localhost:8788/callback?code=upstream-code&state=${stateToken}`,
      { headers: { Cookie: sessionCookiePair } },
    );

    const response = await GitHubHandler.fetch(request, env, ctxStub);

    expect(response.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    // [P1-2/L-7] audience always attached, even though this client never sent
    // an RFC 8707 `resource` parameter.
    const call = completeAuthorization.mock.calls[0]?.[0];
    expect(call?.request.resource).toBe("http://localhost:8788");
    // [redesign 6] props.scopes carries the same granted scopes as the
    // grant's own `scope` — this is what mcp.ts's apiHandler checks before
    // any tool call is reached. BASE_AUTH_REQUEST.scope is `[]`, so
    // resolveGrantedScopes() grants everything supported.
    expect(call?.scope).toEqual(["todo"]);
    expect((call?.props as { scopes?: string[] } | undefined)?.scopes).toEqual(["todo"]);
  });
});
