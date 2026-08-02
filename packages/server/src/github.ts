/**
 * This Worker's *client* half: talking to GitHub as an ordinary OAuth client.
 *
 * The provider half (being an Authorization Server to MCP clients) lives in
 * index.ts / github-handler.ts.
 */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/** GitHub's API rejects requests without a User-Agent. */
const USER_AGENT = "todo-mcp";

export interface GitHubIdentity {
  login: string;
  id: number;
}

/**
 * Builds the upstream authorize URL.
 *
 * No `scope` parameter at all. GitHub then issues a token with an empty scope,
 * which is still enough for GET /user to return `login` and `id` — all we need
 * for identity. Asking for `read:user` would let a leaked upstream token read
 * profile data we never use.
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

/** Exchanges the GitHub authorization code for an upstream access token. */
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

  // With Accept: application/json GitHub answers JSON; it also reports failures
  // with HTTP 200 and an `error` field, so the body has to be inspected.
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (body.error) return { ok: false, reason: `token endpoint error: ${body.error}` };
  if (!body.access_token) return { ok: false, reason: "token endpoint returned no access_token" };
  return { ok: true, accessToken: body.access_token };
}

/**
 * Reads the authenticated user's identity.
 *
 * Only `login` and `id` are kept; `id` is the immutable one and becomes
 * `github:<id>` in props.
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
