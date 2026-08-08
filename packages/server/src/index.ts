/**
 * Worker のエントリポイント。
 *
 * 構成:
 *   Origin ガード -> /mcp のみ、他の何よりも先に実行（下記参照）
 *   OAuthProvider -> /authorize（パース）、/token、/register、/.well-known/*
 *     apiRoute /mcp     -> withAllowlistGate(mcpApiHandler)（有効なトークンがある場合のみ）
 *     defaultHandler    -> GitHubHandler（同意画面、GitHub リダイレクト、コールバック）
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { localhostAllowedOrigins, originValidationResponse } from "@modelcontextprotocol/server";

import { isLoopbackRedirectUri } from "./approval";
import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME } from "./config";
import { GitHubHandler } from "./github-handler";
import { mcpApiHandler, withAllowlistGate } from "./mcp";
import { isAllowedRegistrationRedirectUri } from "./redirect-uri";
import type { Env } from "./types";

const provider = new OAuthProvider<Env>({
  apiRoute: MCP_ROUTE,
  // [15/allowlist per request] 認証済みルートに渡すハンドラは必ず
  // `withAllowlistGate()` をくぐらせる。ここに素の handler を書くと、
  // 発行済みトークンが allowlist の変更を無視して通る。ルートを足すときも
  // 同じ —— `apiHandlers: { "/mcp": withAllowlistGate(a), "/x": withAllowlistGate(b) }`。
  // 配線がゲート済みかどうかは test/wiring.test.ts が provider 設定を読んで検査する。
  apiHandler: withAllowlistGate(mcpApiHandler),
  defaultHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      GitHubHandler.fetch(request, env, ctx),
  },

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",

  // クライアント登録は MCP 仕様が許す両方式に対応:
  //  - CIMD: 仕様上の推奨。global_fetch_strictly_public 互換フラグが必要
  //  - DCR : 仕様上は非推奨だが、CIMD 非対応クライアント用に維持
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  // [M-4] DCR 登録の TTL。トークンの寿命より長くするのが原則。
  // 90日（provider 既定値）にした経緯（7日だとリフレッシュトークンより先に失効していた）は
  //  docs/design-notes.md 参照。
  clientRegistrationTTL: 60 * 60 * 24 * 90,

  // MCP は S256 PKCE を必須とする。provider の既定は allowPlainPKCE: true
  // なので、明示的に false にして plain を排除し PKCE を必須化する。
  allowPlainPKCE: false,

  // ASが発行しうる権限の種類
  scopesSupported: [...SCOPES_SUPPORTED],

  // [resource audience symmetry] github-handler.ts の /callback audience 補完
  // ([P1-2/L-7]) と対になる設定。経緯は docs/design-notes.md 参照。
  resourceMatchOriginOnly: true,

  // `resource` と `authorization_servers` は provider に任せる（リクエスト
  // URL から導出させる）。固定するとローカル/本番のどちらかが壊れる。
  resourceMetadata: { resource_name: SERVER_NAME },

  // すべての DCR 登録をログに残す。何も返さなければ登録は許可される。
  //
  // [M-4] isAllowedRegistrationRedirectUri() の実際の強制ポイント。詳細は
  // docs/design-notes.md 参照。
  clientRegistrationCallback: ({ clientMetadata }) => {
    console.log(
      `[oauth] ${JSON.stringify({
        event: "register",
        registration: "dcr",
        client_name: clientMetadata.client_name ?? null,
        redirect_uris: clientMetadata.redirect_uris ?? null,
        application_type: clientMetadata.application_type ?? null,
        token_endpoint_auth_method: clientMetadata.token_endpoint_auth_method ?? null,
      })}`,
    );

    const redirectUris = clientMetadata.redirect_uris;
    const uris = Array.isArray(redirectUris) ? redirectUris : [];
    const allAllowed =
      uris.length > 0 &&
      uris.every((uri) => typeof uri === "string" && isAllowedRegistrationRedirectUri(uri));
    if (!allAllowed) {
      return {
        code: "invalid_redirect_uri",
        description:
          "redirect_uris must all be https, or http restricted to a loopback address (127.0.0.1, ::1, localhost)",
        status: 400,
      };
    }
  },

  onError: ({ code, description, status, headers }) => {
    console.log(`[oauth] ${JSON.stringify({ event: "error", code, status, description })}`);

    // [M-2/P1-3] RFC 6750 §3: 401 に必要な scope を追記する。経緯は
    // docs/design-notes.md 参照。
    if (status === 401 && code === "invalid_token") {
      const wwwAuthenticate = headers["WWW-Authenticate"];
      if (wwwAuthenticate) {
        return new Response(JSON.stringify({ error: code, error_description: description }), {
          status,
          headers: {
            "Content-Type": "application/json",
            ...headers,
            "WWW-Authenticate": `${wwwAuthenticate}, scope="${SCOPES_SUPPORTED.join(" ")}"`,
          },
        });
      }
    }
    return undefined;
  },
});

/**
 * MCP エンドポイントの DNS リバインディング対策（MCP transports 仕様の MUST）。
 *
 * ポリシー:
 *  - `Origin` ヘッダーなし -> 許可（MCP クライアントは通常 CLI/デーモンで送らない）
 *  - `Origin` あり -> このホスト自身（またはローカル開発時のループバック名）と
 *    一致しなければ 403
 *
 * 配置場所（OAuthProvider より前段）と本番でのスコープ限定の経緯は
 * docs/design-notes.md 参照。
 */
function originGuard(request: Request): Response | undefined {
  const url = new URL(request.url);
  // [L-1] provider 自身の API ルート判定（startsWith）に合わせる。完全一致に
  // すると `MCP_ROUTE` 配下のサブパスが素通りしてしまう。詳細は
  // docs/design-notes.md 参照。
  if (!url.pathname.startsWith(MCP_ROUTE)) return undefined;

  // [production Origin scoping] Worker 自身のホスト名がループバックのときだけ
  // localhostAllowedOrigins() を許可リストに加える。経緯は
  // docs/design-notes.md 参照。
  const allowed = isLoopbackRedirectUri(`http://${url.hostname}`)
    ? [...localhostAllowedOrigins(), url.hostname]
    : [url.hostname];
  const rejection = originValidationResponse(request, allowed);
  if (rejection) {
    console.log(
      `[mcp] ${JSON.stringify({
        event: "origin_rejected",
        origin: request.headers.get("origin"),
        host: url.host,
      })}`,
    );
  }
  return rejection;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const rejection = originGuard(request);
    if (rejection) return Promise.resolve(rejection);
    return provider.fetch(request, env, ctx);
  },
};
