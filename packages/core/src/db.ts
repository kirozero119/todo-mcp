/**
 * Turso 接続の生成と、クエリ関数が要求する最小の DB 面。
 */
import { connect } from "@tursodatabase/serverless";

export interface TursoConfig {
  /** `libsql://<db>-<org>.<region>.turso.io`。クライアント側で https:// に読み替えられる。 */
  url: string;
  authToken: string;
}

/**
 * クエリ関数が使う操作だけを並べた面。
 *
 * `@tursodatabase/serverless` の Connection をそのまま代入できる形にしてある。
 * こう切っておくと、テストが `node:sqlite` の in-memory DB を同じ形で渡せる
 * ——Turso をモックせずに、本物の SQLite に対して SQL の正しさを検証できる。
 *
 * 書き込みも `all()` だけで足りる。INSERT / UPDATE をすべて `RETURNING` 付きで
 * 書いているためで、書いた行をもう一度 SELECT し直す往復（Workers→Turso の
 * ネットワーク 1 往復）が丸ごと不要になる。
 */
export interface TaskDb {
  all(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  get(sql: string, args?: unknown[]): Promise<Record<string, unknown> | undefined>;
}

/**
 * Turso への接続を 1 本作る。
 *
 * Workers にはコネクションプールがないので、これはリクエストごとに呼ぶ想定。
 * `connect()` 自体は設定オブジェクトを作るだけで I/O をしない（最初のクエリまで
 * 通信は起きず、TCP/TLS は fetch 側が使い回す）ので、都度生成のコストは無視できる。
 *
 * 接続は 1 本につき 1 文ずつ直列化される。ツール 1 回の呼び出し（例: SELECT →
 * UPDATE）は順序が意味を持つので、同じ接続を使い回すのが正しい。
 */
export function createTaskDb(config: TursoConfig): TaskDb {
  return connect({ url: config.url, authToken: config.authToken });
}
