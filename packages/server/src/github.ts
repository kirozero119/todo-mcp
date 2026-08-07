/**
 * この Worker の*クライアント*側の半分: 普通の OAuth クライアントとして GitHub と話す。
 *
 * provider 側（MCP クライアントに対する Authorization Server）は
 * index.ts / github-handler.ts にある。
 */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/** GitHub の API は User-Agent がないリクエストを拒否する。 */
const USER_AGENT = "todo-mcp";

export interface GitHubIdentity {
  login: string;
  id: number;
}

/**
 * upstream の認可 URL を組み立てる。
 *
 * `scope` パラメータは一切渡さない（空スコープでも GET /user は
 * `login`/`id` を返す。詳細は docs/design-notes.md 参照）。
 */
export function buildGitHubAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  return url.href;
}

export type ExchangeResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: string };

/** GitHub の認可コードを upstream のアクセストークンと交換する。 */
export async function exchangeGitHubCode(params: {
  clientId: string;
  clientSecret: string;
  code: string | undefined;
  redirectUri: string;
}): Promise<ExchangeResult> {
  if (!params.code) return { ok: false, reason: "missing code parameter" };

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    return { ok: false, reason: `token endpoint returned HTTP ${response.status}` };
  }

  // GitHub は失敗時も HTTP 200 で `error` フィールドを返すため、ボディを見て判定する。
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (body.error) return { ok: false, reason: `token endpoint error: ${body.error}` };
  if (!body.access_token) return { ok: false, reason: "token endpoint returned no access_token" };
  return { ok: true, accessToken: body.access_token };
}

/**
 * 認証済みユーザーのアイデンティティを読む。
 *
 * 保持するのは `login` と `id` のみ。`id` が不変で、props の
 * `github:<id>` になる（詳細は allowlist.ts の設計ノート参照）。
 */
export async function fetchGitHubIdentity(accessToken: string): Promise<GitHubIdentity | null> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) return null;

  const body = (await response.json()) as { login?: unknown; id?: unknown };
  if (typeof body.login !== "string" || typeof body.id !== "number") return null;
  return { login: body.login, id: body.id };
}
