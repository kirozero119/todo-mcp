import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { TaskDb } from "../../src/db";

export interface InMemoryTaskDb extends TaskDb {
  /**
   * Promise を挟まずに 1 行読む。テストが下記「同期実行」の性質を直接確かめるための口。
   *
   * 本番の TaskDb（Turso）にはこのメソッドが無いので、プロダクションコードからは
   * 使えない（`TaskDb` 型で受け取る限り見えない）。
   */
  querySync(sql: string, args?: unknown[]): Record<string, unknown> | undefined;
}

/**
 * `node:sqlite` の in-memory DB を TaskDb の形にしたもの。
 *
 * DDL は packages/core/schema.sql をそのまま読む。Turso に流したのと同じ文字列を
 * 使うので、列名や型がコード側とずれたらテストが落ちる（スキーマのコピーを
 * テスト内に書き写すと、この検出力がなくなる）。
 *
 * **依存されている性質（同期実行）**: `all()` / `get()` は `DatabaseSync` を使うため、
 * Promise を返す前に文の実行が終わっている（`Promise.resolve(<実行済みの結果>)`）。
 * tasks.test.ts の同時実行テストはこの性質に依存している —— `Promise.all` で
 * 並べた 2 本の completeTask が「両方の UPDATE が、どちらの結果も読まれるより先に
 * 逐次実行される」形に決定的になり、read-then-write レースを再現できるのはこのため。
 *
 * ここを本物の非同期 DB（実 libsql など）に差し替えると、その同時実行テストは
 * **落ちるのではなく無意味になる**（インターリーブが変わり、実装が壊れていても
 * winners=1 が偶然成立しうる）。それを検知するために、この性質自体を固定する
 * テストが tasks.test.ts にある（`querySync` を使う「ハーネスの前提」テスト）。
 * 差し替えるときは、そのテストが落ちることを見てから同時実行テストを設計し直すこと。
 */
export function createInMemoryTaskDb(): InMemoryTaskDb {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));

  return {
    all: (sql: string, args: unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[]),
    get: (sql: string, args: unknown[] = []) =>
      Promise.resolve(
        db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined,
      ),
    querySync: (sql: string, args: unknown[] = []) =>
      db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined,
  };
}
