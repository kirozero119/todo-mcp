/**
 * Access-control primitives.
 *
 * Kept free of Worker/runtime imports so the authorization decision can be
 * unit-tested directly (`test/allowlist.test.ts`). Nothing here performs I/O.
 */

/**
 * Parses ALLOWED_GITHUB_USERS ("alice, bob") into a normalized list.
 *
 * GitHub logins are case-insensitive and unique case-insensitively, so the
 * comparison key is the lowercased login.
 */
export function parseAllowedGitHubUsers(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Matches an ALLOWED_GITHUB_USERS entry of the form `github:<numeric id>`. */
const GITHUB_ID_ENTRY = /^github:(\d+)$/;

/**
 * Is this GitHub identity allowed to obtain a grant?
 *
 * [M-3/P2-1] Two entry formats are accepted in ALLOWED_GITHUB_USERS:
 *  - a bare login (`octocat`)            — compared case-insensitively
 *  - `github:<numeric id>` (`github:1`)  — compared against the immutable
 *    numeric id
 *
 * The numeric-id form survives a login rename: GitHub frees a renamed login
 * for anyone else to claim, so an allowlist keyed purely on login can end up
 * granting access to a stranger who later registers the old name.
 *
 * Fails closed: an unset, empty, or whitespace-only ALLOWED_GITHUB_USERS denies
 * everyone. A misconfigured deploy therefore locks the operator out rather than
 * opening the server to every GitHub account on the internet.
 */
export function isGitHubUserAllowed(
  login: string | undefined | null,
  numericId: number | undefined | null,
  rawAllowlist: string | undefined | null,
): boolean {
  if (!login) return false;
  const allowed = parseAllowedGitHubUsers(rawAllowlist);
  if (allowed.length === 0) return false;

  const normalizedLogin = login.trim().toLowerCase();
  return allowed.some((entry) => {
    const idMatch = GITHUB_ID_ENTRY.exec(entry);
    if (idMatch) return numericId != null && String(numericId) === idMatch[1];
    return entry === normalizedLogin;
  });
}

function assertGitHubNumericId(numericId: number): void {
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error(`Invalid GitHub numeric id: ${numericId}`);
  }
}

/**
 * The namespaced identity stored in props and, later, used as the DB key.
 *
 * Uses the immutable numeric id rather than the login: GitHub logins can be
 * renamed and the freed name can be taken by somebody else. The `github:`
 * prefix reserves room for other IdPs without collision.
 */
export function githubUserId(numericId: number): string {
  assertGitHubNumericId(numericId);
  return `github:${numericId}`;
}

/**
 * The `userId` handed to OAuthProvider.completeAuthorization().
 *
 * MUST NOT contain ':'. workers-oauth-provider mints opaque access tokens as
 * `${userId}:${grantId}:${secret}` and validates them by splitting on ':' and
 * requiring exactly 3 parts (dist/oauth-provider.js — createAccessToken /
 * handleApiRequest). A colon in userId yields tokens that can never be
 * validated, so the grant identity uses '-' while props keep the canonical
 * `github:<id>` form.
 */
export function githubGrantUserId(numericId: number): string {
  assertGitHubNumericId(numericId);
  return `github-${numericId}`;
}

/**
 * Scopes actually granted for an authorization request.
 *
 * Mirrors the provider's own downscope() semantics: an empty request means
 * "everything this server supports", anything else is intersected with the
 * supported set so a client cannot widen its own grant.
 */
export function resolveGrantedScopes(
  requested: readonly string[] | undefined,
  supported: readonly string[],
): string[] {
  if (!requested || requested.length === 0) return [...supported];
  return supported.filter((scope) => requested.includes(scope));
}
