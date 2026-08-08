import { defineConfig } from "vitest/config";

/**
 * node 環境。クエリ関数の検証には `node:sqlite` の in-memory DB を使う。
 *
 * モックではなく本物の SQLite を相手にするのは、ここで守りたいのが
 * 「関数が正しい SQL 文字列を組み立てたか」ではなく「その SQL が他人の行を
 * 1 行も返さない・書き換えないか」だから。文字列一致のモックでは
 * WHERE 句の抜けを検出できない。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
