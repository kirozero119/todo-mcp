/**
 * The defaultHandler half of the two-layer AS.
 *
 *   MCP client --(OAuth 2.1 + CIMD/DCR)--> this Worker (Authorization Server)
 *                                              |
 *                                              +--(plain OAuth 2.0)--> GitHub
 *
 * OAuthProvider owns /authorize's *parsing*, /token, /register and the
 * .well-known documents. This file owns everything a human sees: the consent
 * dialog, the redirect to GitHub, and the callback that decides whether the
 * authorization is completed at all.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

import {
  githubGrantUserId,
  githubUserId,
  isGitHubUserAllowed,
  resolveGrantedScopes,
} from "./allowlist";
import {
  OAuthError,
  addApprovedClient,
  approveOAuthState,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  isLoopbackRedirectUri,
  rejectOAuthState,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./approval";
import { SCOPES_SUPPORTED, SERVER_DESCRIPTION, SERVER_NAME } from "./config";
import { buildGitHubAuthorizeUrl, exchangeGitHubCode, fetchGitHubIdentity } from "./github";
import { isAllowedRegistrationRedirectUri } from "./redirect-uri";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

/**
 * Which registration path did this client_id come from?
 *
 * Mirrors the provider's own isClientMetadataUrl(): an https URL with a
 * non-root path is treated as a Client ID Metadata Document; anything else is
 * looked up in KV (dynamically registered via /register, or created through
 * OAuthHelpers.createClient).
 */
function registrationSource(clientId: string): "cimd" | "registered" {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.pathname !== "/" ? "cimd" : "registered";
  } catch {
    return "registered";
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(`[oauth] ${JSON.stringify({ event, ...fields })}`);
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).href;
}

function redirectToGitHub(
  request: Request,
  env: Env,
  stateToken: string,
  extraCookies: string[],
): Response {
  const headers = new Headers({
    Location: buildGitHubAuthorizeUrl({
      clientId: env.GITHUB_CLIENT_ID,
      redirectUri: callbackUrl(request),
      state: stateToken,
    }),
  });
  for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/**
 * [L-13] Shared by both ways an authorization can end in denial without ever
 * creating a grant: our own allowlist rejecting the GitHub identity, and
 * GitHub itself refusing the upstream authorization (user hit "Cancel" on
 * GitHub's own consent screen, GitHub App suspended, etc.). Both report the
 * denial back to the client at its own already-validated redirect_uri per
 * RFC 6749 §4.1.2.1, with the original client `state` if any, instead of a
 * bare error status the client has no standard way to interpret.
 */
function respondAccessDenied(
  oauthReqInfo: AuthRequest,
  clearSessionCookie: string | undefined,
): Response {
  const denied = new URL(oauthReqInfo.redirectUri);
  denied.searchParams.set("error", "access_denied");
  if (oauthReqInfo.state) denied.searchParams.set("state", oauthReqInfo.state);
  const headers = new Headers({ Location: denied.toString() });
  if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------- /authorize

app.get("/authorize", async (c) => {
  try {
    let oauthReqInfo: AuthRequest;
    try {
      // Validates client_id (KV lookup or CIMD fetch), redirect_uri against the
      // client's registered list, and the PKCE method. Throws on any mismatch.
      oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    } catch (error) {
      // The single most useful log line when a client cannot connect: it shows
      // whether the failure is a redirect_uri/port mismatch (the Claude Code CIMD
      // regression) versus an unknown client or a rejected PKCE method.
      const url = new URL(c.req.url);
      log("authorize_rejected", {
        client_id: url.searchParams.get("client_id"),
        registration: registrationSource(url.searchParams.get("client_id") ?? ""),
        requested_redirect_uri: url.searchParams.get("redirect_uri"),
        code_challenge_method: url.searchParams.get("code_challenge_method"),
        reason: error instanceof Error ? error.message : String(error),
      });
      return c.text(
        `不正な認可リクエストです: ${error instanceof Error ? error.message : "不明なエラー"}`,
        400,
      );
    }

    // [M-1/P1-1] The provider's own parseAuthRequest() does not enforce PKCE or
    // reject the implicit flow itself: a missing code_challenge alongside
    // code_challenge_method=S256 passes through untouched, and
    // completeAuthorization() has no PKCE/implicit guard of its own
    // (confirmed against dist/oauth-provider.js). MCP requires the
    // authorization_code grant with S256 PKCE, so that is asserted here,
    // immediately after parsing and before anything else touches this request.
    if (oauthReqInfo.responseType !== "code") {
      log("authorize_rejected", {
        client_id: oauthReqInfo.clientId,
        reason: `unsupported response_type: ${oauthReqInfo.responseType}`,
      });
      return c.text('不正な認可リクエストです: response_type は "code" である必要があります', 400);
    }
    if (oauthReqInfo.codeChallengeMethod !== "S256" || !oauthReqInfo.codeChallenge) {
      log("authorize_rejected", {
        client_id: oauthReqInfo.clientId,
        reason: "PKCE with S256 and a non-empty code_challenge are required",
        code_challenge_method: oauthReqInfo.codeChallengeMethod ?? null,
      });
      return c.text(
        "不正な認可リクエストです: PKCE（code_challenge_method=S256 および code_challenge）が必須です",
        400,
      );
    }

    // [redirect_uri policy / CIMD parity] index.ts's clientRegistrationCallback
    // already enforces this same policy, but only at DCR registration time. A
    // Client ID Metadata Document (CIMD) client's redirect_uris come from a
    // document this server fetched at parseAuthRequest() time above and never
    // pass through that callback at all, so without asserting the policy here
    // too, a CIMD client could reach completeAuthorization() with any
    // scheme/host in redirect_uri. Checked immediately after the PKCE assert
    // and before anything is committed to KV.
    if (!isAllowedRegistrationRedirectUri(oauthReqInfo.redirectUri)) {
      log("authorize_rejected", {
        client_id: oauthReqInfo.clientId,
        registration: registrationSource(oauthReqInfo.clientId ?? ""),
        requested_redirect_uri: oauthReqInfo.redirectUri,
        reason: "redirect_uri must be https, or http restricted to a loopback address",
      });
      return c.text(
        "不正な認可リクエストです: redirect_uri は https、またはループバックアドレス（127.0.0.1, ::1, localhost）に限定した http である必要があります",
        400,
      );
    }

    const { clientId } = oauthReqInfo;
    if (!clientId) return c.text("不正なリクエストです: client_id がありません", 400);

    const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId);
    const registration = registrationSource(clientId);

    log("authorize", {
      registration,
      client_id: clientId,
      client_name: client?.clientName ?? null,
      requested_redirect_uri: oauthReqInfo.redirectUri,
      registered_redirect_uris: client?.redirectUris ?? null,
      requested_scope: oauthReqInfo.scope,
      code_challenge_method: oauthReqInfo.codeChallengeMethod ?? null,
      resource: oauthReqInfo.resource ?? null,
    });

    // Already consented to *this exact* (client, redirect_uri) pair in this
    // browser: skip the dialog but still mint a fresh one-time state and bind
    // it to the session before leaving for GitHub.
    //
    // [H-1] Loopback redirect_uris are excluded from the fast path: any local
    // process can listen on a loopback port (RFC 8252 §7.3), so a prior
    // consent to "some program on localhost" must not silently authorize
    // whatever now happens to be listening there — that case always gets the
    // dialog, every time.
    const preapproved =
      (await isClientApproved(
        c.req.raw,
        clientId,
        oauthReqInfo.redirectUri,
        c.env.COOKIE_ENCRYPTION_KEY,
      )) && !isLoopbackRedirectUri(oauthReqInfo.redirectUri);

    // [M-1/P1-1 + state ownership] The validated request is committed to KV
    // under a fresh opaque token before either branch below runs; neither
    // ever hands the request itself back to the browser again. The
    // preapproved fast path never renders the dialog and so never issues a
    // CSRF cookie at all — its state is created with no CSRF pairing
    // (csrfToken: null), rather than a token generated but handed to nobody.
    // The dialog path generates its CSRF token *first* so createOAuthState()
    // can commit its hash at creation time, binding this exact state to the
    // exact session the dialog is about to be sent to.
    const csrf = preapproved ? null : generateCSRFProtection();
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV, csrf?.token ?? null);

    if (preapproved) {
      await approveOAuthState(stateToken, c.env.OAUTH_KV, null);
      const { setCookie } = await bindStateToSession(stateToken);
      log("authorize_preapproved", { registration, client_id: clientId });
      return redirectToGitHub(c.req.raw, c.env, stateToken, [setCookie]);
    }

    return renderApprovalDialog({
      client,
      requestedRedirectUri: oauthReqInfo.redirectUri,
      isCimdClient: registration === "cimd",
      server: { name: SERVER_NAME, description: SERVER_DESCRIPTION },
      csrfToken: csrf!.token,
      setCookie: csrf!.setCookie,
      stateToken,
    });
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    const reason = error instanceof Error ? error.message : String(error);
    log("authorize_failed", { reason });
    return c.text("サーバー内部エラーが発生しました", 500);
  }
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    const { clearCookie: clearCsrfCookie } = validateCSRFToken(formData, c.req.raw);
    // validateCSRFToken() above already asserts this is present and a string
    // (it throws otherwise), and that it matches this browser's CSRF cookie.
    const csrfToken = formData.get("csrf_token") as string;

    const stateToken = formData.get("state");
    if (!stateToken || typeof stateToken !== "string") {
      return c.text("フォームデータに state がありません", 400);
    }

    // [dialog denial] The dialog's Cancel button is a same-form submit
    // (name="decision" value="deny") rather than a client-side
    // window.history.back(): the CSP here has no script-src, so any inline
    // JS is simply dead, and history.back() alone would strand the waiting
    // OAuth client with no callback at all. Denial never calls
    // approveOAuthState() — the state is deleted outright via
    // rejectOAuthState() so it can never subsequently be approved or denied
    // again — and never issues the approved-client or session-binding
    // cookies, nor forwards the browser to GitHub.
    if (formData.get("decision") === "deny") {
      const oauthReqInfo = await rejectOAuthState(stateToken, c.env.OAUTH_KV);
      log("authorize_user_denied", { client_id: oauthReqInfo.clientId });
      return respondAccessDenied(oauthReqInfo, clearCsrfCookie);
    }

    // [M-1/P1-1 + state ownership] approveOAuthState() reads the authorization
    // request back from KV by the opaque token alone — never from anything
    // the client submitted in this POST — and is the only place `approved`
    // flips true. Passing csrfToken here additionally verifies that this
    // exact stateToken was minted alongside this exact CSRF token: the
    // cookie/form match above only proves the pair is internally consistent,
    // not that it belongs to the flow this stateToken came from.
    const oauthReqInfo = await approveOAuthState(stateToken, c.env.OAUTH_KV, csrfToken);
    if (!oauthReqInfo.clientId) return c.text("不正なリクエストです", 400);

    // Consent has just been given: this is the first moment an approval
    // cookie may be issued, and (together with the state binding below) the
    // first moment the browser may be forwarded to the third-party IdP.
    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      oauthReqInfo.clientId,
      oauthReqInfo.redirectUri,
      c.env.COOKIE_ENCRYPTION_KEY,
    );
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    log("authorize_approved", {
      registration: registrationSource(oauthReqInfo.clientId),
      client_id: oauthReqInfo.clientId,
      requested_redirect_uri: oauthReqInfo.redirectUri,
    });

    return redirectToGitHub(c.req.raw, c.env, stateToken, [
      approvedClientCookie,
      sessionBindingCookie,
      clearCsrfCookie,
    ]);
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    console.error("[oauth] POST /authorize failed:", error);
    return c.text("サーバー内部エラーが発生しました", 500);
  }
});

// ----------------------------------------------------------------- /callback

app.get("/callback", async (c) => {
  // [L-14] Everything past state validation talks to two external services
  // (GitHub's token and user endpoints) and to the OAuth provider's own KV
  // operations. None of those failure modes may leak a stack trace, a
  // partially-built error message containing a secret, or an unhandled
  // exception straight to the client — they all fold into the single
  // catch below.
  try {
    const { oauthReqInfo, clearCookie: clearSessionCookie } = await validateOAuthState(
      c.req.raw,
      c.env.OAUTH_KV,
    );

    // [GitHub-side denial] GitHub reports its own refusals (user hit Cancel
    // on GitHub's consent screen, GitHub App suspended, etc.) as `?error=...`
    // with no `code` at all. Before this check, that fell straight into
    // exchangeGitHubCode()'s "missing code parameter" branch below and
    // surfaced as a bare 502 — indistinguishable from an actual upstream
    // outage, and not a status the client has any standard way to interpret.
    const upstreamError = c.req.query("error");
    if (upstreamError) {
      log("callback_upstream_denied", {
        reason: upstreamError,
        client_id: oauthReqInfo.clientId,
      });
      return respondAccessDenied(oauthReqInfo, clearSessionCookie);
    }

    if (!oauthReqInfo.clientId) return c.text("不正な OAuth リクエストデータです", 400);

    const exchange = await exchangeGitHubCode({
      clientId: c.env.GITHUB_CLIENT_ID,
      clientSecret: c.env.GITHUB_CLIENT_SECRET,
      code: c.req.query("code"),
      redirectUri: callbackUrl(c.req.raw),
    });
    if (!exchange.ok) {
      log("callback_upstream_failed", { reason: exchange.reason });
      return c.text("GitHub サインインの完了に失敗しました", 502);
    }

    const identity = await fetchGitHubIdentity(exchange.accessToken);
    if (!identity) {
      log("callback_identity_failed", {});
      return c.text("GitHub アイデンティティの取得に失敗しました", 502);
    }

    // Authentication succeeded; authorization is a separate decision. A
    // non-allowlisted user never reaches completeAuthorization(), so no
    // grant, no authorization code, and no token ever exist for them.
    if (!isGitHubUserAllowed(identity.login, identity.id, c.env.ALLOWED_GITHUB_USERS)) {
      log("callback_denied", {
        login: identity.login,
        user_id: githubUserId(identity.id),
        client_id: oauthReqInfo.clientId,
      });
      // [L-13] RFC 6749 §4.1.2.1: report the denial back to the client at its
      // already-validated redirect_uri (with the original `state`, if any)
      // instead of a bare 403 the client has no standard way to interpret.
      return respondAccessDenied(oauthReqInfo, clearSessionCookie);
    }

    // [P1-2/L-7] Always attach an audience. A client that omits RFC 8707
    // `resource` would otherwise get a token whose audience is unset —
    // usable, in principle, against any resource this AS ever issues a
    // token for — rather than one scoped to this resource server. Existing
    // clients that do send `resource` are never overridden.
    const resource = oauthReqInfo.resource ?? new URL(c.req.raw.url).origin;

    // [scope enforcement] Computed once and used for both the grant's scope
    // and props.scopes: mcp.ts's apiHandler checks the latter against
    // SCOPES_SUPPORTED before any tool call is reached, so the token's
    // enforced scope must be the same value the grant itself was issued with.
    const grantedScopes = resolveGrantedScopes(oauthReqInfo.scope, SCOPES_SUPPORTED);

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: { ...oauthReqInfo, resource },
      // Colon-free: the provider's opaque token format is `userId:grantId:secret`
      // and validation splits on ':' expecting exactly 3 parts.
      userId: githubGrantUserId(identity.id),
      metadata: { label: identity.login },
      scope: grantedScopes,
      props: {
        login: identity.login,
        user_id: githubUserId(identity.id),
        scopes: grantedScopes,
      },
    });

    log("callback_completed", {
      registration: registrationSource(oauthReqInfo.clientId),
      client_id: oauthReqInfo.clientId,
      login: identity.login,
      user_id: githubUserId(identity.id),
    });

    const headers = new Headers({ Location: redirectTo });
    if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    const reason = error instanceof Error ? error.message : String(error);
    log("callback_failed", { reason });
    return c.text("認可コールバックに失敗しました", 502);
  }
});

// --------------------------------------------------------------------- misc

app.get("/", (c) =>
  c.text(
    `${SERVER_NAME}\n\nMCPエンドポイント: POST /mcp（OAuth 2.1 ベアラートークンが必要）\n` +
      "リソースメタデータ: /.well-known/oauth-protected-resource\n",
  ),
);

export { app as GitHubHandler };
