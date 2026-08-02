/**
 * Registration/authorization-time redirect_uri policy.
 *
 * Shared between DCR registration (`index.ts`'s `clientRegistrationCallback`)
 * and GET /authorize (`github-handler.ts`) so the policy applies uniformly to
 * both ways a client reaches this server: a Client ID Metadata Document
 * (CIMD) client's `redirect_uris` come from a document this server fetched at
 * `/authorize` time and never pass through `clientRegistrationCallback` at
 * all, so enforcing the policy only at DCR registration would leave CIMD
 * clients unchecked.
 */
import { isLoopbackRedirectUri } from "./approval";

/**
 * [M-4] The provider's own DCR only blocks a handful of dangerous URI schemes
 * (javascript:, data:, file:, ...) and otherwise accepts any redirect_uri,
 * including plain (non-loopback) http and arbitrary custom schemes. This
 * narrows registration to what MCP clients actually need: https for real
 * deployments, or loopback http for local CLIs (RFC 8252 §7.3).
 */
export function isAllowedRegistrationRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLoopbackRedirectUri(uri);
}
