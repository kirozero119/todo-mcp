import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { TaskDb } from "../../src/db";

/**
 * `node:sqlite` の in-memory DB を TaskDb の形にしたもの。
 *
 * DDL は packages/core/schema.sql をそのまま読む。Turso に流したのと同じ文字列を
 * 使うので、列名や型がコード側とずれたらテストが落ちる（スキーマのコピーを
 * テスト内に書き写すと、この検出力がなくなる）。
 */
export function createInMemoryTaskDb(): TaskDb {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));

  return {
    all: (sql: string, args: unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[]),
    get: (sql: string, args: unknown[] = []) =>
      Promise.resolve(
        db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined,
      ),
  };
}
