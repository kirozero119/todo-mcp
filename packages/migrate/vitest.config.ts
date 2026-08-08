import { defineConfig } from "vitest/config";

/**
 * node 環境。テスト対象は変換（transform.ts）だけ ——
 * 旧 DB の 1 行を Turso の 1 行に写す規則が、チケット 10 の変換表どおりか。
 *
 * 接続・INSERT・sqlite_sequence 側にはテストを書かない。実 DB に触る部分であり、
 * 本当の検証は「dev に流して MCP ツールで読み直す」で行う（本番と同じ経路。
 * モックで再現しても、確かめたいこと——実データが実スキーマに載るか——は分からない）。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
