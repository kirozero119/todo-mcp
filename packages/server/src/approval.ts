/**
 * Consent dialog, CSRF protection, and OAuth state binding.
 *
 * Adapted from the Cloudflare template
 * (cloudflare/ai demos/remote-mcp-github-oauth/src/workers-oauth-utils.ts).
 * workers-oauth-provider itself renders no UI: the defaultHandler owns consent.
 *
 * Ordering that the MCP spec's confused-deputy mitigation requires, and which
 * this file preserves from the template:
 *   GET  /authorize -> only a CSRF cookie is set; nothing is approved yet
 *   POST /authorize -> user pressed Approve; only *now* are the approved-client
 *                      cookie and the consented-state binding issued, and only
 *                      then is the browser forwarded to GitHub
 * i.e. per-client consent is always taken *before* the third-party redirect.
 *
 * Divergence from the template (deliberate): the dialog shows the redirect_uri
 * *from this request* instead of only the client's registered list, and warns
 * on loopback redirect URIs. MCP's CIMD security section makes displaying the
 * redirect URI host a MUST and the loopback warning a SHOULD — and with RFC
 * 8252 loopback port flexibility the requested port is exactly what the
 * registered list cannot show.
 *
 * [M-1/P1-1] The pending authorization request itself never round-trips
 * through the browser. GET /authorize commits the *validated* request to KV
 * under a fresh opaque state token (`approved: false`); the dialog form only
 * ever carries that token. POST /authorize looks the request back up by
 * token and flips it to `approved: true` — it never parses request data out
 * of the form. /callback's validateOAuthState() refuses anything still
 * `approved: false`.
 */
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

const CSRF_COOKIE = "__Host-CSRF_TOKEN";
const CONSENTED_STATE_COOKIE = "__Host-CONSENTED_STATE";
const APPROVED_CLIENTS_COOKIE = "__Host-APPROVED_CLIENTS";
const STATE_TTL_SECONDS = 600;
const APPROVAL_TTL_SECONDS = 30 * 24 * 60 * 60;
/** [L-10] Cap on the approved-clients cookie: a trust list, not an audit log. */
const APPROVED_CLIENTS_MAX_ENTRIES = 10;

/** OAuth 2.1 shaped error that can be turned straight into a response. */
export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({ error: this.code, error_description: this.description }),
      { status: this.statusCode, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------- sanitizing

export function sanitizeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Allows only http/https URLs; everything else (javascript:, data:, …) becomes "". */
export function sanitizeUrl(url: string): string {
  const normalized = url.trim();
  if (normalized.length === 0) return "";
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return "";
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  return scheme === "http" || scheme === "https" ? normalized : "";
}

// ---------------------------------------------------------- base64url helpers

/**
 * [L-3] btoa()/atob() operate on Latin-1 code units and throw a DOMException
 * for any character above U+00FF. The approved-clients cookie payload is a
 * JSON array of `JSON.stringify([clientId, redirectUri])` tuple strings,
 * which can legitimately contain non-Latin-1 text (e.g. a CIMD client_id URL
 * with an internationalized domain), so encoding goes through UTF-8 bytes
 * first.
 * base64url (RFC 4648 §5, no padding) also keeps the cookie value free of
 * `+`, `/`, `=`, which would otherwise need escaping in a Cookie header.
 */
function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// --------------------------------------------------------------------- CSRF

export function generateCSRFProtection(): { token: string; setCookie: string } {
  const token = crypto.randomUUID();
  return {
    token,
    setCookie: `${CSRF_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`,
  };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const hit = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return hit ? hit.substring(name.length + 1) : null;
}

/** RFC 9700 §2.1: CSRF tokens are one-time use, so the cookie is cleared here. */
export function validateCSRFToken(formData: FormData, request: Request): { clearCookie: string } {
  const fromForm = formData.get("csrf_token");
  if (!fromForm || typeof fromForm !== "string") {
    throw new OAuthError("invalid_request", "Missing CSRF token in form data", 400);
  }
  const fromCookie = readCookie(request, CSRF_COOKIE);
  if (!fromCookie) throw new OAuthError("invalid_request", "Missing CSRF token cookie", 400);
  if (fromForm !== fromCookie) throw new OAuthError("invalid_request", "CSRF token mismatch", 400);
  return {
    clearCookie: `${CSRF_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
  };
}

// ------------------------------------------------------------- OAuth state

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** KV-stored shape behind an `oauth:state:<token>` key. */
interface StoredOAuthState {
  oauthReqInfo: AuthRequest;
  /** [M-1/P1-1] Only approveOAuthState() may flip this to true. */
  approved: boolean;
  /**
   * [state ownership] sha256 hex of the CSRF token this state was minted
   * alongside, or `null` for a state created on the GET /authorize
   * preapproved fast path — that path never shows the dialog and so never
   * issues a CSRF cookie/token at all, so there is nothing to pair against.
   * approveOAuthState() treats `null` as "no CSRF pairing required for this
   * state" rather than as a match to be satisfied.
   */
  csrfTokenHash: string | null;
  /**
   * [state lifetime cap] Unix ms timestamp set once at createOAuthState()
   * and never rewritten by approveOAuthState() (which only resets the KV
   * entry's TTL). validateOAuthState() uses this to cap a state's total
   * lifetime at STATE_TTL_SECONDS regardless of how many times its KV TTL
   * gets refreshed in between.
   */
  createdAt: number;
}

/**
 * Stores a not-yet-approved authorization request under a fresh opaque state
 * token. Called once, immediately after parseAuthRequest() validates the
 * request — nothing client-controlled is ever parsed back out of a form
 * field to reconstruct it.
 *
 * [state ownership] `csrfToken`, when given, is hashed and committed here so
 * approveOAuthState() can later verify that whoever is approving this exact
 * state also holds the exact CSRF token it was minted with. Pass `null` (the
 * default) for the GET /authorize preapproved fast path, which never issues
 * a CSRF token in the first place.
 */
export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  csrfToken: string | null = null,
): Promise<{ stateToken: string }> {
  const stateToken = crypto.randomUUID();
  const record: StoredOAuthState = {
    oauthReqInfo,
    approved: false,
    csrfTokenHash: csrfToken ? await sha256Hex(csrfToken) : null,
    createdAt: Date.now(),
  };
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  return { stateToken };
}

/**
 * [M-1/P1-1] Flips a pending state's `approved` flag from false to true and
 * returns the authorization request it guards. This is the *only* place
 * that happens: POST /authorize calls it only after the user has just
 * pressed Approve, and the GET /authorize preapproved fast path calls it
 * only after re-verifying an existing (client, redirect_uri) consent.
 *
 * [state ownership] When the state carries a `csrfTokenHash` (the dialog
 * path), `csrfToken` must hash to it or this throws "State does not belong
 * to this session" — the CSRF cookie/form-field match performed earlier
 * (validateCSRFToken) only proves that pair is internally consistent, not
 * that it belongs to the flow this particular stateToken was minted for. A
 * `csrfTokenHash` of `null` (the preapproved fast path) skips this check
 * entirely; pass `null` for `csrfToken` there.
 */
export async function approveOAuthState(
  stateToken: string,
  kv: KVNamespace,
  csrfToken: string | null = null,
): Promise<AuthRequest> {
  const key = `oauth:state:${stateToken}`;
  const stored = await kv.get(key);
  if (!stored) throw new OAuthError("invalid_request", "Invalid or expired state", 400);

  let record: StoredOAuthState;
  try {
    record = JSON.parse(stored) as StoredOAuthState;
  } catch {
    throw new OAuthError("server_error", "Invalid state data", 500);
  }

  if (record.csrfTokenHash !== null) {
    const providedHash = csrfToken ? await sha256Hex(csrfToken) : null;
    if (providedHash !== record.csrfTokenHash) {
      throw new OAuthError("invalid_request", "State does not belong to this session", 400);
    }
  }

  const approved: StoredOAuthState = { ...record, approved: true };
  await kv.put(key, JSON.stringify(approved), { expirationTtl: STATE_TTL_SECONDS });
  return record.oauthReqInfo;
}

/**
 * [dialog denial] Looks up a pending state by its opaque token and deletes it
 * from KV — without ever flipping `approved`. Called only when the user
 * pressed Cancel/Deny on the consent dialog: the pending authorization
 * request must never become approvable afterwards, and the one-time state
 * token must not be replayable a second time (approve or deny) once denied.
 */
export async function rejectOAuthState(stateToken: string, kv: KVNamespace): Promise<AuthRequest> {
  const key = `oauth:state:${stateToken}`;
  const stored = await kv.get(key);
  if (!stored) throw new OAuthError("invalid_request", "Invalid or expired state", 400);

  let record: StoredOAuthState;
  try {
    record = JSON.parse(stored) as StoredOAuthState;
  } catch {
    throw new OAuthError("server_error", "Invalid state data", 500);
  }

  await kv.delete(key);
  return record.oauthReqInfo;
}

/**
 * Binds the state token to this browser. The cookie holds the *hash* of the
 * token, so a state value leaking through URL logs or a Referer header still
 * cannot be replayed from another browser.
 */
export async function bindStateToSession(stateToken: string): Promise<{ setCookie: string }> {
  const hash = await sha256Hex(stateToken);
  return {
    setCookie: `${CONSENTED_STATE_COOKIE}=${hash}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`,
  };
}

/**
 * Validates the state coming back from GitHub against KV (we created it),
 * the session cookie (this browser consented to it), and the `approved`
 * flag (this server itself marked it approved — see approveOAuthState()).
 */
export async function validateOAuthState(
  request: Request,
  kv: KVNamespace,
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string }> {
  const stateFromQuery = new URL(request.url).searchParams.get("state");
  if (!stateFromQuery) throw new OAuthError("invalid_request", "Missing state parameter", 400);

  const stored = await kv.get(`oauth:state:${stateFromQuery}`);
  if (!stored) throw new OAuthError("invalid_request", "Invalid or expired state", 400);

  const consentedHash = readCookie(request, CONSENTED_STATE_COOKIE);
  if (!consentedHash) {
    throw new OAuthError(
      "invalid_request",
      "Missing session binding cookie - authorization flow must be restarted",
      400,
    );
  }
  if ((await sha256Hex(stateFromQuery)) !== consentedHash) {
    throw new OAuthError(
      "invalid_request",
      "State token does not match session - possible CSRF attack detected",
      400,
    );
  }

  let record: StoredOAuthState;
  try {
    record = JSON.parse(stored) as StoredOAuthState;
  } catch {
    throw new OAuthError("server_error", "Invalid state data", 500);
  }

  // [state lifetime cap] approveOAuthState() resets this record's KV TTL to
  // another full STATE_TTL_SECONDS on approval, so a dialog left open just
  // under that window can otherwise stretch a state's real lifetime to
  // nearly twice STATE_TTL_SECONDS. `createdAt` is fixed at createOAuthState()
  // and never rewritten, so checking it here caps the total lifetime at
  // STATE_TTL_SECONDS regardless of any TTL resets in between.
  if (Date.now() - record.createdAt > STATE_TTL_SECONDS * 1000) {
    await kv.delete(`oauth:state:${stateFromQuery}`);
    throw new OAuthError("invalid_request", "State has expired", 400);
  }

  // [M-1/P1-1] Server-side assert: only a state this server itself flipped to
  // approved (via the dialog POST, or the preapproved fast path) may reach
  // completeAuthorization(). Defense in depth on top of the session-cookie
  // binding above, which already makes this unreachable in the normal flow.
  if (!record.approved) {
    throw new OAuthError("invalid_request", "Authorization was never approved", 400);
  }

  await kv.delete(`oauth:state:${stateFromQuery}`);
  return {
    oauthReqInfo: record.oauthReqInfo,
    clearCookie: `${CONSENTED_STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
  };
}

// -------------------------------------------------- approved-clients cookie

async function importKey(secret: string): Promise<CryptoKey> {
  // [L-9] A blank or short COOKIE_ENCRYPTION_KEY makes the approved-clients
  // cookie's HMAC weak or trivially guessable. Fail loudly at the point of
  // use instead of silently minting a cookie nothing meaningfully protects.
  if (!secret || secret.length < 32) {
    throw new Error("COOKIE_ENCRYPTION_KEY must be set and at least 32 characters long");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signData(data: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySignature(
  data: string,
  signatureHex: string,
  secret: string,
): Promise<boolean> {
  const bytes = signatureHex.match(/../g);
  if (!bytes || bytes.length * 2 !== signatureHex.length) return false;
  const signature = new Uint8Array(bytes.map((byte) => parseInt(byte, 16)));
  return crypto.subtle.verify(
    "HMAC",
    await importKey(secret),
    signature,
    new TextEncoder().encode(data),
  );
}

/** Exported for direct unit testing (test/approval.test.ts); not otherwise part of the public API surface. */
export async function readApprovedClients(request: Request, secret: string): Promise<string[] | null> {
  const cookie = readCookie(request, APPROVED_CLIENTS_COOKIE);
  if (!cookie) return null;
  const separator = cookie.indexOf(".");
  if (separator === -1) return null;
  const signature = cookie.substring(0, separator);
  const payloadB64 = cookie.substring(separator + 1);
  let payload: string;
  try {
    payload = base64UrlDecode(payloadB64);
  } catch {
    return null;
  }
  if (!(await verifySignature(payload, signature, secret))) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

/**
 * [H-1] Consent is keyed by (clientId, redirectUri), not clientId alone: a
 * client that is later handed (via CIMD) or registers a second redirect_uri
 * must get a fresh consent screen for it. The dialog's displayed redirect
 * host is, per MCP's CIMD security guidance, a MUST — consent to one host
 * must not silently cover another.
 *
 * A JSON tuple rather than a `${clientId}|${redirectUri}` join: either field
 * can itself contain `|` (arbitrary URL text), which would let two distinct
 * (clientId, redirectUri) pairs collide onto the same joined string —
 * `JSON.stringify` escapes each element independently, so no such ambiguity
 * is possible.
 */
function approvalKey(clientId: string, redirectUri: string): string {
  return JSON.stringify([clientId, redirectUri]);
}

/** Has this browser already consented to this exact (client, redirect_uri) pair? */
export async function isClientApproved(
  request: Request,
  clientId: string,
  redirectUri: string,
  secret: string,
): Promise<boolean> {
  return (
    (await readApprovedClients(request, secret))?.includes(approvalKey(clientId, redirectUri)) ?? false
  );
}

/**
 * Records consent for one (client, redirect_uri) pair. Called only after the
 * user pressed Approve (or, on the preapproved fast path, only after an
 * earlier Approve already covered this exact pair).
 */
export async function addApprovedClient(
  request: Request,
  clientId: string,
  redirectUri: string,
  secret: string,
): Promise<string> {
  const key = approvalKey(clientId, redirectUri);
  const existing = (await readApprovedClients(request, secret)) || [];
  // [L-10] Keep only the most recently approved entries — a trust list, not
  // an ever-growing audit log. Any existing occurrence of this exact key is
  // dropped before re-appending it, so re-approving a pair moves it to the
  // end (most-recently-approved) instead of leaving it pinned at its
  // original position — `Array.from(new Set(...))` alone does not do this,
  // since Set preserves the position of a key's *first* insertion.
  const trimmed = [...existing.filter((entry) => entry !== key), key].slice(
    -APPROVED_CLIENTS_MAX_ENTRIES,
  );
  const payload = JSON.stringify(trimmed);
  const signature = await signData(payload, secret);
  return `${APPROVED_CLIENTS_COOKIE}=${signature}.${base64UrlEncode(payload)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${APPROVAL_TTL_SECONDS}`;
}

// ------------------------------------------------------------------- dialog

/** 127.0.0.0/8, ::1, or localhost — mirrors the provider's isLoopbackUri(). */
export function isLoopbackRedirectUri(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase();
    return (
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host === "::1" ||
      host === "[::1]" ||
      host === "localhost"
    );
  } catch {
    return false;
  }
}

export interface ApprovalDialogOptions {
  client: ClientInfo | null;
  /** The redirect_uri of *this* request, not the registered list. */
  requestedRedirectUri: string;
  /** True when client_id is a Client ID Metadata Document URL. */
  isCimdClient: boolean;
  server: { name: string; description?: string };
  /**
   * [M-1/P1-1] The opaque state token created by createOAuthState(). The
   * dialog form round-trips only this token — the authorization request
   * itself lives solely in KV, server-side, from the moment
   * parseAuthRequest() validated it.
   */
  stateToken: string;
  csrfToken: string;
  setCookie: string;
}

export function renderApprovalDialog(options: ApprovalDialogOptions): Response {
  const { client, requestedRedirectUri, isCimdClient, server, stateToken, csrfToken, setCookie } =
    options;

  const clientName = client?.clientName ? sanitizeText(client.clientName) : "不明なMCPクライアント";
  const clientId = client?.clientId ? sanitizeText(client.clientId) : "";
  const redirectUri = sanitizeText(sanitizeUrl(requestedRedirectUri));

  let redirectHost = "(解析不可)";
  try {
    redirectHost = sanitizeText(new URL(requestedRedirectUri).host);
  } catch {
    /* keep the placeholder */
  }

  let cimdHost = "";
  if (isCimdClient && client?.clientId) {
    try {
      cimdHost = sanitizeText(new URL(client.clientId).host);
    } catch {
      cimdHost = "";
    }
  }

  const loopbackWarning = isLoopbackRedirectUri(requestedRedirectUri)
    ? `<p class="warn">このクライアントは認可コードを <strong>${redirectHost}</strong>
         （ループバックアドレス）で受け取ります。このマシン上のどのプログラムでもループバックポートを待ち受けられるため、
         たった今あなた自身がこのログインを開始した場合のみ承認してください。</p>`
    : "";

  const cimdNote = cimdHost
    ? `<p class="note">クライアントの身元は <strong>${cimdHost}</strong> が配信する
         Client ID Metadata Document（CIMD）に基づいています。</p>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${clientName} | 認可リクエスト</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; color: #222; line-height: 1.6; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem; box-shadow: 0 8px 36px rgba(0,0,0,.08); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 1rem 0; }
  dt { color: #666; } dd { margin: 0; word-break: break-all; }
  .warn { background: #fff6e5; border-left: 4px solid #f0a000; padding: .75rem 1rem; border-radius: 4px; }
  .note { background: #eef4ff; border-left: 4px solid #0070f3; padding: .75rem 1rem; border-radius: 4px; }
  .actions { display: flex; gap: .75rem; justify-content: flex-end; margin-top: 1.5rem; }
  button { font: inherit; padding: .5rem 1.25rem; border-radius: 6px; cursor: pointer; }
  .approve { background: #0070f3; color: #fff; border: 1px solid #0070f3; }
  .cancel { background: #fff; border: 1px solid #d5d5d5; }
</style></head>
<body><div class="card">
  <h1>${sanitizeText(server.name)}</h1>
  ${server.description ? `<p>${sanitizeText(server.description)}</p>` : ""}
  <p><strong>${clientName}</strong> がアクセスを要求しています。承認すると GitHub のサインイン画面に移動します。</p>
  <dl>
    <dt>クライアントID</dt><dd>${clientId || "(なし)"}</dd>
    <dt>リダイレクト先</dt><dd>${redirectUri || "(無効な redirect_uri)"}</dd>
  </dl>
  ${cimdNote}
  ${loopbackWarning}
  <form method="post" action="">
    <input type="hidden" name="csrf_token" value="${sanitizeText(csrfToken)}">
    <input type="hidden" name="state" value="${sanitizeText(stateToken)}">
    <div class="actions">
      <button type="submit" name="decision" value="deny" class="cancel">キャンセル</button>
      <button type="submit" name="decision" value="approve" class="approve">承認する</button>
    </div>
  </form>
</div></body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie,
      // [L-2] This page's content depends on per-request/per-session state
      // (the client, the redirect_uri, the CSRF cookie) and must never be
      // served from a shared cache.
      "Cache-Control": "no-store",
      // [dialog hardening] This page renders client-supplied text
      // (clientName, clientId, the requested redirect_uri) that
      // sanitizeText()/sanitizeUrl() already escape; CSP is the second layer
      // of defense in depth in case a future edit introduces an unescaped
      // interpolation. `default-src 'none'` blocks everything by default;
      // `style-src 'unsafe-inline'` is required for this page's own inline
      // `<style>` block.
      //
      // Deliberately no `form-action` directive. Chrome checks form-action
      // against *every* hop of the post-submit redirect chain, not just the
      // form's immediate action target: POST /authorize (self) -> 302
      // https://github.com/login/oauth/authorize -> ... -> 302 /callback ->
      // 302 to the MCP client's own redirect_uri, which for a loopback CLI
      // client is an *arbitrary, per-run port* (RFC 8252) and for a CIMD
      // client can be an arbitrary https origin entirely outside this
      // server's control. An allowlist naming this origin plus
      // https://github.com still gets blocked on that final hop, because the
      // client's redirect_uri is neither. There is no fixed allowlist that
      // covers a redirect target this server cannot predict, so no
      // form-action directive can be correct here — this was observed
      // breaking the Approve flow twice against a real browser (Chrome)
      // driving the Claude Code OAuth login; curl and unit tests never
      // exercise browser-side redirect-chain enforcement, so neither caught
      // it. Defense here instead rests on `default-src 'none'` plus
      // sanitizing every value interpolated into this page.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
