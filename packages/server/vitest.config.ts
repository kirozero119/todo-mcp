import { defineConfig } from "vitest/config";

/**
 * `cloudflare:workers` を最小スタブに差し替える Vite プラグイン。
 *
 * `@cloudflare/workers-oauth-provider` の dist は先頭で
 * `import { WorkerEntrypoint } from "cloudflare:workers"` を行う。この
 * モジュールは workerd だけが提供するので node プールでは解決できない。
 * provider が WorkerEntrypoint を使うのは `OAuthProvider` クラスの継承元
 * としてだけで、test/oauth-grants.test.ts が触る `getOAuthApi()` 経路は
 * そのクラスを一度もインスタンス化しない。だから「継承できる空クラス」が
 * あれば足りる。
 *
 * 実ファイルではなく仮想モジュールにしているのは、tsconfig の
 * `types: ["@cloudflare/workers-types"]` の下で絶対パス（= `node:url` の
 * import）を組み立てずに済ませるため。差し替えの事実と理由をこの1ファイルに
 * 閉じ込める狙いもある。
 */
const VIRTUAL_CLOUDFLARE_WORKERS = "\0virtual:cloudflare-workers-stub";

function cloudflareWorkersStub() {
  return {
    name: "cloudflare-workers-stub",
    resolveId(id: string) {
      return id === "cloudflare:workers" ? VIRTUAL_CLOUDFLARE_WORKERS : null;
    },
    load(id: string) {
      return id === VIRTUAL_CLOUDFLARE_WORKERS ? "export class WorkerEntrypoint {}\n" : null;
    },
  };
}

/**
 * Plain Node environment on purpose.
 *
 * The unit tests cover `src/allowlist.ts`, `src/approval.ts`, and
 * `src/github-handler.ts`, none of which import Worker/runtime-only APIs, so
 * no workerd pool is needed. KV, cookies, and fetch are exercised directly in
 * these tests through lightweight stubs (an in-memory `Map`-backed
 * `KVNamespace` in `test/approval.test.ts` / `test/github-handler.test.ts`,
 * and `vi.stubGlobal("fetch", ...)` for the two upstream GitHub calls in
 * `test/github-handler.test.ts`) — `wrangler dev` remains useful for the
 * end-to-end smoke checks documented in the README (real KV, real browser
 * cookies), but is not required to run this suite.
 *
 * [09/複数端末] 例外が1つある。`test/oauth-grants.test.ts` だけは
 * `@cloudflare/workers-oauth-provider` の*実体*を動かす（スタブではなく）。
 * そのために要るのが上の `cloudflareWorkersStub()` と、下の
 * `server.deps.inline` の2点:
 *   - inline に入れないと provider は Vite の変換対象外（externalize されて
 *     node の ESM ローダーが直接読む）になり、プラグインによる
 *     `cloudflare:workers` の差し替えが効かず ERR_MODULE_NOT_FOUND になる
 *   - inline に入れると Vite が dist を処理するので resolveId が効き、
 *     仮想モジュールに解決される
 * ライブラリを上げる ticket 13 でも同じ2点が要る。
 */
export default defineConfig({
  plugins: [cloudflareWorkersStub()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        inline: [/@cloudflare\/workers-oauth-provider/],
      },
    },
  },
});
