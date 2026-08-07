/**
 * 同意画面、CSRF 対策、OAuth state の束縛。
 *
 * Cloudflare 公式テンプレート（cloudflare/ai の
 * demos/remote-mcp-github-oauth/src/workers-oauth-utils.ts）を土台にしている。
 * workers-oauth-provider 自体は UI を描画せず、defaultHandler 側が同意画面を持つ。
 *
 * MCP の confused-deputy 対策が要求する順序（テンプレートから継承）:
 *   GET  /authorize -> CSRF cookie を発行するだけで、まだ何も承認しない
 *   POST /authorize -> Approve が押された後で初めて approved-client cookie と
 *                      state 紐付けを発行し、そのときだけ GitHub へ転送する
 * つまりサードパーティへのリダイレクト前に必ず同意を取る。
 *
 * テンプレートからの意図的な改変、[M-1/P1-1] の state 不透明トークン化と
 * 所有者束縛の詳細は docs/design-notes.md 参照。
 */
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

const CSRF_COOKIE = "__Host-CSRF_TOKEN";
const CONSENTED_STATE_COOKIE = "__Host-CONSENTED_STATE";
const APPROVED_CLIENTS_COOKIE = "__Host-APPROVED_CLIENTS";
const STATE_TTL_SECONDS = 600;
const APPROVAL_TTL_SECONDS = 30 * 24 * 60 * 60;
/** [L-10] approved-clients cookie の件数上限。詳細は docs/design-notes.md 参照。 */
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

// ---------------------------------------------------------------- サニタイズ

export function sanitizeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** http/https の URL のみ許可。それ以外（javascript:, data:, …）は "" にする。 */
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

// ---------------------------------------------------------- base64url ヘルパー

/**
 * [L-3] btoa()/atob() は Latin-1 しか扱えないため、一度 UTF-8 バイト列を
 * 経由してからエンコードする（base64url、RFC 4648 §5、パディングなし）。
 * 経緯は docs/design-notes.md 参照。
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

/** RFC 9700 §2.1: CSRF トークンはワンタイムなのでここで cookie を消す。 */
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

// ------------------------------------------------------------- OAuth の state

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** `oauth:state:<token>` キーの KV 保存形状。 */
interface StoredOAuthState {
  oauthReqInfo: AuthRequest;
  /** [M-1/P1-1] approveOAuthState() だけがこれを true にできる。 */
  approved: boolean;
  /**
   * [state ownership] この state を発行したときの CSRF トークンの sha256。
   * プレアプルーブ経路（CSRF を発行しない）では `null`。詳細は
   * docs/design-notes.md 参照。
   */
  csrfTokenHash: string | null;
  /**
   * [state lifetime cap] state 全体の生存期間の上限を計算するための
   * 作成時刻（一度だけ記録、以後書き換えない）。詳細は
   * docs/design-notes.md 参照。
   */
  createdAt: number;
}

/**
 * 未承認の認可リクエストを、新しい不透明な state トークンの下に KV へ保存する。
 * parseAuthRequest() がリクエストを検証した直後に一度だけ呼ぶ。
 *
 * [state ownership] `csrfToken` を渡すとハッシュ化して一緒に刻む。詳細は
 * docs/design-notes.md 参照。
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
 * [M-1/P1-1] 保留中の state の `approved` を false から true に変え、それが
 * 保護している認可リクエストを返す。これを行うのはここだけ。
 *
 * [state ownership] state が `csrfTokenHash` を持つ場合、`csrfToken` が
 * それにハッシュ一致しなければ拒否する。詳細は docs/design-notes.md 参照。
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
 * [dialog denial] 保留中の state を KV から削除する（`approved` は変えない）。
 * ユーザーが同意画面で Cancel/Deny を押したときだけ呼ぶ。詳細は
 * docs/design-notes.md 参照。
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
 * state トークンをこのブラウザに束縛する。cookie にはトークンの*ハッシュ*だけを
 * 持たせるので、URL ログや Referer 経由で state 値が漏れても、別ブラウザから
 * 再利用できない。
 */
export async function bindStateToSession(stateToken: string): Promise<{ setCookie: string }> {
  const hash = await sha256Hex(stateToken);
  return {
    setCookie: `${CONSENTED_STATE_COOKIE}=${hash}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`,
  };
}

/**
 * GitHub から返ってきた state を、KV（自分で作った）・セッション cookie
 * （このブラウザが同意した）・`approved` フラグ（自分で承認した）の3点で検証する。
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

  // [state lifetime cap] createdAt を基準に生存期間を STATE_TTL_SECONDS に
  // 固定する。経緯は docs/design-notes.md 参照。
  if (Date.now() - record.createdAt > STATE_TTL_SECONDS * 1000) {
    await kv.delete(`oauth:state:${stateFromQuery}`);
    throw new OAuthError("invalid_request", "State has expired", 400);
  }

  // [M-1/P1-1] サーバー側での多層防御アサート: 自分自身が承認した state だけが
  // completeAuthorization() に到達できる。
  if (!record.approved) {
    throw new OAuthError("invalid_request", "Authorization was never approved", 400);
  }

  await kv.delete(`oauth:state:${stateFromQuery}`);
  return {
    oauthReqInfo: record.oauthReqInfo,
    clearCookie: `${CONSENTED_STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
  };
}

// -------------------------------------------------- 承認済みクライアント cookie

async function importKey(secret: string): Promise<CryptoKey> {
  // [L-9] COOKIE_ENCRYPTION_KEY が短いと HMAC が弱くなるため使用箇所で
  // 即座に失敗させる。経緯は docs/design-notes.md 参照。
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

/** ユニットテスト（test/approval.test.ts）向けに export。公開 API の一部ではない。 */
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
 * [H-1] 同意は (clientId, redirectUri) のペア単位で管理する（clientId 単独ではない）。
 * JSON タプルにする理由も含め、経緯は docs/design-notes.md 参照。
 */
function approvalKey(clientId: string, redirectUri: string): string {
  return JSON.stringify([clientId, redirectUri]);
}

/** このブラウザは、この (client, redirect_uri) ペアに既に同意済みか？ */
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
 * (client, redirect_uri) ペアへの同意を記録する。ユーザーが Approve を
 * 押した後（またはプレアプルーブ経路で既に同意済みと確認できた後）にだけ呼ぶ。
 */
export async function addApprovedClient(
  request: Request,
  clientId: string,
  redirectUri: string,
  secret: string,
): Promise<string> {
  const key = approvalKey(clientId, redirectUri);
  const existing = (await readApprovedClients(request, secret)) || [];
  // [L-10] 直近承認分だけを保持する信頼リスト。詳細は docs/design-notes.md 参照。
  const trimmed = [...existing.filter((entry) => entry !== key), key].slice(
    -APPROVED_CLIENTS_MAX_ENTRIES,
  );
  const payload = JSON.stringify(trimmed);
  const signature = await signData(payload, secret);
  return `${APPROVED_CLIENTS_COOKIE}=${signature}.${base64UrlEncode(payload)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${APPROVAL_TTL_SECONDS}`;
}

// ------------------------------------------------------------------- ダイアログ

/** 127.0.0.0/8、::1、localhost — provider の isLoopbackUri() を踏襲。 */
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
  /** 登録済みリストではなく、*この*リクエストの redirect_uri。 */
  requestedRedirectUri: string;
  /** client_id が Client ID Metadata Document の URL なら true。 */
  isCimdClient: boolean;
  server: { name: string; description?: string };
  /**
   * [M-1/P1-1] createOAuthState() が発行した不透明な state トークン。
   * 詳細は docs/design-notes.md 参照。
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
    /* プレースホルダーのまま維持 */
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
      // [L-2] このページはリクエスト/セッション固有の状態に依存するため
      // 共有キャッシュから配信してはならない。詳細は docs/design-notes.md 参照。
      "Cache-Control": "no-store",
      // [dialog hardening] クライアント由来の文字列は sanitizeText()/
      // sanitizeUrl() で既にエスケープ済み。CSP は将来のエスケープ漏れに
      // 備えた第二層の防御。`form-action` を持たせない理由（リダイレクト
      // チェーンの検査で実ブラウザの Approve フローを2回壊した経緯）は
      // docs/design-notes.md 参照。
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
