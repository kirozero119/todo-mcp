/**
 * MCP サーバー本体（Resource Server 側）。
 *
 * SDK v2 の `McpServer` ファクトリを `agents/mcp/server` の
 * `createMcpHandler` に渡す。ステートレス（Durable Objects なし）。`legacy`
 * オプションは既定の `'stateless'` のままにし、2025年当時のハンドシェイクも
 * 動くようにしている（今の Claude Code もその方式で接続する）。
 *
 * 有効なトークンを持つリクエストにしか到達しない: OAuthProvider がベアラー
 * トークンを検証し、grant の props を `ctx.props` に復号してからこのハンドラを
 * 呼ぶ。`getMcpAuthContext()` はそれを AsyncLocalStorage 経由で読む。
 */
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { createTaskDb, type TaskDb, type Workspace } from "@todo-mcp/core";
import { z } from "zod";

import {
  githubNumericIdFromUserId,
  isGitHubUserAllowed,
  parseAllowedGitHubUsers,
} from "./allowlist";
import { MCP_ROUTE, SCOPES_SUPPORTED, SERVER_NAME, SERVER_VERSION } from "./config";
import { registerTodoTools } from "./todo-tools";
import { tursoConfigFromEnv } from "./turso";
import type { Env, Props } from "./types";

/** 現在処理中のリクエストの認証済みアイデンティティを読む。 */
function currentProps(): Partial<Props> {
  return (getMcpAuthContext()?.props ?? {}) as Partial<Props>;
}

export interface TodoServerDeps {
  /** Turso 接続を 1 本開く。未設定なら投げる（詳細は tursoOpener）。 */
  openDb: () => TaskDb;
}

/**
 * `resolveDefaultWorkspace()` の結果。
 *
 * 「`?workspace=` が付いていない」と「付いているが "work"/"life" のどちらでもない」
 * を区別して保持する。後段のエラー文（workspaceMissingError）が、前者は
 * 「未指定」、後者は実際に来た不正値をエコーする、という違う文言を組み立てる
 * ために必要（[09] 参照）。
 */
export interface DefaultWorkspaceResolution {
  workspace: Workspace | undefined;
  /** クエリはあったが不正だった場合の生値。クエリ自体が無い場合は undefined。 */
  invalidValue: string | undefined;
}

/**
 * マシンごとの既定 workspace は接続 URL の `?workspace=work|life`（チケット 04）。
 *
 * 会社 PC は `?workspace=work`、私物 Mac は `?workspace=life` で接続する。
 * 07 の実会話ではモデルが毎回 workspace を明示したため、この既定値が実際に
 * 使われた回数は 0 —— それでも残すのは、明示し忘れたときに life が会社 PC の
 * 画面に出ないための保険だから。
 */
function resolveDefaultWorkspace(request: Request | undefined): DefaultWorkspaceResolution {
  if (!request) return { workspace: undefined, invalidValue: undefined };
  const value = new URL(request.url).searchParams.get("workspace");
  if (value === "work" || value === "life") return { workspace: value, invalidValue: undefined };
  // value === null はクエリ自体が無い（正常な省略）。それ以外は不正な値。
  return { workspace: undefined, invalidValue: value ?? undefined };
}

/**
 * ログ行に付けるリクエスト識別子。
 *
 * 07 の観察では、どの呼び出しがどのセッション由来か分からず 3 件を帰属不能な
 * まま記録に残す羽目になった。その反省で、リクエストヘッダ由来の識別子を
 * ツールログに載せる。`mcp-session-id` は 2025 系ハンドシェイクのセッション、
 * `cf-ray` は Cloudflare のリクエスト単位。
 */
function resolveRequestId(request: Request | undefined): string | undefined {
  return request?.headers.get("mcp-session-id") ?? request?.headers.get("cf-ray") ?? undefined;
}

/**
 * テストが明示的な認証コンテキストでマウントできるように export。
 *
 * deps を引数に取る形（ファクトリを返すファクトリ）にしているのは、
 * `agents/mcp/server` の stateless ハンドラが `env` をファクトリに渡さないため
 * （実装は `callable = (request, _env, ctx) => serve(request, undefined, ctx)`）。
 * env をモジュール変数に退避する手もあるが、リクエスト間で共有される可変状態を
 * 増やすことになるので、依存はクロージャで閉じて渡す。
 */
export const createTodoMcpServer =
  (deps: TodoServerDeps) =>
  (ctx: { requestInfo?: Request }): McpServer => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        instructions:
          "個人タスク管理サーバー。タスクの状況を把握するときは、まず get_agenda を呼ぶ。",
      },
    );

    server.registerTool(
      "whoami",
      {
        title: "サインイン中のユーザー",
        description:
          "この接続が認証されている GitHub アイデンティティを返します。サーバーが想定通りのユーザーとして認識しているかを確認するために使用してください。",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async () => {
        const { login, user_id } = currentProps();
        if (!login || !user_id) {
          // 到達不能パス（OAuthProvider が未認証リクエストを先に拒否するため）。
          // props 配線の将来リグレッションを見えるようにするため、偽の
          // アイデンティティではなくツールエラーとして表面化させる。
          return {
            content: [
              {
                type: "text" as const,
                text: "この接続に認証済みアイデンティティがありません。",
              },
            ],
            isError: true as const,
          };
        }
        return {
          content: [{ type: "text" as const, text: `login: ${login}\nuser_id: ${user_id}` }],
          structuredContent: { login, user_id },
        };
      },
    );

    const workspaceResolution = resolveDefaultWorkspace(ctx.requestInfo);
    registerTodoTools(server, {
      openDb: deps.openDb,
      defaultWorkspace: workspaceResolution.workspace,
      invalidWorkspaceQuery: workspaceResolution.invalidValue,
      requestId: resolveRequestId(ctx.requestInfo),
    });

    return server;
  };

const REQUIRED_SCOPE = "todo";

/**
 * [scope enforcement] `props.scopes` に `todo` が含まれるかを確認する。
 * 401 の scope 広告に対応する実際の強制ポイント。詳細は
 * docs/design-notes.md 参照。
 */
function hasRequiredScope(props: Partial<Props> | undefined): boolean {
  return Array.isArray(props?.scopes) && props.scopes.includes(REQUIRED_SCOPE);
}

/**
 * [provider response shape] provider の `createErrorResponse()` が**すべての**
 * エラー応答に付けている `NO_CACHE_HEADERS` の写し。
 *
 * 正本は `@cloudflare/workers-oauth-provider` の `NO_CACHE_HEADERS`
 * （dist/oauth-provider.js。`createErrorResponse()` が
 * `{ ...NO_CACHE_HEADERS, ...options.headers }` として展開する）。認証エラーの
 * 応答をキャッシュさせないのは、同じ URL への次のリクエストが別の判定結果に
 * なる（allowlist に書き戻した直後など）ため。この定数と下の 2 つの応答が
 * provider の形から逸れていないことは `test/provider-response-shape.test.ts`
 * が実ライブラリと突き合わせて検査する —— ライブラリを上げるチケット 13 では、
 * そのテストが落ちたらここの差分を取り直す。
 */
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

function insufficientScopeResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "insufficient_scope",
      error_description: `This token's grant does not include the "${REQUIRED_SCOPE}" scope`,
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        ...NO_CACHE_HEADERS,
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${SCOPES_SUPPORTED.join(" ")}"`,
      },
    },
  );
}

/**
 * [15/allowlist per request] このトークンが名乗るアイデンティティが、*今の*
 * `ALLOWED_GITHUB_USERS` にまだ載っているか。
 *
 * `/callback` の入口判定（github-handler.ts）と**同じ** `isGitHubUserAllowed()`
 * を通す。判定関数を分けると、入口と毎リクエストで許可集合がずれ得る。
 * allowlist が未設定・空のときに全員拒否になるフェイルクローズも、その関数の
 * 既存の扱いをそのまま引き継ぐ。詳細は docs/design-notes.md 参照。
 */
function isIdentityAllowed(props: Partial<Props> | undefined, env: Partial<Env>): boolean {
  return isGitHubUserAllowed(
    props?.login,
    githubNumericIdFromUserId(props?.user_id),
    env.ALLOWED_GITHUB_USERS,
  );
}

/**
 * [15/allowlist diagnosability] 拒否の理由。**ログにだけ**出す。
 *
 * `allowlist_empty` は `ALLOWED_GITHUB_USERS` が未設定・空・区切り文字だけ
 * （＝誰も載っていない）、`identity_not_listed` は allowlist はあるがこの身元が
 * 載っていない。この 2 つは運用上まったく違う事故（secret を落としたデプロイ vs
 * 意図した除名）なのに、前者は「稼働中の全マシンが即座に全停止」を意味する。
 * 応答からは区別できないので（下記）、ログで区別できないと切り分ける手段が無い。
 */
type AllowlistDenialReason = "allowlist_empty" | "identity_not_listed";

/**
 * 許可なら `undefined`、拒否ならその理由。
 *
 * 許可・拒否の**判定そのもの**は `isIdentityAllowed()` 一本のまま。理由付けは
 * 判定が拒否に倒れた後の後付け分類にとどめる —— 分類側に条件を足すと、判定と
 * 分類で許可集合がずれ得る。
 */
function allowlistDenialReason(
  props: Partial<Props> | undefined,
  env: Partial<Env>,
): AllowlistDenialReason | undefined {
  if (isIdentityAllowed(props, env)) return undefined;
  return parseAllowedGitHubUsers(env.ALLOWED_GITHUB_USERS).length === 0
    ? "allowlist_empty"
    : "identity_not_listed";
}

/**
 * [15/allowlist per request] 拒否は 403 ではなく 401 `invalid_token`。
 *
 * ヘッダーは provider 自身の 401（`buildWwwAuthenticateHeader` /
 * `handleApiRequest`）と同じ形にする —— `resource_metadata` があることで、MCP の
 * Authorization 仕様に従うクライアントはこの 401 を「再認証せよ」と読む。その
 * 再認証は `GET /callback` の allowlist に当たって `access_denied` になるので、
 * 「もう許可されていない」がブラウザ上で人間に見える。**401 を受けた実際の
 * クライアントが何をするかはクライアント側の実装**で、ここからは強制できない
 * （未検証。docs/design-notes.md の [15] 判断1）。`scope=` を足すのは index.ts の
 * `onError()`（[M-2/P1-3]）と同じ理由・同じ形にするため。
 *
 * [provider response shape] `WWW-Authenticate` の正本は provider の
 * `buildWwwAuthenticateHeader(resourceMetadataUrl, error, errorDescription)`、
 * `resourceMetadataUrl` の組み立てと `NO_CACHE_HEADERS` の正本は
 * `handleApiRequest()` / `createErrorResponse()`（いずれも
 * @cloudflare/workers-oauth-provider の dist/oauth-provider.js）。ここは
 * その出力を手で組み直しているので、ライブラリ側が形を変えると黙って乖離する。
 * `test/provider-response-shape.test.ts` が実ライブラリの 401 と突き合わせて
 * いるので、チケット 13 のバージョン上げでそこが落ちたらこの関数を直す。
 *
 * [15/allowlist diagnosability] 拒否の理由（allowlist_empty /
 * identity_not_listed）は**この応答に載せない**。載せるとサーバーの構成情報
 * （secret が落ちているかどうか）を未認可の相手に渡すことになる。区別はログ側
 * だけで行う。
 */
function identityNotAllowedResponse(request: Request): Response {
  const url = new URL(request.url);
  const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  // `"` を含めない（WWW-Authenticate の quoted-string を壊さないため）。
  const description = "This GitHub identity is no longer allowed to use this server";
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      ...NO_CACHE_HEADERS,
      "WWW-Authenticate":
        `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", ` +
        `error="invalid_token", error_description="${description}", ` +
        `scope="${SCOPES_SUPPORTED.join(" ")}"`,
    },
  });
}

/**
 * Turso 接続を開くクロージャ。設定が無ければ投げる。
 *
 * リクエスト全体を 500 で落とさないのは、`whoami` と `tools/list` を生かして
 * おくため —— 設定ミスの診断にまさに使いたい道具だから。ツールハンドラ内の
 * 例外は SDK が isError のツール結果に変換する（この文言がそのままモデルに
 * 届く）ので、黙って 0 件を返す事故にはならない。
 */
function tursoOpener(env: Partial<Env>): () => TaskDb {
  return () => {
    const config = tursoConfigFromEnv(env);
    if (!config) {
      console.log(`[mcp] ${JSON.stringify({ event: "turso_unconfigured" })}`);
      throw new Error(
        "サーバー設定エラー: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN が設定されていません。",
      );
    }
    return createTaskDb(config);
  };
}

/**
 * OAuthProvider の `apiHandler` / `apiHandlers` に渡せる最小の形。
 *
 * provider 側の `ExportedHandlerWithFetch<Env>` のうち、この Worker が実際に
 * 使う面だけを写したもの。`withAllowlistGate()` の入出力を同じ型にして、
 * ゲートを何段でも噛ませられる（＝配線側で外し忘れが型に出る）ようにする。
 */
export interface ApiHandler {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
}

/**
 * [15/allowlist per request] 認証済みルートに allowlist ゲートを掛ける。
 *
 * **配線の性質としてのゲート**。判定を `mcpApiHandler` の本文に置くと、
 * 「認証済みの全ルートが allowlist を再評価する」という不変条件が、その 1 関数の
 * 中身だけで担保されることになる。provider は `apiHandlers`（route → handler の
 * マップ）も受け付けるので、将来 2 本目のルートを足した人は、そのルートに
 * ゲートを掛けたつもりが無いまま `/mcp` と同じトークンで通せるハンドラを
 * 公開できてしまう。ラッパーにしておけば、provider に渡すものを書く時点で
 * 「ゲートを掛ける／掛けない」を明示的に選ぶことになる。
 * 配線が実際にゲート済みであることは `test/wiring.test.ts` が index.ts の
 * provider 設定を読んで検査する（ルートが増えてもその全部を検査する）。
 *
 * **順序**: このラッパーは中のハンドラより必ず先に走るので、allowlist は
 * scope チェック（`mcpApiHandler` の中）より先に評価される。これは
 * 「もうこのサーバーを使えない身元に scope の不足を案内しても、実行できる
 * 回復手順にならない」ため（詳細は docs/design-notes.md の [15]）。
 * 順序が逆になると、scope 無しかつ allowlist から外れたトークンが
 * `403 insufficient_scope` を受け取り、「もっと広い権限を取り直せば通る」という
 * 嘘の含意になる —— そこを固定しているのが test/mcp.test.ts の
 * 「refuses before the scope check」テスト。
 */
export const withAllowlistGate = (handler: ApiHandler): ApiHandler => ({
  fetch: (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> => {
    const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
    const denialReason = allowlistDenialReason(props, (env ?? {}) as Partial<Env>);
    if (denialReason) {
      console.log(
        `[mcp] ${JSON.stringify({
          event: "identity_not_allowed",
          reason: denialReason,
          login: props?.login ?? null,
          user_id: props?.user_id ?? null,
        })}`,
      );
      return Promise.resolve(identityNotAllowedResponse(request));
    }
    return handler.fetch(request, env, ctx);
  },
});

/**
 * ExportedHandler 形状でラップ: OAuthProvider の apiHandler は
 * `fetch(request, env, ctx)` を期待するが、createMcpHandler が返すのは
 * `fetch(request, options)`。スコープ強制の場所でもある（詳細は
 * docs/design-notes.md 参照）。
 *
 * ハンドラをここで組み立てているのは、env を受け取れるのがこの位置だけだから
 * （createTodoMcpServer の doc コメント参照）。組み立てるのは薄いラッパーで、
 * McpServer 自体は元々リクエストごとに作られる（stateless 設計）。
 *
 * [15/allowlist per request] allowlist の照合はここには**無い**。
 * `withAllowlistGate()` が外側に掛かる（index.ts の配線）。tools / resources /
 * prompts / initialize、さらに非 POST（GET / DELETE）も JSON-RPC バッチも
 * すべて同じ `/mcp` に来るので、そのラッパー 1 枚が全経路のゲートになる。
 */
export const mcpApiHandler: ApiHandler = {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> => {
    const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
    const workerEnv = (env ?? {}) as Partial<Env>;

    if (!hasRequiredScope(props)) return Promise.resolve(insufficientScopeResponse());

    const handler = createMcpHandler(createTodoMcpServer({ openDb: tursoOpener(workerEnv) }), {
      route: MCP_ROUTE,
    });
    return handler(request, env, ctx);
  },
};
