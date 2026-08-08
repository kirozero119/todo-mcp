import { defineConfig } from "vitest/config";

/**
 * node 環境。テスト対象は 3 つ。
 *
 * - `transform.ts` — 旧 DB の 1 行を Turso の 1 行に写す規則が、チケット 10 の変換表どおりか
 * - `cli.ts`       — 誤って本番に書くのを止めるガード（--target とホスト名の照合、
 *                    モードの必須化、--user-id の形式、--only-open の必須化）
 * - `execute.ts`   — 書き込みの順番（カウンタ先行）と、投入後の値レベル検証
 *
 * 以前ここには「接続・INSERT・sqlite_sequence 側にはテストを書かない。実 DB に触る
 * 部分だから」と書いてあったが、その理由は上の 3 つには当てはまらなかった ——
 * `cli.ts` は純粋関数で DB に触らず、`execute.ts` は `TaskDb` を引数で受けるので
 * `node:sqlite` の in-memory DB を渡せる（core と同じ手）。実 DB でしか確かめられないのは
 * **資格情報と Turso への通信**だけで、そこは今も dev に実際に流して確認している。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
