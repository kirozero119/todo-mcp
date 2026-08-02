import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Worker bindings.
 *
 * Everything except OAUTH_KV / OAUTH_PROVIDER is a secret:
 * - local      : packages/server/.dev.vars (symlink to the repo-root .dev.vars)
 * - production : `wrangler secret put <NAME>` (see README)
 */
export interface Env {
  /** Grants, tokens, DCR clients, and the short-lived OAuth state records. */
  OAUTH_KV: KVNamespace;

  /** GitHub OAuth App (this Worker acts as an OAuth *client* towards GitHub). */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  /** HMAC key for the signed "clients this browser already approved" cookie. */
  COOKIE_ENCRYPTION_KEY: string;

  /**
   * Comma-separated GitHub logins allowed to obtain a grant.
   * Unset or empty means "nobody" — the check fails closed on purpose.
   */
  ALLOWED_GITHUB_USERS?: string;

  /** Injected by OAuthProvider before it calls a handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * Application props: encrypted into the access token by workers-oauth-provider,
 * decrypted back into `ctx.props` on every authenticated /mcp request, and read
 * inside tools via `getMcpAuthContext().props`.
 *
 * Deliberately does NOT carry the upstream GitHub access token. The GitHub
 * OAuth scope is empty (identity only), so there is nothing to call GitHub for
 * after the callback; not storing it keeps the blast radius of a leaked
 * todo-mcp token limited to todo-mcp. (MCP spec: never pass a client token
 * through to an upstream API — a token we never hold cannot be passed through.)
 */
export type Props = {
  /** GitHub login at the time of authorization. Display only — logins are renameable. */
  login: string;
  /** Stable namespaced identity: `github:<numeric id>`. This is the future DB key. */
  user_id: string;
  /**
   * [scope enforcement] Scopes actually granted to this token
   * (resolveGrantedScopes() output at /callback time, mirrored into both the
   * grant's `scope` and this field). mcp.ts's apiHandler checks this against
   * SCOPES_SUPPORTED before any tool call is reached — the actual
   * enforcement point behind the `scope="todo"` this server already
   * advertises on a 401.
   */
  scopes: string[];
};
