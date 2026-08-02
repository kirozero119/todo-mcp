# todo-mcp

Practical Todo MCP server — Turso + GitHub OAuth + workspace switching. Built on MCP spec 2026-07-28 / SDK v2.

Current state: **authenticated deployment skeleton**. The authorization structure is
production-shaped; the tool surface is a single `whoami`. Turso and the real todo tools
land in later tickets.

## Layout

```
packages/server/     Cloudflare Worker: MCP server (Resource Server) + OAuth AS
  src/index.ts       entry — Origin guard, OAuthProvider wiring
  src/github-handler.ts  consent dialog, GitHub redirect, callback, allowlist enforcement
  src/mcp.ts         SDK v2 McpServer + `whoami`
  src/allowlist.ts   pure authorization helpers (unit tested)
  src/approval.ts    consent dialog, CSRF, OAuth state binding
  src/redirect-uri.ts  redirect_uri policy shared by DCR registration and GET /authorize
```

npm workspaces monorepo; `packages/core` and `packages/cli` are expected later.

## How the auth works

```
MCP client --(OAuth 2.1, PKCE S256, CIMD or DCR)--> this Worker (Authorization Server)
                                                        |
                                                        +--(OAuth 2.0)--> GitHub
```

The Worker is an Authorization Server to MCP clients and an OAuth client to GitHub.
Only tokens this Worker issued are accepted at `/mcp`; a GitHub token presented there
gets a 401.

- GitHub OAuth scope is **empty** — identity only (`login` + numeric `id`).
- After GitHub confirms who you are, `ALLOWED_GITHUB_USERS` decides whether an
  authorization is completed at all. A non-listed user is redirected back to the
  client's own redirect_uri with `error=access_denied` (RFC 6749 §4.1.2.1) and no
  grant is ever created — not a bare 403, which the client has no standard way to
  interpret. GitHub's own refusals (e.g. the user cancels on GitHub's consent
  screen) are relayed back the same way.
- Token props carry `login` and `user_id` (`github:<numeric id>`). The numeric id is used
  because GitHub logins can be renamed and re-registered by somebody else.

Endpoints: `/authorize`, `/token`, `/register` (DCR), `/callback`,
`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`,
and `/mcp` itself.

## Local development

Prerequisites: Node >=22.18.0 (pinned by `engines`; a locked dependency requires it),
and a **development** GitHub OAuth App:

- Homepage URL: `http://localhost:8788`
- Authorization callback URL: `http://localhost:8788/callback`

`packages/server/.dev.vars` is meant to be a symlink to the repo-root `.dev.vars`, but a
fresh clone starts without it — create it once:

```bash
ln -s ../../.dev.vars packages/server/.dev.vars
```

Put the values in `.dev.vars` at the repo root (git-ignored;
`packages/server/.dev.vars` is a symlink to it):

```
GITHUB_CLIENT_ID=<dev app client id>
GITHUB_CLIENT_SECRET=<dev app client secret>
COOKIE_ENCRYPTION_KEY=<openssl rand -base64 32>
ALLOWED_GITHUB_USERS=<your github login>
```

`ALLOWED_GITHUB_USERS` fails closed: unset or empty denies everyone. Entries may be a
GitHub login (`octocat`) or, to survive a login rename followed by someone else
registering the freed name, the immutable numeric id in `github:<numeric id>` form
(e.g. `github:583231`, found via `https://api.github.com/users/<login>`).

```bash
npm install
npm run dev        # wrangler dev on http://localhost:8788
npm run typecheck
npm test
```

Port 8788 is fixed by `dev.port` in `packages/server/wrangler.jsonc` because the dev
OAuth App's callback URL is registered against it.

Smoke checks that need no browser:

```bash
curl -s http://localhost:8788/.well-known/oauth-protected-resource
curl -s http://localhost:8788/.well-known/oauth-authorization-server
curl -si -X POST http://localhost:8788/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'      # 401 + WWW-Authenticate
```

The `__Host-` prefixed cookies (CSRF token, consent, approved-clients) have been
verified working in Chrome and Firefox during local development; Safari has not been
tested.

## Troubleshooting

- **"Invalid or expired state" on `/callback`**: KV is eventually consistent, and
  restarting the authorization flow from `/authorize` overwrites the
  `__Host-CSRF_TOKEN` / `__Host-CONSENTED_STATE` cookies from whichever attempt is
  still in flight. Both cases resolve by simply retrying the sign-in from
  `/authorize` again.

## Deployment

1. **Production GitHub OAuth App** (separate from the dev one — the callback URL differs):
   - Homepage URL: `https://todo-mcp.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://todo-mcp.<your-subdomain>.workers.dev/callback`

2. **KV namespace** — the provider stores grants, tokens and registered clients there:

   ```bash
   cd packages/server
   npx wrangler kv namespace create "OAUTH_KV"
   ```

   Put the returned id into `kv_namespaces[0].id` in `packages/server/wrangler.jsonc`
   (it currently holds the placeholder `REPLACE_ME_BEFORE_DEPLOY`).

3. **Secrets** — all four, none of them in `wrangler.jsonc`:

   ```bash
   cd packages/server
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -base64 32
   npx wrangler secret put ALLOWED_GITHUB_USERS    # comma-separated logins, or github:<numeric id>
   ```

   `ALLOWED_GITHUB_USERS` is a secret rather than a `vars` entry on purpose: a `vars`
   entry of the same name would overwrite the secret on every deploy.

4. **Deploy**:

   ```bash
   npm run deploy
   ```

5. **Connect** — point the MCP client at `https://todo-mcp.<your-subdomain>.workers.dev/mcp`
   and complete the GitHub sign-in in the browser window it opens.

## Notes for operators

- `compatibility_flags` must keep `global_fetch_strictly_public`; without it the provider
  refuses to fetch Client ID Metadata Documents and advertises
  `client_id_metadata_document_supported: false`, forcing every client onto DCR.
- Both registration paths are advertised. Every authorization logs which one a client
  used: `[oauth] {"event":"authorize","registration":"cimd"|"registered",...}`, and
  failures log as `authorize_rejected` with the rejected redirect_uri. To force clients
  onto DCR, set `clientIdMetadataDocumentEnabled: false` in `src/index.ts`.
- DCR-registered `redirect_uris` must all be `https`, or `http` restricted to a loopback
  address (`127.0.0.1`, `::1`, `localhost` — RFC 8252 §7.3); anything else is rejected at
  registration with `invalid_redirect_uri`. The same policy is asserted again at GET
  /authorize (`src/redirect-uri.ts`), so a CIMD client — whose `redirect_uris` come from
  a fetched document and never pass through DCR at all — cannot bypass it either.
- DCR client registrations expire after 90 days (`clientRegistrationTTL`), matching the
  provider's own default. Kept comfortably longer than the 30-day refresh token TTL so a
  still-valid refresh token never outlives its own `client:<id>` KV record.
- Access tokens live 1 hour, refresh tokens 30 days (provider defaults). Revoke a user's
  access by removing them from `ALLOWED_GITHUB_USERS` **and** deleting their grants —
  the allowlist is checked at authorization time, not on every request.
- The provider does not send an `iss` parameter on the authorization response. MCP
  final (SEP-2468) lists this as a SHOULD for the AS, not a MUST — a known gap, not a
  bug, and not currently blocking any client this server has been tested against.
- The `/register` (DCR) endpoint stays enabled for now. Once at least 3 real clients
  have connected successfully, consider disabling it (drop `clientRegistrationEndpoint`
  in `src/index.ts`) to push everyone onto CIMD, which needs no persisted client
  record at all.
