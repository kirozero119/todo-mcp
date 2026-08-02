/**
 * Worker entry.
 *
 * Layout:
 *   Origin guard  -> /mcp only, runs before anything else (see below)
 *   OAuthProvider -> /authorize (parse), /token, /register, /.well-known/*
 *     apiRoute /mcp     -> mcpApiHandler  (only with a valid token)
 *     defaultHandler    -> GitHubHandler  (consent dialog, GitHub redirect, callback)
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { localhostAllowedOrigins, originValidationResponse } from "@modelcontextprotocol/server";

import { isLoopbackRedirectUri } from "./approval";
import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME } from "./config";
import { GitHubHandler } from "./github-handler";
import { mcpApiHandler } from "./mcp";
import { isAllowedRegistrationRedirectUri } from "./redirect-uri";
import type { Env } from "./types";

const provider = new OAuthProvider<Env>({
  apiRoute: MCP_ROUTE,
  apiHandler: mcpApiHandler,
  defaultHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      GitHubHandler.fetch(request, env, ctx),
  },

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",

  // Client registration, both ways the MCP spec allows:
  //  - CIMD  : preferred by the spec; needs the global_fetch_strictly_public
  //            compatibility flag or the provider refuses to fetch the document
  //            and advertises client_id_metadata_document_supported: false.
  //  - DCR   : deprecated by the spec but kept for clients that lack CIMD.
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  // [M-4] DCR registrations expire instead of accumulating in KV forever.
  // Kept at the provider's own default (90 days) rather than shortened: the
  // refresh token TTL is 30 days, and a clientRegistrationTTL shorter than
  // that (7 days, as this used to be) lets the `client:<id>` KV record
  // expire while a still-valid refresh token is outstanding, turning an
  // otherwise-normal refresh into `invalid_client` on day 8. 90 days
  // comfortably outlives the refresh token; CIMD clients re-fetch their
  // document on every use and never hit this at all.
  clientRegistrationTTL: 60 * 60 * 24 * 90,

  // MCP requires S256 PKCE. The provider still defaults allowPlainPKCE to true
  // (dist/oauth-provider.js: `allowPlainPKCE !== false ? ["plain","S256"] : ["S256"]`),
  // and treats a missing code_challenge_method as "plain" — so turning this off
  // both drops `plain` from the advertised methods and makes PKCE mandatory.
  allowPlainPKCE: false,

  scopesSupported: [...SCOPES_SUPPORTED],

  // [resource audience symmetry] github-handler.ts's /callback audience
  // completion (search for P1-2/L-7 there) fills in a *bare origin*
  // (`new URL(...).origin`) for clients that omit RFC 8707 `resource`, so
  // those grants end up with an origin-shaped resource. Without this flag,
  // /token's resourceMatches() requires an exact match, so a well-behaved
  // client that later sends the fuller `resource=<origin>/mcp` (matching
  // this server's actual apiRoute) gets `invalid_target` against its own
  // grant. Comparing scheme+host+port only removes that asymmetry.
  resourceMatchOriginOnly: true,

  // `resource` and `authorization_servers` are intentionally left to the
  // provider, which derives them from the request URL: hardcoding them would
  // pin the document to one origin and break either local dev or production.
  resourceMetadata: { resource_name: SERVER_NAME },

  // Every DCR registration, so the logs show which registration path a client
  // used even when it never reaches /authorize. Returning nothing = allow.
  //
  // [M-4] Also the enforcement point for isAllowedRegistrationRedirectUri():
  // the provider itself only blocks a short list of dangerous schemes, so a
  // client could otherwise register a plain-http or arbitrary-scheme
  // redirect_uri and have it accepted at /authorize later.
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

    // [M-2/P1-3] RFC 6750 §3 has the resource server advertise its required
    // scope on a 401 so a well-behaved client can tell "not authenticated"
    // apart from "authenticated but missing the todo scope" without a
    // separate round trip.
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
 * DNS rebinding protection for the MCP endpoint (MCP transports spec MUST).
 *
 * Policy:
 *  - No `Origin` header  -> allowed. MCP clients are CLIs/daemons; they do not
 *    send one, and the header only exists to identify browser-initiated calls.
 *  - `Origin` present    -> must be this host (or a loopback name in local
 *    dev), otherwise 403. That is what stops a page on evil.example from
 *    driving a locally bound MCP server through the victim's browser.
 *
 * Placed ahead of OAuthProvider on purpose: a cross-origin browser request must
 * be refused as forbidden regardless of whether it carries a token, and a
 * transport-level guard that only runs after authentication is not a guard.
 * `agents/mcp/server` applies its own Origin check further in; this one exists
 * so the rejection happens before any credential handling.
 */
function originGuard(request: Request): Response | undefined {
  const url = new URL(request.url);
  // [L-1] Matches the provider's own API-route matching (startsWith), not an
  // exact match: a bare-equality check here would let a cross-origin browser
  // request through for any sub-path under MCP_ROUTE (e.g. `/mcp/`) that the
  // provider itself still treats as the protected API route.
  if (!url.pathname.startsWith(MCP_ROUTE)) return undefined;

  // [production Origin scoping] `localhostAllowedOrigins()` is only a
  // meaningful allowance when this Worker's own hostname is itself a
  // loopback name (`wrangler dev`). Admitting it unconditionally would mean
  // a production deployment — whose hostname is never loopback — still
  // accepted `Origin: http://localhost:...`, letting any page running a
  // local dev server on the visitor's machine pass this guard for an origin
  // this deployment never actually serves from.
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
