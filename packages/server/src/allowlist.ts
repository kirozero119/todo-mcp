/**
 * アクセス制御のプリミティブ群。
 *
 * Worker/ランタイム依存の import を持たない。認可判定を
 * `test/allowlist.test.ts` で直接ユニットテストできるようにするため。
 * ここには I/O を行う処理は一切ない。
 */

/**
 * ALLOWED_GITHUB_USERS（"alice, bob"）を正規化したリストにパースする。
 *
 * GitHub のログイン名は大小文字を区別せず一意なので、比較キーは
 * 小文字化したログイン名にする。
 */
export function parseAllowedGitHubUsers(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** `github:<numeric id>` 形式の ALLOWED_GITHUB_USERS エントリにマッチ。 */
const GITHUB_ID_ENTRY = /^github:(\d+)$/;

/**
 * この GitHub アイデンティティに grant を許可するか。
 *
 * [M-3/P2-1] 二形式・フェイルクローズの経緯は docs/design-notes.md 参照。
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
 * props に保存する namespace 付き識別子。将来的には DB キーにもなる。
 *
 * ログインではなく不変の数値 ID を使う（ログインはリネームされ得る）。
 * `github:` プレフィックスは他の IdP と衝突しないための予約。
 */
export function githubUserId(numericId: number): string {
  assertGitHubNumericId(numericId);
  return `github:${numericId}`;
}

/**
 * OAuthProvider.completeAuthorization() に渡す `userId`。
 *
 * ':' を含んではいけない。理由は docs/design-notes.md 参照
 * （userId のコロン制約）。
 */
export function githubGrantUserId(numericId: number): string {
  assertGitHubNumericId(numericId);
  return `github-${numericId}`;
}

/**
 * 認可リクエストに対して実際に付与するスコープ。
 *
 * provider 自身の downscope() の意味論を踏襲: 空リクエストは
 * 「このサーバーが対応する全スコープ」を意味し、それ以外は対応スコープと
 * の積を取る（クライアントが自分の grant を勝手に広げられないように）。
 */
export function resolveGrantedScopes(
  requested: readonly string[] | undefined,
  supported: readonly string[],
): string[] {
  if (!requested || requested.length === 0) return [...supported];
  return supported.filter((scope) => requested.includes(scope));
}
