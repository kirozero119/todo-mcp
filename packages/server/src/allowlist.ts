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
 * `githubUserId()` の逆。props の `user_id` から数値 ID を復元する。
 *
 * [15] `/mcp` のリクエストごとの allowlist 照合が `isGitHubUserAllowed()` の
 * 第2引数に渡すもの。復元できない形（別 IdP の名前空間、接頭辞なし、非正規な
 * 桁表記、桁あふれ）は `undefined` を返す —— `github:<数値ID>` 形式のエントリと
 * 一致しなくなるだけで、ログイン名エントリでの一致は妨げない（フェイルクローズ）。
 * 詳細は docs/design-notes.md 参照。
 */
export function githubNumericIdFromUserId(userId: string | undefined | null): number | undefined {
  if (!userId) return undefined;
  // props の `user_id` は `githubUserId()` が作るので、allowlist の
  // `github:<数値ID>` エントリとまったく同じ構文になる。だから同じパターンで判定できる。
  const match = GITHUB_ID_ENTRY.exec(userId);
  if (!match) return undefined;
  const numericId = Number(match[1]);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return undefined;
  // 正規形との往復で確認する（`github:007` のような非正規表記をここで落とす）。
  return githubUserId(numericId) === userId ? numericId : undefined;
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
