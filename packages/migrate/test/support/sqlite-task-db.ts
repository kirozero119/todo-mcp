/**
 * 移行の書き込み手順を試すための、in-memory な `TaskDb`。
 *
 * DDL は `packages/core/schema.sql` をそのまま読む（Turso に流したのと同じ文字列）。
 * AUTOINCREMENT と `sqlite_sequence` の挙動まで本物の SQLite が相手なので、
 * 「カウンタを先に上げると id はどうなるか」をモックではなく実物で確かめられる。
 *
 * core の `test/support/sqlite-task-db.ts` と役割は近いが、あちらは core のテスト
 * ツリーにあって `@todo-mcp/core` の公開面に出ていない（migrate から import できない）。
 * こちらは `querySync` を持たず、代わりに移行テストが要る覗き口と故障注入を持つ。
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { TaskDb } from "@todo-mcp/core";

export interface MigrateTestDb extends TaskDb {
  /** `sqlite_sequence(tasks)` の現在値。行が無ければ null。 */
  sequence(): number | null;
  /** 全行を id 昇順で（user_id を含む素の行）。 */
  rows(): Record<string, unknown>[];
}

export function createMigrateTestDb(): MigrateTestDb {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../../core/schema.sql", import.meta.url), "utf8"));

  return {
    all: (sql: string, args: unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[]),
    get: (sql: string, args: unknown[] = []) =>
      Promise.resolve(
        db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined,
      ),
    sequence: () => {
      const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get() as
        | { seq: number }
        | undefined;
      return row === undefined ? null : Number(row.seq);
    },
    rows: () =>
      db.prepare("SELECT * FROM tasks ORDER BY id").all() as unknown as Record<string, unknown>[],
  };
}

/**
 * N 件目より後の tasks への INSERT を失敗させるラッパー。ネットワーク断の代役。
 *
 * `sqlite_sequence` への文はそのまま通す —— 止めたいのは行の書き込みだけで、
 * 「INSERT が途中で落ちたときにカウンタがどうなっているか」を見るのが目的。
 */
export function failTaskInsertsAfter(db: TaskDb, limit: number): TaskDb {
  let seen = 0;
  return {
    all: (sql: string, args?: unknown[]) => {
      if (sql.includes("INSERT INTO tasks")) {
        seen += 1;
        if (seen > limit) return Promise.reject(new Error("ネットワーク断（テストの作り物）"));
      }
      return db.all(sql, args);
    },
    get: (sql: string, args?: unknown[]) => db.get(sql, args),
  };
}

/**
 * tasks への INSERT の特定の列だけを、指定した値に差し替えて書くラッパー。
 *
 * 「変換は正しいのに DB には別の値が入る」（例: created_at が全行 1 年ずれる）を
 * 作り出すためのもの。件数の増分しか見ない検証は、これを素通しする。
 */
export function corruptTaskInsertColumn(
  db: TaskDb,
  column: "created_at" | "title" | "user_id",
  rewrite: (value: unknown) => unknown,
): TaskDb {
  // importTask の VALUES の並び（packages/core/src/tasks.ts の INSERT 文と同じ順）。
  const ORDER = [
    "id",
    "user_id",
    "workspace",
    "project",
    "title",
    "status",
    "due",
    "memo",
    "created_at",
    "updated_at",
    "closed_at",
  ];
  const index = ORDER.indexOf(column);
  return {
    all: (sql: string, args?: unknown[]) => {
      if (sql.includes("INSERT INTO tasks") && args) {
        const next = [...args];
        next[index] = rewrite(next[index]);
        return db.all(sql, next);
      }
      return db.all(sql, args);
    },
    get: (sql: string, args?: unknown[]) => db.get(sql, args),
  };
}
