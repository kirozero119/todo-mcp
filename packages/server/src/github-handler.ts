/**
 * 二層構造の AS のうち defaultHandler 側。
 *
 *   MCP クライアント --(OAuth 2.1 + CIMD/DCR)--> この Worker（Authorization Server）
 *                                                    |
 *                                                    +--(素の OAuth 2.0)--> GitHub
 *
 * OAuthProvider は /authorize の*パース*、/token、/register、.well-known
 * ドキュメントを担う。このファイルは人間の目に触れる部分（同意画面、GitHub への
 * リダイレクト、認可を完了させるか決めるコールバック）をすべて担う。
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
 * この client_id はどちらの登録経路から来たか。
 *
 * provider 自身の isClientMetadataUrl() を踏襲: 非 root パスを持つ https URL
 * なら CIMD、それ以外は KV 登録済みクライアント。
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
 * [L-13] grant を作らずに拒否で終わる2つの経路（allowlist 拒否 / GitHub 自身の
 * 拒否）で共有する。RFC 6749 §4.1.2.1 に従い、クライアントの検証済み
 * redirect_uri へリダイレクトで返す。詳細は docs/design-notes.md 参照。
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
      // client_id（KV 検索 or CIMD 取得）、redirect_uri（登録済みリストとの
      // 照合）、PKCE メソッドを検証する。不一致があれば throw。
      oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    } catch (error) {
      // クライアントが接続できないときに最も役立つログ行: redirect_uri/ポート
      // 不一致か、未知クライアントか、PKCE メソッド拒否かを切り分けられる。
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

    // [M-1/P1-1] provider の parseAuthRequest() 自体は PKCE を強制しない
    // （PKCE 素通り。経緯は docs/design-notes.md 参照）。MCP は S256 PKCE 付き
    // authorization_code グラントを必須とするため、ここで明示的にアサートする。
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

    // [redirect_uri policy / CIMD parity] index.ts の clientRegistrationCallback
    // は DCR 登録時にしか効かないため、CIMD クライアントにもここで同じポリシーを
    // 適用する。詳細は docs/design-notes.md 参照。
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

    // このブラウザで既に同一の (client, redirect_uri) に同意済みなら同意画面は
    // スキップするが、GitHub へ行く前に新しいワンタイム state だけは作り直す。
    // [H-1] ループバック redirect_uri は高速経路から除外する。経緯は
    // docs/design-notes.md 参照。
    const preapproved =
      (await isClientApproved(
        c.req.raw,
        clientId,
        oauthReqInfo.redirectUri,
        c.env.COOKIE_ENCRYPTION_KEY,
      )) && !isLoopbackRedirectUri(oauthReqInfo.redirectUri);

    // [M-1/P1-1 + state ownership] 検証済みリクエストはどちらの分岐に進む前にも
    // 必ず KV へ新しい不透明トークンとしてコミットする。プレアプルーブ経路は
    // CSRF ペアリングなし（null）、ダイアログ経路は CSRF トークンを先に生成
    // してから state に束縛する。詳細は docs/design-notes.md 参照。
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
    // validateCSRFToken() が存在確認と CSRF cookie との一致を既にアサート済み。
    const csrfToken = formData.get("csrf_token") as string;

    const stateToken = formData.get("state");
    if (!stateToken || typeof stateToken !== "string") {
      return c.text("フォームデータに state がありません", 400);
    }

    // [dialog denial] Cancel は同一フォーム送信（decision=deny）。approveOAuthState()
    // は呼ばず rejectOAuthState() で state を即削除する。詳細は
    // docs/design-notes.md 参照。
    if (formData.get("decision") === "deny") {
      const oauthReqInfo = await rejectOAuthState(stateToken, c.env.OAUTH_KV);
      log("authorize_user_denied", { client_id: oauthReqInfo.clientId });
      return respondAccessDenied(oauthReqInfo, clearCsrfCookie);
    }

    // [M-1/P1-1 + state ownership] approveOAuthState() は不透明トークンだけで
    // KV からリクエストを引き直す。csrfToken 照合の詳細は
    // docs/design-notes.md 参照。
    const oauthReqInfo = await approveOAuthState(stateToken, c.env.OAUTH_KV, csrfToken);
    if (!oauthReqInfo.clientId) return c.text("不正なリクエストです", 400);

    // 同意が今まさに行われた瞬間: ここで初めて approval cookie を発行できる。
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
  // [L-14] state 検証より先はすべて外部サービス（GitHub）とプロバイダの KV に
  // 触れるため、失敗はすべてこの単一 catch に集約し、シークレットやスタック
  // トレースを漏らさない。詳細は docs/design-notes.md 参照。
  try {
    const { oauthReqInfo, clearCookie: clearSessionCookie } = await validateOAuthState(
      c.req.raw,
      c.env.OAUTH_KV,
    );

    // [GitHub-side denial] GitHub 自身の拒否は `code` なしの `?error=...` で
    // 返ってくる。通常のアクセス拒否と同じ経路で扱う。詳細は
    // docs/design-notes.md 参照。
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

    // 認証成功と認可は別の判断。allowlist 外のユーザーは completeAuthorization()
    // に一切到達しない（grant もコードもトークンも存在しない）。
    if (!isGitHubUserAllowed(identity.login, identity.id, c.env.ALLOWED_GITHUB_USERS)) {
      log("callback_denied", {
        login: identity.login,
        user_id: githubUserId(identity.id),
        client_id: oauthReqInfo.clientId,
      });
      // [L-13] RFC 6749 §4.1.2.1 に従いリダイレクトで拒否を返す。
      return respondAccessDenied(oauthReqInfo, clearSessionCookie);
    }

    // [P1-2/L-7] `resource` を省略するクライアントには裸のオリジンを補完し、
    // audience 未設定のトークンを発行しないようにする（index.ts の
    // resourceMatchOriginOnly と対。詳細は docs/design-notes.md 参照）。
    const resource = oauthReqInfo.resource ?? new URL(c.req.raw.url).origin;

    // [scope enforcement] grant の scope と props.scopes に一度だけ計算した
    // 値を使い回す。強制ロジック本体は mcp.ts の hasRequiredScope()。
    const grantedScopes = resolveGrantedScopes(oauthReqInfo.scope, SCOPES_SUPPORTED);

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: { ...oauthReqInfo, resource },
      // コロンなし: provider のトークン形式は `userId:grantId:secret` で
      // ちょうど3パーツを要求する（詳細は allowlist.ts の設計ノート参照）。
      userId: githubGrantUserId(identity.id),
      metadata: { label: identity.login },
      scope: grantedScopes,
      // [09/複数端末] CIMD では client_id が全端末で同一のため、既定の
      // revokeExistingGrants（同一 userId+clientId の既存 grant を全 revoke）
      // のままだと1台の再認可が他端末を丸ごとログアウトさせる。詳細は
      // docs/design-notes.md 参照。
      revokeExistingGrants: false,
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

// --------------------------------------------------------------------- 雑多

app.get("/", (c) =>
  c.text(
    `${SERVER_NAME}\n\nMCPエンドポイント: POST /mcp（OAuth 2.1 ベアラートークンが必要）\n` +
      "リソースメタデータ: /.well-known/oauth-protected-resource\n",
  ),
);

export { app as GitHubHandler };
