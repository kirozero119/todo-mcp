import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Worker のバインディング一覧。
 *
 * OAUTH_KV / OAUTH_PROVIDER 以外はすべてシークレット:
 * - ローカル: packages/server/.dev.vars（リポジトリルートの .dev.vars へのシンボリックリンク）
 * - 本番: `wrangler secret put <NAME>`（README 参照）
 */
export interface Env {
  /** grant・トークン・DCR クライアント・短命な OAuth state レコードを保持。 */
  OAUTH_KV: KVNamespace;

  /** GitHub OAuth App（この Worker は GitHub に対しては OAuth *クライアント*）。 */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  /** 「このブラウザが承認済みのクライアント」cookie の署名用 HMAC キー。 */
  COOKIE_ENCRYPTION_KEY: string;

  /**
   * grant を取得できる GitHub ログイン名のカンマ区切りリスト。
   * 未設定・空は「誰も許可しない」（意図的なフェイルクローズ）。
   */
  ALLOWED_GITHUB_USERS?: string;

  /** ハンドラ呼び出し前に OAuthProvider が注入する。 */
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * アプリケーション props。workers-oauth-provider によってアクセストークンに
 * 暗号化され、認証済み /mcp リクエストのたびに `ctx.props` に復号され、
 * ツール内では `getMcpAuthContext().props` で読める。
 *
 * upstream の GitHub アクセストークンは意図的に持たない。理由は
 * docs/design-notes.md 参照。
 */
export type Props = {
  /** 認可時点の GitHub ログイン名。表示専用（ログインはリネームされ得る）。 */
  login: string;
  /** 安定した namespace 付き識別子: `github:<数値ID>`。将来の DB キー。 */
  user_id: string;
  /**
   * [scope enforcement] このトークンに実際に付与されたスコープ。
   * 強制ポイントの詳細は docs/design-notes.md 参照。
   */
  scopes: string[];
};
