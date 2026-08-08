/**
 * Worker の環境変数から Turso 接続設定を取り出す。
 *
 * DB は dev / prod で完全に別（`todo-mcp-dev` / `todo-mcp-prod`）。本番 URL は
 * 既に複数マシンから実運用されているので、開発中の書き込みで汚さないための分離。
 * どちらを向くかはこの 2 つの環境変数だけで決まり、コードには URL を持たない。
 */
import type { TursoConfig } from "@todo-mcp/core";

import type { Env } from "./types";

/**
 * 設定が揃っていれば返す。欠けていれば undefined。
 *
 * 欠けたまま既定値で動かしたりしない。「DB に繋がらないが 200 を返す Todo
 * サーバー」は、タスクが 0 件あるのと見分けがつかず、モデルが「何もない」と
 * 人間に報告してしまう。呼び出し側（mcp.ts の tursoOpener）は、DB に触る
 * ツールが呼ばれた時点で例外を投げて明示的に失敗させる。whoami / tools/list
 * はこの例外を経由しないため生存する（詳細は docs/design-notes.md）。
 */
export function tursoConfigFromEnv(env: Partial<Env>): TursoConfig | undefined {
  const url = env.TURSO_DATABASE_URL?.trim();
  const authToken = env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) return undefined;
  return { url, authToken };
}
