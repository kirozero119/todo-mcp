/** Constants shared by the AS entry, the consent handler, and the MCP server. */

export const SERVER_NAME = "todo-mcp";
export const SERVER_DESCRIPTION = "Personal todo MCP server. Sign in with GitHub to continue.";
export const SERVER_VERSION = "0.0.1";

/** The MCP endpoint path. Also the OAuthProvider apiRoute. */
export const MCP_ROUTE = "/mcp";

/**
 * Scopes advertised in AS metadata and in the RFC 9728 resource metadata.
 *
 * One scope covering the server's basic functionality, per the spec's guidance
 * that `scopes_supported` is the *minimum set needed for basic functionality*
 * rather than a full catalogue.
 *
 * `offline_access` is deliberately absent: MCP final (Refresh Tokens) says a
 * resource server SHOULD NOT advertise it, because refreshing is a client/AS
 * concern and never a requirement of the resource itself. Refresh tokens still
 * work — workers-oauth-provider issues them on the authorization_code grant.
 */
export const SCOPES_SUPPORTED: readonly string[] = ["todo"];
