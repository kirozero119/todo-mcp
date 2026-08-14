/**
 * [09/複数端末] このファイルだけは `@cloudflare/workers-oauth-provider` の
 * *実体*を動かす（他のテストが使う `oauthProviderStub()` ではない）。
 *
 * 理由: 本番で壊れていたのは「ライブラリが `revokeExistingGrants` をどう
 * 扱うか」そのものだった。呼び出し側が渡した引数だけを見るテストは、
 * ライブラリがフラグを無視するようになっても同じように通ってしまう。
 * プロパティの*改名*は型が捕まえるが、*意味の変更*は捕まえない。
 * ライブラリを上げる ticket 13 で効くのはこちらのテスト。
 *
 * 実ライブラリを node プールで動かすのに要った2点（`cloudflare:workers` の
 * 仮想モジュール差し替えと `server.deps.inline`）は vitest.config.ts 側に
 * 理由付きで書いてある。
 */
import type {
  AuthRequest,
  OAuthHelpers,
  OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { CimdFetchError, getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import { approveOAuthState, bindStateToSession, createOAuthState } from "../src/approval";
import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME } from "../src/config";
import { GitHubHandler } from "../src/github-handler";
import type { Env } from "../src/types";

/** [L-9] importKey() rejects any secret shorter than 32 chars. */
const SECRET = "s".repeat(32);

const ctxStub = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Claude Code が全端末で名乗る、ビルド定数としての client_id。 */
const CIMD_CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const LOOPBACK_REDIRECT_URI = "http://127.0.0.1:33418/callback";

/** 3台とも同じ GitHub アカウント = 同じ userId。 */
const GITHUB_IDENTITY = { login: "octocat", id: 1 };
/** provider が KV キーに使う userId（allowlist.ts の githubGrantUserId と同形）。 */
const GRANT_USER_ID = "github-1";

interface KvStub {
  kv: KVNamespace;
  /** provider が実際に KV へ書いた `grant:` キー。 */
  grantKeys: () => string[];
  read: (key: string) => unknown;
}

/**
 * 他のテストファイルのローカル `kvStub()` に対して2点だけ足りない:
 *  - `get(key, { type: "json" })` — listUserGrants() / revokeGrant() が使う
 *  - `list({ prefix })` — 既定の revoke 経路と grant の数え上げが使う
 * どちらも実ライブラリを走らせると必要になるので、ここでは持たせる。
 */
function kvStub(): KvStub {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string, options?: { type?: string }) => {
      const raw = store.get(key) ?? null;
      if (raw === null) return null;
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (options?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  };
  return {
    kv: kv as unknown as KVNamespace,
    grantKeys: () => [...store.keys()].filter((key) => key.startsWith("grant:")),
    read: (key: string) => {
      const raw = store.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}

/** index.ts の OAuthProvider 設定のうち、CIMD 解決と grant 生成に効く部分。 */
function providerOptions(): OAuthProviderOptions<{ OAUTH_KV: KVNamespace }> {
  const unusedHandler = { fetch: async () => new Response("unused in these tests") };
  return {
    apiRoute: MCP_ROUTE,
    apiHandler: unusedHandler,
    defaultHandler: unusedHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    scopesSupported: [...SCOPES_SUPPORTED],
    resourceMatchOriginOnly: true,
    resourceMetadata: {
      resource_name: SERVER_NAME,
      scopes_supported: [...SCOPES_SUPPORTED],
    },
  } as OAuthProviderOptions<{ OAUTH_KV: KVNamespace }>;
}

function realProvider(kv: KVNamespace): OAuthHelpers {
  return getOAuthApi(providerOptions(), { OAUTH_KV: kv });
}

/**
 * GitHub の2エンドポイントに加えて CIMD メタデータ文書も返す fetch スタブ。
 * CIMD 経路では provider 自身が client_id の URL を取りに行く。
 */
function stubUpstreamFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gh-upstream-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("https://api.github.com/user")) {
        return new Response(JSON.stringify(GITHUB_IDENTITY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === CIMD_CLIENT_ID) {
        return new Response(
          JSON.stringify({
            client_id: CIMD_CLIENT_ID,
            client_name: "Claude Code",
            redirect_uris: [LOOPBACK_REDIRECT_URI],
            token_endpoint_auth_method: "none",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

/**
 * CIMD の解決には SSRF 対策の互換フラグが要る（provider 側でチェックされる）。
 * wrangler の compatibility_flags で本番に立てているのと同じフラグ。
 */
function stubCompatibilityFlags(): void {
  vi.stubGlobal("Cloudflare", { compatibilityFlags: { global_fetch_strictly_public: true } });
}

function authRequest(clientId: string): AuthRequest {
  return {
    responseType: "code",
    clientId,
    redirectUri: LOOPBACK_REDIRECT_URI,
    scope: [],
    state: "client-state",
    codeChallenge: "c".repeat(43),
    codeChallengeMethod: "S256",
  };
}

/**
 * 1台のマシンが認可を完了するところまでを丸ごと走らせる。/callback は実物の
 * completeAuthorization() を呼ぶので、grant は本当に KV に書かれる。
 */
async function authorizeOneMachine(
  clientId: string,
  kvStore: KvStub,
  provider: OAuthHelpers,
): Promise<Response> {
  const { stateToken } = await createOAuthState(authRequest(clientId), kvStore.kv);
  await approveOAuthState(stateToken, kvStore.kv);
  const { setCookie } = await bindStateToSession(stateToken);

  const env: Env = {
    OAUTH_KV: kvStore.kv,
    GITHUB_CLIENT_ID: "gh-client-id",
    GITHUB_CLIENT_SECRET: "gh-client-secret",
    COOKIE_ENCRYPTION_KEY: SECRET,
    ALLOWED_GITHUB_USERS: GITHUB_IDENTITY.login,
    OAUTH_PROVIDER: provider,
  };

  const request = new Request(
    `http://localhost:8788/callback?code=upstream-code&state=${stateToken}`,
    { headers: { Cookie: setCookie.split(";")[0]! } },
  );
  return GitHubHandler.fetch(request, env, ctxStub);
}

/** DCR クライアントを1つ登録し、provider が発番した client_id を返す。 */
async function registerDcrClient(provider: OAuthHelpers): Promise<string> {
  const client = await provider.createClient({
    redirectUris: [LOOPBACK_REDIRECT_URI],
    clientName: "some-dcr-client",
    tokenEndpointAuthMethod: "none",
  });
  return client.clientId;
}

describe("[09/複数端末] 実ライブラリに対する grant の共存", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // このテスト自体が「スタブではない」ことの担保。oauthProviderStub() は KV に
  // 何も書かず固定の redirectTo を返すだけなので、以下の3点はどれも通らない。
  it("実ライブラリが動いている（生成物が provider 由来の形をしている）", async () => {
    stubUpstreamFetch();
    stubCompatibilityFlags();
    const store = kvStub();
    const provider = realProvider(store.kv);

    // vi.fn() で差し替えられていない、ライブラリ本体のメソッドであること。
    expect(vi.isMockFunction(provider.completeAuthorization)).toBe(false);

    const response = await authorizeOneMachine(CIMD_CLIENT_ID, store, provider);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("Location")!).searchParams.get("iss")).toBe(
      "http://localhost:8788",
    );

    // 1) 認可コードは provider のトークン形式 `userId:grantId:secret`。
    const code = new URL(response.headers.get("Location")!).searchParams.get("code")!;
    const [userId, grantId, secret] = code.split(":");
    expect(userId).toBe(GRANT_USER_ID);
    expect(secret).toBeTruthy();

    // 2) grant はライブラリ自身のキー形式で KV に実在する。
    expect(store.grantKeys()).toEqual([`grant:${userId}:${grantId}`]);

    // 3) props はライブラリが暗号化して載せている（平文では入っていない）。
    const grant = store.read(`grant:${userId}:${grantId}`) as {
      clientId: string;
      encryptedProps: string;
    };
    expect(grant.clientId).toBe(CIMD_CLIENT_ID);
    expect(typeof grant.encryptedProps).toBe("string");
    expect(grant.encryptedProps).not.toContain(GITHUB_IDENTITY.login);
  });

  // ライブラリのフラグ解釈そのものの契約。ticket 13 でバージョンを上げたとき、
  // 意味が変わっていればここが落ちる（改名なら型が先に落ちる）。
  describe("provider の completeAuthorization() 単体", () => {
    async function completeAuthorizationTimes(
      count: number,
      revokeExistingGrants: boolean | undefined,
    ): Promise<KvStub> {
      const store = kvStub();
      const provider = realProvider(store.kv);
      const clientId = await registerDcrClient(provider);
      for (let i = 0; i < count; i++) {
        await provider.completeAuthorization({
          request: authRequest(clientId),
          userId: GRANT_USER_ID,
          metadata: { label: GITHUB_IDENTITY.login },
          scope: [...SCOPES_SUPPORTED],
          props: { login: GITHUB_IDENTITY.login },
          ...(revokeExistingGrants === undefined ? {} : { revokeExistingGrants }),
        });
      }
      return store;
    }

    it("revokeExistingGrants: false なら同一 userId+clientId で 3 本共存する", async () => {
      const store = await completeAuthorizationTimes(3, false);

      expect(store.grantKeys()).toHaveLength(3);
    });

    it("オプション省略時は既定の revoke が効いて 1 本に潰れる", async () => {
      const store = await completeAuthorizationTimes(3, undefined);

      expect(store.grantKeys()).toHaveLength(1);
    });
  });

  // 上の契約を、ハンドラが登録経路で分岐した結果と結びつける。
  describe("/callback を 3 回（= 3台）通したとき", () => {
    it("CIMD クライアントでは 3 台分の grant が残る", async () => {
      stubUpstreamFetch();
      stubCompatibilityFlags();
      const store = kvStub();
      const provider = realProvider(store.kv);

      for (let machine = 0; machine < 3; machine++) {
        const response = await authorizeOneMachine(CIMD_CLIENT_ID, store, provider);
        expect(response.status).toBe(302);
      }

      expect(store.grantKeys()).toHaveLength(3);
    });

    it("DCR クライアントでは既定の revoke が効いたままで 1 本になる", async () => {
      stubUpstreamFetch();
      const store = kvStub();
      const provider = realProvider(store.kv);
      const clientId = await registerDcrClient(provider);

      for (let machine = 0; machine < 3; machine++) {
        const response = await authorizeOneMachine(clientId, store, provider);
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get("Location")!).searchParams.get("iss")).toBe(
          "http://localhost:8788",
        );
      }

      expect(store.grantKeys()).toHaveLength(1);
    });
  });
});

describe("[13] workers-oauth-provider v0.10.2 の境界契約", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function authorizationRequestUrl(clientId: string, withPkce = false, resource?: string): string {
    const url = new URL("http://localhost:8788/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", LOOPBACK_REDIRECT_URI);
    if (withPkce) {
      url.searchParams.set("code_challenge", "c".repeat(43));
      url.searchParams.set("code_challenge_method", "S256");
    }
    if (resource) url.searchParams.set("resource", resource);
    return url.href;
  }

  it("公開クライアントの PKCE 省略を provider 自身が拒否する", async () => {
    const store = kvStub();
    const provider = realProvider(store.kv);
    const clientId = await registerDcrClient(provider);

    await expect(provider.parseAuthRequest(new Request(authorizationRequestUrl(clientId)))).rejects
      .toThrow("Public clients must use PKCE");
  });

  it("機密クライアントの PKCE 省略は provider を通るためアプリ側検問が必要", async () => {
    const store = kvStub();
    const provider = realProvider(store.kv);
    const client = await provider.createClient({
      redirectUris: [LOOPBACK_REDIRECT_URI],
      clientName: "confidential-client",
      tokenEndpointAuthMethod: "client_secret_basic",
    });

    const parsed = await provider.parseAuthRequest(
      new Request(authorizationRequestUrl(client.clientId)),
    );
    expect(parsed.codeChallenge).toBeUndefined();
    expect(parsed.codeChallengeMethod).toBeUndefined();
  });

  it("resourceMetadata.resource 設定時は別 resource を厳密に拒否する", async () => {
    const store = kvStub();
    const provider = getOAuthApi(
      {
        ...providerOptions(),
        resourceMetadata: {
          resource: "https://todo.example/mcp",
          resource_name: SERVER_NAME,
          scopes_supported: [...SCOPES_SUPPORTED],
        },
      },
      { OAUTH_KV: store.kv },
    );
    const clientId = await registerDcrClient(provider);

    await expect(
      provider.parseAuthRequest(
        new Request(authorizationRequestUrl(clientId, true, "https://other.example/mcp")),
      ),
    ).rejects.toThrow("must exactly match https://todo.example/mcp");
  });

  it("CIMD 解決失敗は null ではなく CimdFetchError になる", async () => {
    stubCompatibilityFlags();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("upstream unavailable");
    }));
    const store = kvStub();
    const provider = realProvider(store.kv);

    await expect(provider.lookupClient(CIMD_CLIENT_ID)).rejects.toBeInstanceOf(CimdFetchError);
  });
});
