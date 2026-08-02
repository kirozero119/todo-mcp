import { defineConfig } from "vitest/config";

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
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
