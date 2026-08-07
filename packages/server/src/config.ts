/** AS のエントリ、consent ハンドラ、MCP サーバーで共有する定数。 */

export const SERVER_NAME = "todo-mcp";
export const SERVER_DESCRIPTION = "個人用 Todo MCP サーバー。続行するには GitHub でサインインしてください。";
export const SERVER_VERSION = "0.0.1";

/** MCP エンドポイントのパス。OAuthProvider の apiRoute でもある。 */
export const MCP_ROUTE = "/mcp";

/**
 * AS メタデータおよび RFC 9728 リソースメタデータで advertise するスコープ。
 *
 * `todo` の1スコープのみ。`offline_access` を含めない理由は
 * docs/design-notes.md 参照。
 */
export const SCOPES_SUPPORTED: readonly string[] = ["todo"];
