-- todo-mcp の唯一のテーブル定義。wayfinder チケット 03「確定 DDL」を verbatim で置いたもの。
--
-- 適用先は Turso の todo-mcp-dev / todo-mcp-prod の 2 本（開発中の書き込みで
-- 実運用中の本番を汚さないため）。適用は:
--   turso db shell todo-mcp-dev < packages/core/schema.sql
--
-- sqlite_sequence を旧 DB の最終 id（149）に合わせる初期化はここには入れない。
-- 旧 todos.db からの移行はチケット 10 の仕事であり、そこで id を保持したまま
-- INSERT する手順とセットで初めて意味を持つため。
CREATE TABLE tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,                -- 'github:<数値id>' 名前空間付き
    workspace  TEXT NOT NULL,                -- 'work' | 'life'（Zod enum で検証）
    project    TEXT,                         -- 自由ラベル（旧 category の後継）
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'todo', -- todo/in_progress/waiting/someday/done/cancelled
    due        TEXT,                         -- YYYY-MM-DD
    memo       TEXT,
    created_at TEXT NOT NULL,                -- ISO 8601 UTC
    updated_at TEXT NOT NULL,
    closed_at  TEXT                          -- done/cancelled になった時刻
);
CREATE INDEX idx_tasks_lens ON tasks(user_id, workspace, status);
