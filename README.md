# todo-mcp

実用的な Todo MCP サーバー。Turso + GitHub OAuth + ワークスペース切り替え。MCP spec 2026-07-28 / SDK v2 上に構築。

現在の状態: **認証つきサーバー + Todo ツール本実装 + 旧 DB からの移行スクリプト**。ツールセット v1
（5 ツール + Resource / Prompt 各 1）が Turso 上で動き、旧 `todos.db` の中身を `packages/migrate`
で移せる。`packages/cli` は後続チケット。

## 構成

```
packages/core/       MCP サーバーと CLI で共有するドメイン層（Cloudflare 非依存）
  schema.sql         tasks テーブルの確定 DDL（Turso への適用元）
  src/schema.ts      workspace / status の Zod enum、Task 型、行マッパー
  src/tasks.ts       tasks への SQL 全部（list / get / create / update / complete / search）
  src/db.ts          Turso クライアント生成と、クエリが要求する最小の DB 面（TaskDb）
  src/time.ts        保存フォーマット（ISO 8601 UTC）と「今日」の JST 境界

packages/server/     Cloudflare Worker: MCP サーバー（Resource Server）+ OAuth AS
  src/index.ts       エントリーポイント — Origin ガード、OAuthProvider の配線
  src/github-handler.ts  同意ダイアログ、GitHub へのリダイレクト、コールバック、許可リスト適用
  src/mcp.ts         SDK v2 McpServer + `whoami` + Turso 接続の組み立て
  src/todo-tools.ts  Todo ツール 5 本 + Resource + Prompt の定義と description
  src/todo-format.ts モデルに読ませる本文・エラー文の組み立て
  src/turso.ts       env から Turso 接続設定を取り出す
  src/allowlist.ts   純粋な認可ヘルパー関数（ユニットテスト済み）
  src/approval.ts    同意ダイアログ、CSRF、OAuth state のバインディング
  src/redirect-uri.ts  DCR登録と GET /authorize で共有する redirect_uri ポリシー

packages/migrate/    旧 Python CLI の todos.db → Turso の 1 回きりの移行（Node で走る）
  src/main.ts        I/O シェル（argv / env / 接続 / 出力）
  src/cli.ts         引数と接続先のガード（純粋関数・テスト対象）
  src/legacy.ts      旧 todos.db の読み出し（readOnly で開く。ここの tasks は旧スキーマ）
  src/transform.ts   旧 1 行 → 新 1 行の変換規則（純粋関数・テスト対象）
  src/execute.ts     書き込みの順番（カウンタ先行 → INSERT → 再アサート → 読み直し）
  src/verify.ts      投入後の値レベル検証（書いたはずの値と DB の実際を全列で突き合わせる）
  src/sequence.ts    sqlite_sequence の引き上げ（tasks 以外を触る唯一の生 SQL）
```

npm workspaces のモノレポ構成。`packages/cli` は後日追加予定。

## ツール

| ツール | 引数 | 用途 |
|---|---|---|
| `get_agenda` | `workspace?` | 今日の行動対象（期限切れ / 今日 / 7日以内 / 進行中 / 待ち） |
| `get_task` | `id` | 1 件の全詳細（memo 本文を含む） |
| `upsert_task` | `id?, title?, workspace?, project?, status?, due?, memo?` | 作成 / 部分更新。`status: "cancelled"` がソフトデリート |
| `complete_task` | `id` | done にする（冪等） |
| `search_tasks` | `query?, workspace?, status?, project?, include_closed?` | 絞り込み一覧（既定は open のみ、上限 20 件） |

タスクを物理削除するツールは存在しない。「やらないと決めた」は行の抹消ではなく状態なので
`cancelled` で表す。

workspace はマシンごとの既定を接続 URL の `?workspace=work|life` で決め、ツール引数が来たら
そちらが勝つ。タスクは GitHub アイデンティティ（`github:<数値id>`）ごとに完全に分離される。

## Turso

`tasks` テーブルは 1 つだけ。定義は `packages/core/schema.sql`（唯一の正）。

```bash
turso db create todo-mcp-dev
turso db shell todo-mcp-dev < packages/core/schema.sql
turso db tokens create todo-mcp-dev     # 出力を .dev.vars の TURSO_AUTH_TOKEN へ
turso db show todo-mcp-dev --url        # 出力を .dev.vars の TURSO_DATABASE_URL へ
```

開発用（`todo-mcp-dev`）と本番用（`todo-mcp-prod`）で DB を分けている。本番 URL は既に複数の
マシンから実運用されているため、開発中の書き込みで汚さないための分離。

## 旧 todos.db からの移行

旧 Python CLI（`~/life/todos/todos.db`）のタスクを Turso へ移す。1 回きりの作業だが、
やり直せることが安全性の中心なので、スクリプトとしてリポジトリに残してある。

**本番に入れるのは生存 8 件のみ**（2026-08-08 決定）。done 140 件は旧 `todos.db` に
アーカイブとして残す。

```bash
# 接続先は target ごとに別の環境変数から取る（共通の TURSO_DATABASE_URL は読まない）
export TURSO_DEV_DATABASE_URL=$(turso db show todo-mcp-dev --url)
export TURSO_DEV_AUTH_TOKEN=$(turso db tokens create todo-mcp-dev)

# 何が入るかを見る（書き込みなし。投入予定の行を全部 JSON で出す）
npm run migrate --workspace @todo-mcp/migrate -- --target dev --dry-run --only-open

# 実行
npm run migrate --workspace @todo-mcp/migrate -- --target dev --execute --only-open
```

本番（`todo-mcp-prod`）へ入れるときは、prod 用の資格情報を別の変数名で用意して
`--target prod` を指定する:

```bash
export TURSO_PROD_DATABASE_URL=$(turso db show todo-mcp-prod --url)
export TURSO_PROD_AUTH_TOKEN=$(turso db tokens create todo-mcp-prod)

npm run migrate --workspace @todo-mcp/migrate -- --target prod --dry-run --only-open
npm run migrate --workspace @todo-mcp/migrate -- --target prod --execute --only-open
```

`TURSO_PROD_DATABASE_URL` のホスト名は `todo-mcp-prod` そのものか `todo-mcp-prod-` で
始まる必要がある（`todo-mcp-prod2...` のような別 DB は拒否される）。dev の URL を
貼り間違えていれば、接続する前に止まる。

- `--dry-run` / `--execute` は**どちらかを必ず書く**（既定値は無い）。
- `--only-open` は**必須**。外すと実行前に止まる —— 全件（done 140 件を含む）を入れるには
  旧 category を `work` / `life` のどちらに載せるかの決定が先に要る。決めたら
  `packages/migrate/src/cli.ts` の停止を外すこと（その編集自体が判断の記録になる）。
- `--user-id` は `github:<数値>` 形式のみ。形式違いは接続前に拒否される。
- 旧 id をそのまま持ち込むので、**同じ対象に 2 回実行すると 1 行目で PRIMARY KEY 制約に当たって
  止まる**（0 件投入で終わる）。
- 移行元は `readOnly` で開く。旧 `todos.db` はアーカイブとして凍結する方針。
- 投入後は行数の増分だけでなく、**全行を読み直して全 10 列が一致すること**まで確認してから
  正常終了する。1 列でも食い違えば id と列名を挙げて終了コード 1 で止まる。

### 途中で落ちたときのやり直し

INSERT にトランザクションを張っていないので、途中（ネットワーク断など）で落ちると
そこまでの行は入ったまま残る。失敗時は必ず `N/M 件を投入済み` と出るので、**その N 件だけを
消す**。dry-run の計画に id が昇順で並んでいるので、先頭 N 件がその id になる。

```bash
# 例: 8 件中 3 件まで入って落ちた → 計画の先頭 3 件は id 1, 12, 13
turso db shell todo-mcp-prod \
  "DELETE FROM tasks WHERE user_id = 'github:64899536' AND id IN (1, 12, 13);"
```

対象 DB を丸ごと空にしてはいけない。**部分投入の後に MCP 経由で作られたタスクまで消える**。

- `sqlite_sequence` を手で戻す必要は無い。全行を DELETE しても SQLite はカウンタを
  リセットしない（実測: 153 のまま）。移行は INSERT より**前**にカウンタを上げるので、
  途中で落ちた場合でも既に安全域まで上がっている。
- 「採番カウンタの操作だけが失敗した」というエラーが出た場合は話が別で、**行は全件入っている**。
  そのときは DB を触らず、`sqlite_sequence(tasks)` の値だけを確認する（エラー文にも書いてある）。

## 認可の仕組み

```
MCPクライアント --(OAuth 2.1, PKCE S256, CIMD または DCR)--> このWorker（Authorization Server）
                                                                  |
                                                                  +--(OAuth 2.0)--> GitHub
```

この Worker は、MCP クライアントから見ると Authorization Server であり、GitHub から見ると OAuth
クライアントでもある。`/mcp` で受け付けられるのはこの Worker 自身が発行したトークンのみで、GitHub
のトークンをそのまま提示しても 401 になる。

- GitHub OAuth のスコープは**空**——アイデンティティ（`login` + 数値の `id`）のみを取得する。
- GitHub が本人確認を終えた後、その認可を実際に完了させるかどうかは `ALLOWED_GITHUB_USERS` が判断する。
  許可リストにないユーザーは、クライアント自身の redirect_uri に `error=access_denied`
  （RFC 6749 §4.1.2.1）付きでリダイレクトされ、グラントは一切作られない——クライアントが解釈方法を
  持たない単なる 403 は返さない。GitHub 自身が拒否した場合（例: GitHub の同意画面でユーザーが
  キャンセルした場合）も同じ経路で伝える。
- トークンの props には `login` と `user_id`（`github:<numeric id>`）を含める。数値 id を使うのは、
  GitHub のログイン名は改名され、別人に再登録され得るため。
- `ALLOWED_GITHUB_USERS` は入口だけの鍵ではない。`/mcp` はリクエストのたびに同じ許可リストを読み直し、
  トークンの props（`login` / `user_id`）を照合する。許可リストから外されたユーザーは、発行済みの
  トークンを持っていても次のリクエストから 401 `invalid_token` になる。クライアントはこの 401 で
  再認証を試み、その再認証が `/callback` の同じ判定で `access_denied` になるので、「もう許可されて
  いない」が人間の目に見える形で出る。止めるのに KV を手で触る必要はなく、許可リストに書き戻せば
  そのまま元に戻る（トークンを revoke しないため、端末の再認可も要らない）。

エンドポイント: `/authorize`、`/token`、`/register`（DCR）、`/callback`、
`/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource[/mcp]`、
そして `/mcp` 自体。

## ローカル開発

前提条件: Node >=22.18.0 （`engines` で固定。ロックされた依存パッケージがこのバージョンを要求する）、
そして**開発用**の GitHub OAuth App:

- Homepage URL: `http://localhost:8788`
- Authorization callback URL: `http://localhost:8788/callback`

`packages/server/.dev.vars` はリポジトリルートの `.dev.vars` へのシンボリックリンクを想定しているが、
クローン直後にはまだ存在しない——一度だけ作成する:

```bash
ln -s ../../.dev.vars packages/server/.dev.vars
```

値はリポジトリルートの `.dev.vars`（git-ignore 済み。`packages/server/.dev.vars` はこれへの
シンボリックリンク）に設定する:

```
GITHUB_CLIENT_ID=<dev app client id>
GITHUB_CLIENT_SECRET=<dev app client secret>
COOKIE_ENCRYPTION_KEY=<openssl rand -base64 32>
ALLOWED_GITHUB_USERS=<your github login>
TURSO_DATABASE_URL=libsql://todo-mcp-dev-<org>.<region>.turso.io
TURSO_AUTH_TOKEN=<turso db tokens create todo-mcp-dev の出力>
```

Turso の 2 つが未設定でも起動はするが、DB に触るツールだけが「サーバー設定エラー」を返す
（`whoami` と `tools/list` は生きたままにしてある——設定ミスの診断に使うため）。

`ALLOWED_GITHUB_USERS` はフェイルクローズ設計——未設定または空なら全員拒否になる（新規の認可だけで
なく `/mcp` の各リクエストにも効くので、空にすると発行済みトークンも通らなくなる）。値は GitHub の
ログイン名（`octocat`）、またはログイン改名後に別人が空いた名前を再登録しても追跡できるよう、
不変の数値 id を使った `github:<numeric id>` 形式（例: `github:583231`。
`https://api.github.com/users/<login>` で確認可能）のどちらでもよい。

```bash
npm install
npm run dev        # wrangler dev を http://localhost:8788 で起動
npm run typecheck
npm test
```

ポート 8788 は `packages/server/wrangler.jsonc` の `dev.port` で固定している——開発用 OAuth App の
callback URL がこのポートに対して登録されているため。

ブラウザ不要のスモークチェック:

```bash
curl -s http://localhost:8788/.well-known/oauth-protected-resource
curl -s http://localhost:8788/.well-known/oauth-authorization-server
curl -si -X POST http://localhost:8788/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'      # 401 + WWW-Authenticate
```

`__Host-` 接頭辞付きの各種 cookie（CSRF トークン、同意、approved-clients）は、ローカル開発中に
Chrome と Firefox での動作を確認済み。Safari は未検証。

## トラブルシューティング

- **`/callback` での "Invalid or expired state"**: 原因は 2 つある。①KV は結果整合性のため、
  書き込み直後の読み取りが古い値を返すことがある。②`/authorize` から認可フローをやり直すと、
  進行中の別試行の `__Host-CSRF_TOKEN` / `__Host-CONSENTED_STATE` cookie を上書きしてしまう。
  いずれの場合も `/authorize` からサインインをやり直せば解消する。

## デプロイ

1. **本番用 GitHub OAuth App**（callback URL が異なるため、開発用とは別に用意する）:
   - Homepage URL: `https://todo-mcp.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://todo-mcp.<your-subdomain>.workers.dev/callback`

2. **KV namespace** — provider がグラント・トークン・登録済みクライアントを保存する:

   ```bash
   cd packages/server
   npx wrangler kv namespace create "OAUTH_KV"
   ```

   返ってきた id を `packages/server/wrangler.jsonc` の `kv_namespaces[0].id` に入れる
   （現在はプレースホルダーの `REPLACE_ME_BEFORE_DEPLOY` が入っている）。

3. **シークレット** — 6つとも `wrangler.jsonc` には書かない:

   ```bash
   cd packages/server
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -base64 32
   npx wrangler secret put ALLOWED_GITHUB_USERS    # カンマ区切りのログイン名、または github:<numeric id>
   npx wrangler secret put TURSO_DATABASE_URL      # turso db show todo-mcp-prod --url
   npx wrangler secret put TURSO_AUTH_TOKEN        # turso db tokens create todo-mcp-prod
   ```

   `ALLOWED_GITHUB_USERS` をあえて `vars` ではなくシークレットにしているのは、同名の `vars`
   エントリがあるとデプロイのたびにシークレットを上書きしてしまうため。

   本番の Turso は **`todo-mcp-prod`**（dev の `todo-mcp-dev` ではない）。ここを間違えると、
   実運用中のタスクが開発用 DB を向く。

4. **デプロイ**:

   ```bash
   npm run deploy
   ```

5. **接続** — MCP クライアントを `https://todo-mcp.<your-subdomain>.workers.dev/mcp` に向け、
   開いたブラウザウィンドウで GitHub サインインを完了させる。

## 運用者向けメモ

- `compatibility_flags` には `global_fetch_strictly_public` を必ず維持すること。これがないと
  provider は Client ID Metadata Document の取得を拒否し、
  `client_id_metadata_document_supported: false` を広告してしまい、全クライアントが DCR に
  強制される。
- 両方の登録方式（CIMD / DCR）を広告している。どちらを使ったかはすべての認可でログに残る:
  `[oauth] {"event":"authorize","registration":"cimd"|"registered",...}`。失敗時は拒否された
  redirect_uri とともに `authorize_rejected` としてログされる。クライアントを DCR に強制したい
  場合は `src/index.ts` の `clientIdMetadataDocumentEnabled` を `false` にする。
- DCR で登録する `redirect_uris` はすべて `https`、またはループバックアドレス（`127.0.0.1`、
  `::1`、`localhost` — RFC 8252 §7.3）に限定した `http` である必要がある。それ以外は登録時に
  `invalid_redirect_uri` で拒否される。同じポリシーは GET /authorize（`src/redirect-uri.ts`）でも
  再度検証しているため、`redirect_uris` が取得したドキュメント由来で DCR を一切経由しない CIMD
  クライアントもこのポリシーを回避できない。
- DCR で登録したクライアントは 90 日で失効する（`clientRegistrationTTL`。provider 自体のデフォルト
  値に合わせている）。30 日の refresh token TTL より十分長く保ち、まだ有効な refresh token が自身の
  `client:<id>` の KV レコードより長生きすることがないようにしている。
- アクセストークンの寿命は 1 時間、refresh token は 30 日（provider のデフォルト）。ユーザーの
  アクセスを取り消すには `ALLOWED_GITHUB_USERS` から削除すれば足りる——許可リストは認可時だけで
  なく `/mcp` のリクエストごとにも照合されるので、発行済みトークンも次のリクエストで 401 になる。
  KV に残るグラントは拒否され続けたまま最長 30 日で自然失効する。特定の**端末**だけを切りたい場合
  （ユーザー本人は使い続ける場合）は許可リストでは選べないため、KV のキー削除が引き続き必要。
- provider は認可レスポンスに `iss` パラメータを送出しない。MCP final（SEP-2468）ではこれを AS
  にとっての SHOULD としており MUST ではない——既知のギャップであり不具合ではなく、これまで
  検証したどのクライアントに対しても現時点でブロッカーにはなっていない。
- `/register`（DCR）エンドポイントは今のところ有効のままにしてある。実クライアントが3件以上
  接続できたら、`/register` を無効化して（`src/index.ts` の `clientRegistrationEndpoint` を削除）
  全員を CIMD に寄せることを検討する——CIMD はクライアントレコードの永続化が一切不要になる。
