# 設計ノート（レビュー・実障害の経緯）

`packages/server/src/*.ts` のコメントに書かれていた「なぜこの実装になったか」の経緯説明を、
ソースコードから引き剥がしてここに集約したもの。ソース側のコメントは要点のみを残し、
`[H-1]` のようなタグで本ドキュメントの該当項目と対応させている。

行番号は変わりやすいため書いていない。各項目末尾の「ソース位置」はファイル名と関数名（または
該当する設定オブジェクト名）で示す。

## 目次

- [allowlist.ts](#allowlistts)
  - [M-3/P2-1] ALLOWED_GITHUB_USERS の二形式とフェイルクローズ
  - userId のコロン制約（githubGrantUserId）
  - [15] props の `user_id` から数値 ID を復元する経路は正規形だけを受ける
- [config.ts](#configts)
  - offline_access を scopes_supported に含めない理由
- [redirect-uri.ts](#redirect-urits)
  - [M-4] redirect_uri ポリシーをファイルとして切り出し、DCR/CIMD 両方に適用
- [types.ts](#typests)
  - Props に GitHub の upstream アクセストークンを持たせない
  - [scope enforcement] props.scopes とその強制ポイント
- [approval.ts](#approvalts)
  - consent フローの順序（confused deputy 対策）とテンプレートからの改変点
  - [M-1/P1-1] state 不透明トークン化と所有者束縛
  - [L-10] approved-clients cookie の件数上限
  - [L-3] base64url エンコードで UTF-8 バイト列を経由する理由
  - [L-9] COOKIE_ENCRYPTION_KEY の強度チェック
  - [L-2] 同意画面に Cache-Control: no-store を付ける理由
  - [H-1] 同意は (clientId, redirect_uri) 単位で管理する
  - CSP に form-action を入れない理由（リダイレクトチェーンの検査で2回壊れた実障害）
- [github-handler.ts](#github-handlerts)
  - [L-13] 認可拒否レスポンスの共通化（respondAccessDenied）
  - registrationSource() の判定は provider の isClientMetadataUrl() を踏襲
  - PKCE 素通り（provider の仕様） — parseAuthRequest() 自体は PKCE を強制しない
  - [redirect_uri policy / CIMD parity] CIMD クライアントにも同じポリシーを適用
  - プレアプルーブ高速経路と state 生成の順序
  - [L-14] /callback 内のエラーを単一 catch に集約する理由
  - [GitHub-side denial] GitHub 自身の拒否をアクセス拒否として扱う
  - [P1-2/L-7] audience 補完と resourceMatchOriginOnly の対応
  - [scope enforcement] grantedScopes を一度だけ計算し、grant と props の両方に使う
  - [09/複数端末] revokeExistingGrants の無効化は CIMD 経路にだけ掛ける
  - [09/複数端末] 端末を失くしたときに実際に打てる kill switch は KV の token/grant 削除
  - [09/複数端末] grant の30日は認可時点からの絶対値で、refresh では延びない
  - [09/複数端末] purgeExpiredData を cron で回す必要がない理由
- [index.ts](#indexts)
  - [M-4] DCR 登録の有効期限を 7日 から 90日（provider 既定値）に戻した経緯
  - allowPlainPKCE を false にする理由
  - clientRegistrationCallback — DCR 登録時のログと redirect_uri ポリシー強制点
  - [M-2/P1-3] 401 レスポンスへの scope 追記
  - Origin ガードの配置場所と production でのスコープ限定
- [mcp.ts](#mcpts)
  - [scope enforcement] hasRequiredScope — 401 の scope 広告に対応する実体
  - whoami ツールの「到達不能パス」を敢えて残す理由
  - mcpApiHandler を ExportedHandler 形状でラップする理由
  - [09] env をファクトリに渡す経路がないので deps をカリー化した
  - [09] Turso 未設定のとき 500 ではなく openDb で投げる理由
  - [09/レビュー] types.ts / turso.ts のコメントを実装に合わせて訂正した
  - [09/レビュー] 不正な `?workspace=` クエリ値をエラー文にエコーする
  - [15] allowlist を `/mcp` のリクエストごとに再評価する
  - [15/レビュー] ゲートを「配線の性質」にする（withAllowlistGate）
  - [15/レビュー] refresh_token 時の allowlist 照合（tokenExchangeCallback）を採らない
  - [15/レビュー] 拒否の理由はログでだけ分ける（応答は同一）
  - [15/レビュー] provider の応答形を手で組み直している箇所の正本と drift 検出
- [packages/core](#packagescore)
  - [09] core / server の境界をどこで切ったか
  - [09] user_id スコープを「grep で確認できる」形に保つ
  - [09] TaskDb を最小インターフェースにして node:sqlite でテストする
  - [09] 書き込みを全部 RETURNING にした理由と往復回数
  - [09] COUNT(*) OVER () で総件数と先頭 N 件を 1 往復で取る
  - [09] 読み出し時に Zod 検証をしない
  - [09/レビュー] completeTask の冪等性を UPDATE の WHERE 句自体で守る（同時実行対策）
  - [09/レビュー2] completeTask の応答は返す行の status と一致させる（reopened の追加）
  - [09/レビュー2] project / memo の空文字を null に正規化する（書けるが読めない値を作らない）
  - [09/レビュー] updateTask の SELECT→UPDATE は非トランザクション —— 許容している理由
  - [09/レビュー2] 同時実行テストが依存するハーネスの性質を固定する
- [packages/migrate](#packagesmigrateチケット-10-旧-todosdb-からの移行)
  - [10] 移行スクリプトを packages/migrate という新しいワークスペースにした
  - [10] INSERT を core の `importTask()` にして、移行スクリプトに生 SQL を書かなかった
  - [10] sqlite_sequence だけは移行パッケージ側の生 SQL にした
  - [10] updated_at に created_at をそのまま入れた
  - [10] `YYYY-MM-DD HH:MM` の due を日付に丸めた（旧 DB に 2 件実在）
  - [10] `"" → null` の防御は入れたが、実データでは 1 件も発火しなかった
  - [10] 2 回実行すると PRIMARY KEY で止まる（事故防止として機能する）
  - [10] 接続先の取り違えを 2 段で塞ぐ
  - [10/レビュー] Turso が `sqlite_sequence` への書き込みを受けるかを実測した
  - [10/レビュー] 採番カウンタを INSERT ループの前に上げる
  - [10/レビュー] 投入後の検証を値レベルにした（そして何を確かめていないか）
  - [10/レビュー] `--user-id` を検証しないと、投入後の確認が誤入力を追認する
  - [10/レビュー] 未知の `due` 形式を丸めるのをやめた
  - [10/レビュー] `--only-open` を必須にして、全件移行を実行前に止める
  - [10/レビュー] 取り違えガードを純粋関数に切り出してテストを付けた
  - [10/レビュー] 「tasks への SQL は core にある」を実行できる形に戻した
  - [10/レビュー] 本番スコープを 8 件に確定したことで残る限界
- [todo-tools.ts / todo-format.ts](#todo-toolsts--todo-formatts)
  - [09] user_id を引数から受け取らない構造（withUser）
  - [09] due だけスキーマ検証にしない理由
  - [09] ToolText を interface ではなく type にした理由
  - [09] プロトタイプから変えた点（agenda フッターの文言）
  - [09] ツール呼び出しログに載せるもの・載せないもの
  - [09/レビュー] upsert_task の not-found アンカーを workspace で絞らない
  - [09/レビュー2] not-found アンカーと CAP 20 の相互作用（既知の限界）
  - [09/レビュー] search_tasks の 0 件時のスコープ表示を実効検索条件に合わせる
  - [09/レビュー] title / project / query の空文字をスキーマ側で弾く → [09/レビュー2] で撤回
  - [09/レビュー2] エラー文にエコーする外部由来の値を無害化する（規約側で塞ぐ）
  - [09/レビュー2] workspace エラーの③（回復手順）はツールとリソースで共有しない
  - [09/レビュー2] workspaceMissingError の引数を必須にする
  - [09/レビュー] 表示層・ツール層に DB 不要の単体テストを追加した
  - [09/レビュー2] fakeTaskDb を SQL 分岐型に一般化し、直した振る舞いに回帰検知を付けた
- [github.ts](#githubts)
  - GitHub 認可 URL に scope を一切渡さない理由
  - GitHub の token エンドポイントはエラーも HTTP 200 で返す
  - fetchGitHubIdentity が保持するのは login と id のみ

---

## allowlist.ts

### [M-3/P2-1] ALLOWED_GITHUB_USERS の二形式とフェイルクローズ

**問題**: GitHub のログイン名はリネーム可能で、リネームによって解放された旧ログイン名は誰でも取得できる。ログイン名だけで allowlist を組むと、リネーム後に旧名を取得した別人にアクセス権を渡してしまう恐れがあった。

**対応**: `ALLOWED_GITHUB_USERS` に2つの記法を許可する。
- 素のログイン名（`octocat`、大小文字を無視して比較）
- `github:<数値ID>`（`github:1`、不変の数値 ID で比較）

数値 ID 形式はリネームの影響を受けない。

**なぜこの形**: 未設定・空文字・空白のみの `ALLOWED_GITHUB_USERS` は「誰も許可しない」と判定する（フェイルクローズ）。設定ミスがあった場合、全世界に公開されるのではなく運用者自身がロックアウトされる方向に倒す。

**ソース位置**: `allowlist.ts` の `isGitHubUserAllowed()`（呼び出し元は2箇所 —— `github-handler.ts` の `GET /callback`（入口）と、`mcp.ts` の `isIdentityAllowed()`（`/mcp` のリクエストごと。チケット 15 で追加））

### userId のコロン制約（githubGrantUserId）

**問題**: workers-oauth-provider はアクセストークンを `${userId}:${grantId}:${secret}` という形式で発行し、検証時に `:` で分割して「ちょうど3パーツ」であることを要求する（`dist/oauth-provider.js` の `createAccessToken` / `handleApiRequest` で確認済み）。`userId` に `:` が含まれると、そのトークンは永久に検証できなくなる。

**対応**: `OAuthProvider.completeAuthorization()` に渡す `userId`（grant の識別子）だけは `-` 区切りの `github-<id>` 形式にする。props 側に保存する正規のユーザー識別子（`user_id`）は従来通り `github:<id>` のコロン区切りのまま。

**なぜこの形**: grant 識別子とアプリ内の正規ユーザー ID を別の関数（`githubGrantUserId()` / `githubUserId()`）に分けることで、provider 側の制約とアプリの識別子表現を両立させている。

**ソース位置**: `allowlist.ts` の `githubGrantUserId()` / `githubUserId()`

### [15] props の `user_id` から数値 ID を復元する経路は正規形だけを受ける

**問題**: `/mcp` のリクエストごとの allowlist 照合（[15] の項、mcp.ts）が `isGitHubUserAllowed()` に渡せる数値 ID は、`props.user_id`（`github:<数値ID>`）から復元するしかない。`/callback` は GitHub API のレスポンスから `id` を直接持っているが、`/mcp` にはこの文字列しか無い。ここが緩いと、`github:<数値ID>` 記法の allowlist エントリに、本来一致してはいけない値が一致し得る。

**対応**: `githubNumericIdFromUserId()` は `githubUserId()` の出力そのものだけを受ける —— `/^github:(\d+)$/` に一致し、safe integer かつ正で、さらに**正規形との往復が一致**する場合のみ数値を返し、それ以外は `undefined`。落ちるもの: 別 IdP の名前空間（`google:583231`）、接頭辞なし（`583231`）、末尾のゴミ（`github:583231extra`）、非正規な桁表記（`github:0583231`）、前後の空白、2^53 超え。

**なぜ往復まで見るか**: `Number("0583231")` も `parseInt("583231extra", 10)` も 583231 を返す。`isGitHubUserAllowed()` は数値に落としてから `String(numericId) === エントリの数字` で比べる作りなので、素朴なパースだとこの2種類が通ってしまう。最後に正規形と突き合わせれば両方まとめて落ちる（この2つはそれぞれ実際に変異テストで確認した。`docs` ではなくテスト側の `githubNumericIdFromUserId` ブロックが固定している）。

**`undefined` を返したとき何が起きるか**: `isGitHubUserAllowed()` は `numericId != null` を要求するので、`github:<数値ID>` エントリには一致しなくなる。一方 `login` は別引数なので、ログイン名エントリでの一致は妨げない。つまりフェイルクローズ側に倒れるだけで、正規の利用者を締め出さない。

**現実には起きない形まで落としている理由**: `props.user_id` を書き込むのは `/callback` の `githubUserId()` だけで、そこは正の整数をアサートしている。それでも厳しくするのは、`github:` プレフィックスが「他の IdP と衝突しないための予約」だと `githubUserId()` 自身が宣言しているから —— 将来 `google:` が入ったときに、この関数が黙って同じ数字を通すようでは予約の意味が無い。

**ソース位置**: `allowlist.ts` の `githubNumericIdFromUserId()`（呼び出し元は `mcp.ts` の `isIdentityAllowed()`）

---

## config.ts

### offline_access を scopes_supported に含めない理由

**経緯**: MCP 仕様の最終版（Refresh Tokens）は、リソースサーバーが `offline_access` を advertise すべきではない（SHOULD NOT）としている。リフレッシュはクライアントと AS の関心事であり、リソース自体の要件ではないため。

**対応**: `SCOPES_SUPPORTED` にはサーバーの基本機能をカバーする1スコープ（`todo`）のみを載せる。`scopes_supported` は「基本機能に必要な最小集合」を示すものであり、全カタログではないという仕様のガイダンスに従っている。

**補足**: `offline_access` を advertise しなくても、リフレッシュトークン自体は動作する（workers-oauth-provider が authorization_code グラント発行時に付与する）。advertise しないことと機能を提供しないことは別の話。

**ソース位置**: `config.ts` の `SCOPES_SUPPORTED`

---

## redirect-uri.ts

### [M-4] redirect_uri ポリシーをファイルとして切り出し、DCR/CIMD 両方に適用

**問題**: workers-oauth-provider 自体の DCR（Dynamic Client Registration）は、危険なスキーム（`javascript:`, `data:`, `file:` など）を数個ブロックするだけで、それ以外の redirect_uri（非ループバックの平文 http や任意のカスタムスキームなど）はそのまま受け入れてしまう。さらに、CIMD（Client ID Metadata Document）経由のクライアントは `redirect_uris` を `/authorize` 実行時にこのサーバー自身が取得したドキュメントから得るため、DCR 登録時のフック（`clientRegistrationCallback`）を一切通らない。ポリシーを DCR 登録時にしか実装しないと、CIMD クライアントはノーチェックのまま通ってしまう。

**対応**: 判定ロジックを `isAllowedRegistrationRedirectUri()` としてこの独立ファイルに切り出し、DCR 登録（`index.ts` の `clientRegistrationCallback`）と CIMD/通常フローの入口（`GET /authorize`、`github-handler.ts`）の両方から同じ関数を呼ぶ。許可するのは https（本番用）、またはループバックアドレスに限定した http（RFC 8252 §7.3、ローカル CLI 用）のみ。

**ソース位置**: `redirect-uri.ts` の `isAllowedRegistrationRedirectUri()`（呼び出し元: `index.ts` の `clientRegistrationCallback`、`github-handler.ts` の `GET /authorize` ハンドラ）

---

## types.ts

### Props に GitHub の upstream アクセストークンを持たせない

**方針**: MCP 仕様は「クライアントのトークンを upstream API にそのまま渡してはならない」としている。

**対応**: GitHub OAuth の scope は空（アイデンティティ取得のみ）にしており、コールバック後に GitHub へ追加で呼ぶ用事がない。そのため upstream アクセストークンをそもそも `Props` に保存しない。

**なぜこの形**: 保存していなければ渡しようがない（持っていないトークンは漏洩のしようがない）。これにより todo-mcp 自身のトークンが漏れた場合の被害範囲を todo-mcp 自体に限定できる。

**ソース位置**: `types.ts` の `Props` 型

### [scope enforcement] props.scopes とその強制ポイント

**経緯**: `index.ts` の `onError()` は 401 レスポンスに必ず `scope="todo"` を付与している（RFC 6750 §3）が、これはあくまでクライアントへの案内であって、それだけではリソースサーバー側の強制にはならない。

**対応**: `/callback` 時に `resolveGrantedScopes()` で計算した実際の付与スコープを、grant の `scope` と props の `scopes` の両方に反映させる。`mcp.ts` の `mcpApiHandler` がリクエストごとに `props.scopes` を `SCOPES_SUPPORTED` と突き合わせてチェックする。これが 401 の `scope="todo"` 案内を裏付ける実際の強制ポイント。

**ソース位置**: `types.ts` の `Props.scopes`（強制ロジック本体は `mcp.ts` の `hasRequiredScope()` / `mcpApiHandler`）

---

## approval.ts

### consent フローの順序（confused deputy 対策）とテンプレートからの改変点

**出典**: Cloudflare 公式テンプレート（`cloudflare/ai` の `demos/remote-mcp-github-oauth/src/workers-oauth-utils.ts`）を土台にしている。workers-oauth-provider 自体は UI を描画せず、`defaultHandler` 側が同意画面を持つ。

**順序**（MCP の confused deputy 対策が要求し、このファイルもテンプレートから継承している）:
- `GET  /authorize` → CSRF クッキーを発行するだけで、まだ何も承認しない
- `POST /authorize` → ユーザーが Approve を押した後で初めて、approved-client クッキーと state 紐付けクッキーを発行し、そのときだけ GitHub へ転送する

つまり、サードパーティへのリダイレクトの前に必ずクライアントごとの同意を取る、という順序を厳守する。

**テンプレートからの意図的な改変点**: 同意画面には「クライアントの登録済みリスト」ではなく「今回のリクエストが実際に持つ redirect_uri」を表示し、ループバック URI には警告を出す。MCP の CIMD セキュリティ節は、redirect URI のホストを表示することを MUST、ループバック警告を SHOULD としている。RFC 8252 のループバックポートは可変なため、登録済みリストだけでは実際に使われるポートを表示できない。

**ソース位置**: `approval.ts` ファイル冒頭のモジュール doc コメント

### [M-1/P1-1] state 不透明トークン化と所有者束縛

**問題**: 認可リクエストそのもの（client_id、redirect_uri、scope 等）をブラウザ経由の POST フォームに載せて往復させると、フォームの改ざんや再送でリクエスト内容をすり替えられる恐れがある。

**対応（不透明トークン化）**: `GET /authorize` でリクエストを検証した直後、その内容を KV に「まだ `approved: false` の」レコードとして保存し、ランダムな不透明トークン（`stateToken`）を発行する。同意フォームはこのトークンだけを持ち回す。`POST /authorize` はトークンで KV を引き直し、`approved` を true に変える。ここで一切、フォームからリクエスト内容を再構築しない。`/callback` 側の `validateOAuthState()` は `approved: false` のままの state を拒否する。

**所有者束縛（state ownership）**: state にひもづく CSRF トークンのハッシュ（`csrfTokenHash`）を作成時に KV へ一緒に刻む。`approveOAuthState()` は、渡された CSRF トークンがこのハッシュと一致する場合のみ承認を許す。これは「CSRF クッキーとフォーム値が一致する」だけでは証明できない、「この `stateToken` を渡されたセッション自身が承認している」ことを保証するための追加チェック。`GET /authorize` のプレアプルーブ経路（同意画面を出さない）は CSRF トークンを最初から発行しないため、この場合は `csrfTokenHash: null` とし、「この state には CSRF 照合が不要」という意味で扱う（不一致とはみなさない）。

**state の生存期間上限（state lifetime cap）**: `approveOAuthState()` は KV の TTL を承認時に `STATE_TTL_SECONDS` 分だけ再セットする。これを繰り返し悪用すると、承認直前まで開きっぱなしにしたダイアログが state の実効寿命を `STATE_TTL_SECONDS` の約2倍まで伸ばせてしまう。そこで作成時刻（`createdAt`）を一度だけ記録し、以後書き換えない。`validateOAuthState()` はこの作成時刻をもとに、TTL の延長回数によらず state 全体の寿命を `STATE_TTL_SECONDS` 以内に固定する。

**拒否時の扱い（dialog denial）**: Cancel ボタンは（CSP が `script-src` を許可していないため）クライアントサイド JS の `history.back()` ではなく、同じフォームの submit（`decision=deny`）として実装している。拒否時は `approveOAuthState()` を一切呼ばず、`rejectOAuthState()` で state レコードを KV から即座に削除する。これにより、一度拒否された state はその後承認されることも、再度拒否されることもできなくなる（ワンタイム性の保証）。同意クッキーやセッション紐付けクッキーも発行せず、GitHub への転送も行わない。

**ソース位置**: `approval.ts` の `createOAuthState()` / `approveOAuthState()` / `rejectOAuthState()` / `validateOAuthState()`。呼び出し元は `github-handler.ts` の `GET /authorize` ハンドラ・`POST /authorize` ハンドラ・`GET /callback` ハンドラ

### [L-10] approved-clients cookie の件数上限

**問題**: 承認履歴を無制限に積み上げると cookie が際限なく肥大化する。また、このリストは「(client, redirect_uri) ペアが既に承認済みか」を判定する信頼リストとして使うものであり、いつ承認したかの記録（監査ログ）ではない。

**対応**: 直近 `APPROVED_CLIENTS_MAX_ENTRIES`（10）件だけを保持する。既存の同一キー（(clientId, redirectUri) ペア）があれば一旦取り除いてから末尾に追加し直すことで、再承認したペアは「最も新しく承認された」扱いとして末尾に移動する。単純に `Array.from(new Set(...))` するだけでは、`Set` は「最初の挿入位置」を保持してしまうため、この「最新化」の効果は得られない点に注意。

**ソース位置**: `approval.ts` の `addApprovedClient()`

### [L-3] base64url エンコードで UTF-8 バイト列を経由する理由

**問題**: `btoa()` / `atob()` は Latin-1 のコード単位しか扱えず、U+00FF を超える文字が入ると `DOMException` を投げる。approved-clients cookie の中身は `JSON.stringify([clientId, redirectUri])` というタプル文字列の JSON 配列で、CIMD の `client_id` URL が国際化ドメインを含む場合など、正当に Latin-1 外の文字が混ざりうる。

**対応**: 一度 UTF-8 バイト列にエンコードしてから `btoa` 相当の処理を行う（`base64UrlEncode()` / `base64UrlDecode()`）。

**補足**: base64url（RFC 4648 §5、パディングなし）を使うことで、Cookie ヘッダーでエスケープが必要になる `+` `/` `=` をそもそも値に含めない。

**ソース位置**: `approval.ts` の `base64UrlEncode()` / `base64UrlDecode()`

### [L-9] COOKIE_ENCRYPTION_KEY の強度チェック

**問題**: `COOKIE_ENCRYPTION_KEY` が未設定または短いと、approved-clients cookie の HMAC 署名が弱く、たやすく偽造・推測できてしまう。

**対応**: キーのインポート時点（`importKey()`）で32文字未満なら即座に例外を投げる。実質何も守っていない cookie を黙って発行するより、使用箇所で大声で失敗させる。

**ソース位置**: `approval.ts` の `importKey()`

### [L-2] 同意画面に Cache-Control: no-store を付ける理由

**問題**: 同意画面はリクエストごと・セッションごとの状態（クライアント情報、redirect_uri、CSRF クッキー）に依存する。共有キャッシュから配信されると、別セッション向けの内容を誤って返しかねない。

**対応**: レスポンスヘッダーに `Cache-Control: no-store` を必ず付与する。

**ソース位置**: `approval.ts` の `renderApprovalDialog()`

### [H-1] 同意は (clientId, redirect_uri) 単位で管理する

**問題**: 同意を clientId だけで管理すると、同じクライアントが後から（CIMD 経由などで）別の redirect_uri を持つようになった場合、その redirect_uri への同意を取らずに素通りしてしまう。MCP の CIMD セキュリティガイダンスは、同意画面で redirect URI のホストを表示することを MUST としており、あるホストへの同意が別のホストを黙って覆ってしまってはいけない。

**対応**: 承認済みリストのキーを `(clientId, redirectUri)` のペアにする（`approvalKey()`）。キーの結合には `${clientId}|${redirectUri}` のような文字列連結ではなく `JSON.stringify([clientId, redirectUri])` を使う。理由は、どちらのフィールドも任意の URL 文字列であり `|` を含みうるため、単純結合だと異なる (clientId, redirectUri) ペアが同じ結合文字列に衝突しうる。`JSON.stringify` は各要素を個別にエスケープするため、この曖昧さが生じない。

**追加のガード**: ループバックの redirect_uri（`127.0.0.1` 等）は「事前承認済み」高速経路の対象から常に除外する（`github-handler.ts` の `GET /authorize`）。ループバックポートは RFC 8252 §7.3 によりどのローカルプロセスでも待ち受けられるため、「かつて localhost の何かに同意した」という事実だけで「今 listen している別のプログラム」まで自動承認してはいけない。ループバック宛のときは常に同意画面を出し直す。

**ソース位置**: `approval.ts` の `approvalKey()` / `isClientApproved()`。`github-handler.ts` の `GET /authorize` ハンドラ（プレアプルーブ判定）

### CSP に form-action を入れない理由（リダイレクトチェーンの検査で2回壊れた実障害）

**問題**: Chrome の `form-action` CSP ディレクティブは、フォームの直接の送信先だけでなく、POST 後に発生するリダイレクトチェーンの*すべてのホップ*を検査する。この同意画面のフローは `POST /authorize`（自ドメイン）→ 302 で `https://github.com/login/oauth/authorize` → …（GitHub 側の認可）… → 302 `/callback` → 302 で MCP クライアント自身の redirect_uri へ、という多段リダイレクトになる。最後の redirect_uri は、ループバック CLI クライアントなら実行のたびに変わる任意のポート（RFC 8252）、CIMD クライアントならこのサーバーの管理外にある任意の https オリジンであり、事前に固定できない。自ドメイン＋`https://github.com` を許可リストに入れても、最後のホップ（クライアント自身の redirect_uri）はどちらでもないためブロックされてしまう。

**経緯（実障害）**: 予測不能なリダイレクト先を許可リストで表現する方法がない以上、`form-action` はこのページには正しく書けない。これは実際に、Claude Code の OAuth ログインを実ブラウザ（Chrome）で操作した際に Approve フローを2回壊した実障害として観測された。curl やユニットテストはブラウザ側のリダイレクトチェーン検査を再現しないため、どちらのテストでも検出できなかった。

**対応**: `form-action` ディレクティブを持たせず、代わりに `default-src 'none'`（デフォルトすべて拒否）＋ `style-src 'unsafe-inline'`（このページ自身のインライン `<style>` タグに必要な最小限の許可）で構成する。

**多層防御（dialog hardening）**: このページは `clientName` / `clientId` / リクエストの redirect_uri といったクライアント由来の文字列を描画するが、`sanitizeText()` / `sanitizeUrl()` で既にエスケープ済み。CSP はその上に重ねる第二層の防御で、将来の変更でエスケープ漏れが混入した場合の保険として機能する。

**ソース位置**: `approval.ts` の `renderApprovalDialog()`

---

## github-handler.ts

### [L-13] 認可拒否レスポンスの共通化（respondAccessDenied）

**問題**: 「認可が拒否されて grant が一切作られずに終わる」経路が2つある。①このサーバー自身の allowlist が GitHub アイデンティティを拒否する場合、②GitHub 自体が upstream の認可を拒否する場合（ユーザーが GitHub 側の同意画面で Cancel を押した、GitHub App が suspend されている等）。どちらも素の 403 やエラーステータスをクライアントに返すと、クライアント側に解釈する標準的な手段がない。

**対応**: 両方の経路を `respondAccessDenied()` に共通化し、RFC 6749 §4.1.2.1 に従って、クライアントの検証済み redirect_uri へ `error=access_denied`（と、あれば元の `state`）を付けてリダイレクトで返す。

**ソース位置**: `github-handler.ts` の `respondAccessDenied()`（呼び出し元: `GET /callback` の allowlist 拒否と GitHub-side denial）

### registrationSource() の判定は provider の isClientMetadataUrl() を踏襲

**説明**: client_id が「非 root パスを持つ https URL」なら CIMD（Client ID Metadata Document）、それ以外は KV 登録済みクライアント（`/register` 経由の DCR、または `OAuthHelpers.createClient` 経由）とみなす。判定条件は workers-oauth-provider 自身の `isClientMetadataUrl()` と同じにしている。ログでどちらの登録経路を通ったクライアントかを区別するために使う。

**ソース位置**: `github-handler.ts` の `registrationSource()`

### PKCE 素通り（provider の仕様） — parseAuthRequest() 自体は PKCE を強制しない

**問題**: workers-oauth-provider の `parseAuthRequest()` は、PKCE の強制や implicit フローの拒否を自分ではやらない。`code_challenge_method=S256` なのに `code_challenge` が欠けているリクエストもそのまま通してしまい、`completeAuthorization()` 側にも PKCE/implicit のガードは存在しない（`dist/oauth-provider.js` を確認して確定させた）。

**対応**: MCP は S256 PKCE 付きの authorization_code グラントを必須としているため、`response_type !== "code"` と「S256 かつ空でない `code_challenge` が揃っているか」を、`parseAuthRequest()` の直後・他の処理に触れる前に、このハンドラ側で明示的にアサートする。

**ソース位置**: `github-handler.ts` の `GET /authorize` ハンドラ

### [redirect_uri policy / CIMD parity] CIMD クライアントにも同じポリシーを適用

**問題**: `index.ts` の `clientRegistrationCallback` は同じ redirect_uri ポリシー（`isAllowedRegistrationRedirectUri`）を強制しているが、それは DCR 登録時にしか効かない。CIMD クライアントの `redirect_uris` は、`parseAuthRequest()` 実行時点でこのサーバーが取得したドキュメントから来るため、`clientRegistrationCallback` を一切通過しない。ここでもポリシーを検査しないと、CIMD クライアントは任意のスキーム/ホストの redirect_uri のまま `completeAuthorization()` まで到達してしまう。

**対応**: PKCE のアサート直後、KV に何もコミットする前に、`GET /authorize` でも `isAllowedRegistrationRedirectUri()` を検査する。

**ソース位置**: `github-handler.ts` の `GET /authorize` ハンドラ（詳細は `redirect-uri.ts` の設計ノートも参照）

### プレアプルーブ高速経路と state 生成の順序

**説明**: すでにこのブラウザで同一の (client, redirect_uri) ペアに同意済みの場合、同意画面はスキップするが、GitHub へ転送する前に新しいワンタイム state だけは必ず作り直し、セッションに紐付け直す。

承認済み判定に関わらず、検証済みリクエストはどちらの分岐に進む前にも必ず KV へ新しい不透明トークンとしてコミットされ、リクエスト自体がブラウザへ戻ることはない。プレアプルーブ経路は同意画面を描画しないため CSRF クッキーを一切発行せず、その場合の state は CSRF ペアリングなし（`csrfToken: null`）で作る。一方ダイアログ経路は、`createOAuthState()` がハッシュを作成時点で KV に刻めるように、CSRF トークンを先に生成してから渡す。これにより「これから同意画面を送るまさにそのセッション」に state を束縛する。

**ソース位置**: `github-handler.ts` の `GET /authorize` ハンドラ（`approval.ts` の state ownership 設計とセットで参照）

### [L-14] /callback 内のエラーを単一 catch に集約する理由

**問題**: state 検証より先の処理は、GitHub の token/user エンドポイントという2つの外部サービスと、OAuth プロバイダ自身の KV 操作を呼ぶ。これらの失敗モードがそのままクライアントに漏れると、スタックトレースやシークレットを含みかけのエラーメッセージ、未処理例外がそのまま露出しかねない。

**対応**: `GET /callback` ハンドラ全体を単一の try/catch で囲み、失敗はすべてこの1箇所の catch に集約して、汎用的な 502 メッセージのみ返す。

**ソース位置**: `github-handler.ts` の `GET /callback` ハンドラ

### [GitHub-side denial] GitHub 自身の拒否をアクセス拒否として扱う

**問題**: GitHub は自分自身の拒否（ユーザーが GitHub 側の同意画面で Cancel した、GitHub App が suspend されている等）を、`code` を付けずに `?error=...` だけを付けて返してくる。以前はこのチェックがなく、そのまま下の `exchangeGitHubCode()` の「code パラメータがない」分岐に落ち、素の 502 として表面化していた。これは実際の upstream 障害と見分けがつかず、クライアント側にも解釈する標準的な手段がなかった。

**対応**: code の交換に進む前に `?error=...` クエリの有無を確認し、あれば `respondAccessDenied()` で（GitHub 自身の拒否も）通常のアクセス拒否と同じ経路でクライアントへリダイレクトする。

**ソース位置**: `github-handler.ts` の `GET /callback` ハンドラ

### [P1-2/L-7] audience 補完と resourceMatchOriginOnly の対応

**問題**: RFC 8707 の `resource` パラメータを送ってこないクライアントがいる。これを補完しないと、そのクライアントのトークンは「audience 未設定」＝原理的にはこの AS が発行するどのリソースに対しても使えるトークンになってしまい、このリソースサーバー1つにスコープされない。

**対応（github-handler.ts /callback）**: `resource` が未指定なら、この呼び出し元リクエストの「裸のオリジン」（`new URL(...).origin`）を補って `completeAuthorization()` に渡す。既に `resource` を送ってきているクライアントの値は上書きしない。

**波及（index.ts の OAuthProvider 設定 resourceMatchOriginOnly）**: 上記の補完は「裸のオリジン」形状の resource を grant に刻む。一方この設定を true にしないと、`/token` の `resourceMatches()` は完全一致を要求するため、後から律儀に `resource=<origin>/mcp`（このサーバーの実際の apiRoute と一致するフルの値）を送ってきたクライアントが、自分自身の grant に対して `invalid_target` エラーになってしまう。`resourceMatchOriginOnly: true` にして scheme+host+port だけの比較にすることで、この非対称性を解消する。

**ソース位置**: `github-handler.ts` の `GET /callback` ハンドラ（audience 補完）、`index.ts` の `OAuthProvider` 設定（`resourceMatchOriginOnly`）

### [scope enforcement] grantedScopes を一度だけ計算し、grant と props の両方に使う

**問題**: grant の `scope` と props 側の `scopes` が食い違うと、「発行された grant の権限」と「実際に強制されるスコープ」がずれてしまう。

**対応**: `resolveGrantedScopes()` の結果を一度だけ計算し、`completeAuthorization()` の `scope` と `props.scopes` の両方にそのまま使い回す。

**ソース位置**: `github-handler.ts` の `GET /callback` ハンドラ（強制ロジック本体は `mcp.ts` の `hasRequiredScope()`）

### [09/複数端末] revokeExistingGrants の無効化は CIMD 経路にだけ掛ける

**問題**: `@cloudflare/workers-oauth-provider@0.8.3` の `completeAuthorization()` は、`revokeExistingGrants` が明示的に `false` でない限り、同じ `(userId, clientId)` の既存 grant を全て revoke する（`dist/oauth-provider.js`: `revokeExistingGrants !== false` の分岐 → `grant.clientId === clientId` だけで収集 → `revokeGrant()`）。CIMD（Client ID Metadata Document）では `client_id` はクライアント側のビルド定数で、Claude Code は端末を問わず同じ `client_id`（`https://claude.ai/oauth/claude-code-client-metadata`）を名乗る。松本さんの3台のマシンが同じ GitHub アカウントで認可すると `userId` も `clientId` も揃うため、1台が再認可するたびに他2台の grant が丸ごと消え、access token は 401 `invalid_token`、refresh token は 400 `invalid_grant` になっていた。

**対応**: `registrationSource(clientId) === "cimd"` のときだけ `revokeExistingGrants: false` を渡す。DCR / 事前登録クライアントには**渡さない**（provider 既定の revoke が効いたまま）。

**なぜ CIMD だけなのか**: この既定（再認可時に同一 user+client の既存 grant を revoke する）は DCR（Dynamic Client Registration）を前提にした設計で、`client_id` が登録ごとに発番される限り「この端末の古いセッションだけを切る」という本来の意味で正しく働く。CIMD では `client_id` がクライアント実装単位（＝ Claude Code というアプリそのもの）に固定されるため、同じコードが「自分の他の端末を全部ログアウトさせる」に化ける。壊れているのは CIMD 側だけなので、緩和も CIMD 側だけに掛ける。無条件に外すと、DCR クライアントにまで「古い grant と token が最大30日残る」という不要な認可緩和を掛けることになる。

**手放す性質とそれが軽い理由**: CIMD クライアントについてだけ、再認可のたびに古い grant を自動整理する挙動を手放す。ただし:
- Props に GitHub の upstream アクセストークンを持たせていない（本ファイル冒頭 `types.ts` の「Props に GitHub の upstream アクセストークンを持たせない」参照）ため、この既定が本来防ぎたい「古い upstream トークンが残り続ける」問題自体が起きない。持っていないトークンは漏洩しようがない
- 放置された grant も無期限には残らない（30日の絶対 TTL。下の「grant の30日は認可時点からの絶対値」項）
- 明示的に切りたい場合の手段は下の「端末を失くしたときに実際に打てる kill switch」項にまとめた。**ここに RFC 7009 だけを書くのは誤り**だったので分離した

**上流のその後**: `@cloudflare/workers-oauth-provider` v0.10.2 でもこの挙動・既定値は同じままで、ticket 13（v0.10.2 追従）でライブラリを上げても本項の対応は不要にならない。`revokeExistingGrants` は 0.3.0 の PR #144 で「同一 user+client の再認可ループ対策」として意図的に導入されたオプションで、CHANGELOG 自身が「複数端末で同時に concurrent grant を持たせたい場合は `revokeExistingGrants: false` を設定せよ」と明示している。つまりこれは修正待ちのバグではなく、ライブラリ側が用意した opt-out を呼び出し側が明示していなかっただけであり、バージョンを上げれば消える性質のものではない。

**テスト**: 2層に分かれている。どちらか片方だけでは足りない。
- `test/github-handler.test.ts` の「revokeExistingGrants は CIMD 経路にだけ渡す」— ハンドラが**登録経路で分岐している**ことを固定する。CIMD で `false`、DCR で**プロパティごと不在**（`false` でないこと、ではない。provider の分岐は `revokeExistingGrants !== false` なので `undefined` と `true` は同義になり、値だけ見ていると区別できない）
- `test/oauth-grants.test.ts` — `@cloudflare/workers-oauth-provider` の**実体**を動かし、「ライブラリがこのフラグを尊重する」ことを確かめる。渡した引数だけを見るテストは、ライブラリがフラグを無視するようになっても通ってしまう（プロパティの*改名*は型が捕まえるが、*意味の変更*は捕まえない）。ticket 13 で効くのはこちら。node プールで実ライブラリを動かすのに要った仕掛け（`cloudflare:workers` の仮想モジュール差し替えと `server.deps.inline`）は `packages/server/vitest.config.ts` に理由付きで書いてある

**ソース位置**: `github-handler.ts` の `GET /callback` ハンドラ、`completeAuthorization()` 呼び出し直前の `grantRevocationPolicy`

### [09/複数端末] 端末を失くしたときに実際に打てる kill switch は KV の token/grant 削除

上の緩和で手放したのは「再認可が古い grant を掃除してくれる」性質なので、「じゃあ端末を失くしたら何を打てばいいのか」に答えが要る。**結論から言うと、打てるのは KV のキーを直接消すことだけ**（`token:` を先、`grant:` を後。順序の理由は下の手順に書いた）。以下の2つは代わりにならない。

**RFC 7009 の個別 revoke は「失くした端末の refresh token」を要求する**。provider の revocation endpoint は token endpoint と同じ `/token`（`revocation_endpoint: tokenEndpoint`、`!body.grant_type && !!body.token` で分岐）で確かに動くが、`revokeToken()` は `body.token` から `userId:grantId:secret` を取り出し、`revokeRefreshIfOwned()` が `grantData.refreshTokenId === tokenId`（または `previousRefreshTokenId`）で照合する。つまり**対象マシンの refresh token を手元に持っていないと、その grant は revoke できない**。端末を紛失したというまさに revoke が要る場面では、その token は失った端末の中にある。「代わりに RFC 7009 がある」は、失われた当のものを要求している。

**`ALLOWED_GITHUB_USERS` からユーザーを外しても、失くした端末だけを切ることはできない**。チケット 15 以降、allowlist から外れたユーザーは `/mcp` のリクエストごとに 401 で拒否されるので、「そのユーザーを丸ごと止める」ことは allowlist だけでできる（KV を触る必要は無い）。ただし単位が**ユーザー**なので自分の他の端末も同時に止まり、しかも拒否は読み取りだけで grant を revoke しない判断をしている（mcp.ts の「[15] allowlist を `/mcp` のリクエストごとに再評価する」参照）ため、allowlist に書き戻すと**失くした端末の grant も一緒に生き返る**。端末単位で切る手段は、以下の KV 削除のままである。

> この段落は以前「外しても生きている grant は切れない」と書いていた。`isGitHubUserAllowed()` の呼び出しが `GET /callback` の1箇所しか無かった当時は正しかったが、チケット 15 で `withAllowlistGate()` が同じ照合をリクエストごとに行うようになったため無効になった記述。

**実際の手順**（`packages/server` で実行。namespace は `wrangler.jsonc` の `OAUTH_KV` バインディング）:

```sh
# 1) 生きている grant を列挙する（grant:<userId>:<grantId>）
npx wrangler kv key list --binding OAUTH_KV --prefix "grant:" --remote

# 2) 消す grant を選ぶ。どれがどの端末かは metadata では区別できないので、
#    expiration（= 認可時刻 + 30日）から「いつ認可した端末か」で当たりを付ける
#    → 判別が付かないときは全部消す。全端末が再認可すれば済む

# 3) 先に access token を消す。順序が逆だと穴が空く:
#    /mcp の検証（handleApiRequest）は token レコードだけを読み、grant:
#    キーを一切参照しない。grant だけ消しても未失効の access token は
#    最長1時間（accessTokenTTL 既定 3600 秒）そのまま通ってしまう。
#    provider 自身の revokeGrant() も token → grant の順で消している。
npx wrangler kv key list --binding OAUTH_KV --prefix "token:<userId>:<grantId>:" --remote
npx wrangler kv key delete "token:<userId>:<grantId>:<tokenId>" --binding OAUTH_KV --remote

# 4) grant 本体を消す（以後その端末の refresh は invalid_grant になる）
npx wrangler kv key delete "grant:<userId>:<grantId>" --binding OAUTH_KV --remote
```

**何もしなくても最長30日で失効する**（次項）。緊急でなければ待つのも選択肢。

**ソース位置**: 記録のみ（コード変更なし）。根拠は `dist/oauth-provider.js` の `revokeToken` / `revokeRefreshIfOwned`、および `isGitHubUserAllowed()` の呼び出し2箇所（`github-handler.ts` の `GET /callback` と `mcp.ts` の `isIdentityAllowed()`）

### [09/複数端末] grant の30日は認可時点からの絶対値で、refresh では延びない

**誤解しやすい点**: 「provider 既定の 720 時間（30日）で自然失効する」とだけ書くと、使い続ければ延びる（スライディング）ように読める。**延びない。**

- 認可コード交換時に一度だけ `grantData.expiresAt = now + refreshTokenTTL`（`refreshTokenTTL` は未指定なので既定 `720 * 60 * 60`）が入る
- `handleRefreshTokenGrant()` は `refreshTokenId` / `previousRefreshTokenId` を回転させて `saveGrantWithTTL()` で書き戻すが、**`expiresAt` を再代入しない**。KV 側も `{ expiration: grantData.expiresAt }` という絶対時刻で書かれる
- したがって refresh を何度繰り返しても期限は動かず、30日で `invalid_grant`（"Refresh token has expired"）になる

**帰結**: **各マシンが月に1回ほど認可し直す必要がある**。そして今回の修正の眼目は、その再認可が**端末ごとに独立して起きる**（1台の再認可が他端末を巻き込まない）ようにしたことにある。これを書いておかないと、30日後に出る 401/`invalid_grant` が今回の不具合の再発に見える。

**実測**（2026-08-08、本番 KV の read-only 確認）: 生きている grant は1本だけで、`expiration` は認可時刻のちょうど720時間後だった。1本しか無いこと自体が、修正前の「再認可のたびに他端末の grant が消える」症状とも整合する。

**ソース位置**: 記録のみ（コード変更なし）。根拠は `dist/oauth-provider.js` の `handleRefreshTokenGrant` / `saveGrantWithTTL` / `DEFAULT_REFRESH_TOKEN_TTL`

### [09/複数端末] purgeExpiredData を cron で回す必要がない理由

grant も token も KV の expiration 付きで書かれるので、期限が来れば KV 自身が消す。`purgeExpiredData()` が拾うのは**孤児**（client レコードが消えた grant / grant が消えた token）だけで、しかも**CIMD の grant は孤児掃除の対象から明示的に除外されている**（`!this.provider.isClientMetadataUrl(grantData.clientId)`）。CIMD には `client:<id>` レコードがそもそも存在しない（利用のたびにメタデータ文書を取り直す）ので、除外しないと全部孤児に見えてしまうためである。

このサーバの grant は事実上すべて CIMD 由来なので、cron を足しても掃除対象はほぼ空。**scheduled ハンドラは意図的に配線していない**。次に読む人が同じ検討を再走しないようにここに残す。

**ソース位置**: 記録のみ（コード変更なし）。根拠は `dist/oauth-provider.js` の `purgeExpiredData`（`purgeOrphanedGrants` 分岐）

---

## index.ts

### [M-4] DCR 登録の有効期限を 7日 から 90日（provider 既定値）に戻した経緯

**問題**: 以前は `clientRegistrationTTL` を7日に短縮していたが、リフレッシュトークンの有効期限は30日ある。登録 TTL がリフレッシュトークンより短いと、リフレッシュトークンがまだ有効なうちに `client:<id>` の KV レコードが先に失効してしまい、8日目以降の本来正常なはずのリフレッシュが `invalid_client` エラーになってしまっていた。

**対応**: `clientRegistrationTTL` をプロバイダの既定値である90日（`60 * 60 * 24 * 90`）に戻す。90日ならリフレッシュトークンの寿命を十分に上回る。

**補足**: そもそも CIMD クライアントはドキュメントを利用のたびに再取得するため、この TTL の影響を受けない。DCR 登録が KV に永久に溜まり続けるのを防ぐという当初の目的自体は、90日という有限の TTL でも引き続き達成される。

**ソース位置**: `index.ts` の `OAuthProvider` 設定（`clientRegistrationTTL`）

### allowPlainPKCE を false にする理由

**問題**: workers-oauth-provider は既定で `allowPlainPKCE` が true になっており（`dist/oauth-provider.js` の該当分岐: `allowPlainPKCE !== false ? ["plain","S256"] : ["S256"]`）、`code_challenge_method` が省略された場合も "plain" として扱ってしまう。MCP は S256 の PKCE を必須としている。

**対応**: `allowPlainPKCE: false` を明示することで、advertise するメソッドから `plain` を外すと同時に、PKCE 自体を必須にする。

**ソース位置**: `index.ts` の `OAuthProvider` 設定（`allowPlainPKCE`）

### clientRegistrationCallback — DCR 登録時のログと redirect_uri ポリシー強制点

**説明**: すべての DCR 登録をログに残す（`/authorize` まで到達しないクライアントの登録経路も見えるように）。何も返さなければ登録は許可される。

**[M-4]**: ここが `isAllowedRegistrationRedirectUri()` の実際の強制ポイントでもある。プロバイダ自体は危険なスキームの短いブロックリストしか持たないため、ここでチェックしないと平文 http や任意スキームの redirect_uri がそのまま登録され、後の `/authorize` で受理されてしまう。

**ソース位置**: `index.ts` の `OAuthProvider` 設定（`clientRegistrationCallback`）

### [M-2/P1-3] 401 レスポンスへの scope 追記

**問題**: 「未認証」と「認証はできているが todo スコープが足りない」を、クライアントが追加の往復なしに区別できるようにしたい。

**対応**: RFC 6750 §3 に従い、リソースサーバーが 401 に必要な scope を advertise する。`onError()` で `status === 401 && code === "invalid_token"` のとき、既存の `WWW-Authenticate` ヘッダーの末尾に `scope="todo"` を追記して返す。

**ソース位置**: `index.ts` の `OAuthProvider` 設定（`onError`）

### Origin ガードの配置場所と production でのスコープ限定

**目的**: MCP の transports 仕様が MUST としている DNS リバインディング対策。

**ポリシー**: `Origin` ヘッダーがない場合は許可する（MCP クライアントは通常 CLI やデーモンで、そもそも Origin を送らない。このヘッダーはブラウザ発のリクエストを識別するためのものだから）。`Origin` がある場合は、このホスト自身（またはローカル開発時はループバック名）と一致しなければ 403 で拒否する。これにより、`evil.example` 上のページが被害者のブラウザ経由でローカルに立てた MCP サーバーを操作するのを防ぐ。

**配置場所**: このガードは `OAuthProvider` より前段に置く。クロスオリジンのブラウザリクエストは、トークンの有無に関わらず拒否されるべきであり、認証より後ろでしか走らない transport レベルのガードはガードとして機能しない。`agents/mcp/server` 自体も独自の Origin チェックをより内側で行うが、こちらは資格情報の処理より前に拒否を発生させるために存在する。

**[L-1]**: パスの一致判定はプロバイダ自身の API ルート判定（`startsWith`）に合わせており、完全一致ではない。完全一致にすると、プロバイダが依然として保護対象 API ルートとみなす `MCP_ROUTE` 配下のサブパス（例: `/mcp/`）へのクロスオリジンリクエストがこのガードを素通りしてしまう。

**[production Origin scoping]**: `localhostAllowedOrigins()` は、この Worker 自身のホスト名がループバック名である場合（`wrangler dev` のローカル開発時）にのみ意味のある許可である。無条件に許可すると、ホスト名が絶対にループバックにならない本番デプロイでも `Origin: http://localhost:...` を許容してしまい、訪問者のマシン上でローカル開発サーバーを動かしている任意のページが、実際には本番環境が配信していないオリジンとしてこのガードを通過できてしまう。そのため、Worker のホスト名自身がループバックのときだけ `localhostAllowedOrigins()` を許可リストに加える。

**ソース位置**: `index.ts` の `originGuard()`

---

## mcp.ts

### [scope enforcement] hasRequiredScope — 401 の scope 広告に対応する実体

**問題**: `index.ts` の `onError()` はすべての 401 で `scope="todo"` を advertise している（RFC 6750 §3）が、これまではリソースサーバー側でトークンの実際の付与スコープをチェックする箇所が存在しなかった。認証済みのトークンであれば、`/callback` 時に `resolveGrantedScopes()` が実際に何を許可したかに関わらず、どのツールにも到達できてしまっていた。

**対応**: `hasRequiredScope()` で `props.scopes` に `"todo"` が含まれるかを確認し、含まれなければ `mcpApiHandler` がツール呼び出しに到達する前に 403（`insufficient_scope`）を返す。401 の `scope="todo"` advertise が暗に約束していた強制ポイントを、実際に実装したもの。

**ソース位置**: `mcp.ts` の `hasRequiredScope()` / `mcpApiHandler`

### whoami ツールの「到達不能パス」を敢えて残す理由

**説明**: `login`/`user_id` が取れないケースは、通常は起こり得ない（`OAuthProvider` がこのハンドラより先に未認証リクエストを拒否するため）。それでも偽のアイデンティティを返さず、ツールエラーとして表面化させることで、props 受け渡しの配線に将来リグレッションが起きた場合にすぐ気付けるようにしている。

**ソース位置**: `mcp.ts` の `whoami` ツールハンドラ

### mcpApiHandler を ExportedHandler 形状でラップする理由

**説明**: `OAuthProvider` の `apiHandler` は `fetch(request, env, ctx)` というシグネチャを期待するが、`createMcpHandler` が返すオブジェクトは `fetch(request, options)` という別シグネチャを持つ。両者をつなぐために薄いラッパーを用意している。

このラッパーはスコープ強制の場所でもある。`OAuthProvider` はこのハンドラを呼ぶ前に grant の props を復号して `ctx.props` に入れる（`index.ts` 参照）ため、`props.scopes` が使える最初のタイミングであり、リクエストがツールに到達する前に検査できる。

**ソース位置**: `mcp.ts` の `mcpApiHandler`

### [09] env をファクトリに渡す経路がないので deps をカリー化した

**問題**: Turso の接続情報は Worker の `env`（`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`）にしかない。しかし `agents/mcp/server` の stateless ハンドラは `env` をサーバーファクトリに一切渡さない。実装を読むと `callable = (request, _env, ctx) => serve(request, void 0, ctx)` となっており、ファクトリが受け取る `McpRequestContext` は `era` / `authInfo` / `requestInfo` の 3 つだけ（`agents/dist/handler-stateless-*.js` と `@modelcontextprotocol/server` の型定義で確認）。つまり 08 の「モジュールスコープで 1 回だけハンドラを作る」形のままでは、ツールから DB 設定に手が届かない。

**検討した選択肢**:

1. **モジュールスコープの可変変数に env を退避する**: `mcpApiHandler.fetch` の冒頭で `currentEnv = env` と書き、ファクトリから読む。差分は最小だが、リクエスト間で共有される可変状態が増える。同一 isolate 内で `env` は常に同じオブジェクトなので実害が出る確率は低いが、「なぜ安全なのか」がコードから読み取れない（暗黙の前提に依存する）。テストからも書き換えが必要になる。
2. **deps をクロージャで閉じ、ハンドラをリクエストごとに組み立てる**: `createTodoMcpServer(deps)` がファクトリを返す形にし、`mcpApiHandler.fetch` の中で `createMcpHandler(...)` を呼ぶ。共有される可変状態はゼロ。

**判断軸と結論**: ①共有可変状態の有無 ②テストからの注入しやすさ ③リクエストあたりのコスト。①②で 2 が勝ち、③ は「そもそも `McpServer` 自体がリクエストごとに作られる（stateless 設計の前提）」ので、その上に薄いハンドララッパーが 1 つ増えても誤差。2 を採った。

**波及**: `createTodoMcpServer` の呼び出し側（`test/mcp.test.ts` の 4 箇所）が `createTodoMcpServer(TEST_DEPS)` になった。既存テストは削除も無効化もしていない。

**ソース位置**: `mcp.ts` の `createTodoMcpServer` / `mcpApiHandler`

### [09] Turso 未設定のとき 500 ではなく openDb で投げる理由

**問題**: `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` が欠けたデプロイをどう扱うか。黙って空の結果を返すのは論外（モデルが「タスクは 0 件です」と人間に報告してしまい、設定ミスが観測できない）。

**検討した選択肢**: ①`mcpApiHandler` で 500 を返してリクエストごと落とす ②`openDb()` の呼び出し時に例外を投げる。

**判断**: ② を採った。① だと `initialize` / `tools/list` / `whoami` まで落ちる。`whoami` は「サーバーが自分を誰だと思っているか」を確認するための診断ツールで、設定ミスの調査でまさに使いたい道具。② なら DB に触るツールだけが失敗する。SDK はツールハンドラ内の例外を `isError` のツール結果に変換する（`mcp-*.mjs` の `tools/call` ハンドラが `createToolError(error.message)` を呼ぶ）ので、こちらが書いた日本語のメッセージがそのままモデルに届く。

**ソース位置**: `mcp.ts` の `tursoOpener()`、`turso.ts` の `tursoConfigFromEnv()`

### [09/レビュー] types.ts / turso.ts のコメントを実装に合わせて訂正した

**問題**: `types.ts` の `Env.TURSO_DATABASE_URL` フィールドコメントに「欠けている場合は 500 で落とす」、`turso.ts` の `tursoConfigFromEnv()` のコメントに「呼び出し側（mcp.ts）は 500 で明示的に失敗させる」という記述が残っていた。しかし実装（`mcp.ts` の `tursoOpener()`）は 500 を返さない —— DB 未設定時は `openDb()` 呼び出し時に例外を投げ、ツールハンドラ内の例外は SDK が `isError` のツール結果に変換する。`whoami` や `tools/list` は Turso に触れないためこの経路を通らず生存する。README や本ドキュメントの直上の項目（「[09] Turso 未設定のとき 500 ではなく openDb で投げる理由」）は正しい挙動を書いていたが、この 2 箇所のソースコメントだけが設計変更前の痕跡として矛盾したまま残っていた。

**対応**: 両コメントを「DB を触るツールだけが isError で失敗する。whoami / tools/list は生存する」という実装済みの挙動に揃えて書き直した。

**ソース位置**: `packages/server/src/types.ts`（`Env.TURSO_DATABASE_URL` のコメント）、`packages/server/src/turso.ts`（`tursoConfigFromEnv()` のコメント）

### [09/レビュー] 不正な `?workspace=` クエリ値をエラー文にエコーする

**問題**: `resolveDefaultWorkspace()` は `"work"/"life"` の厳密比較に外れた値をすべて `undefined`（＝「未指定」）に潰していた。接続 URL が `?workspace=lif` のようなタイプミスのとき、後続のツール呼び出しで workspace が未解決になっても、エラー文は「workspace=(未指定)」としか言えず、①本当にクエリを付け忘れているのか ②クエリはあるがタイプミスなのか、を区別できなかった。06 で確定したエラー文の 3 部品（①不正値のエコー ②期待する形式 ③アンカー）のうち①を満たしていない。

**対応**: `resolveDefaultWorkspace()` の戻り値を `Workspace | undefined` から `{ workspace, invalidValue }` に変え、「クエリ自体が無い」（`invalidValue: undefined`）と「クエリはあるが不正」（`invalidValue: <生の値>`）を区別して保持する。`TodoToolDeps.invalidWorkspaceQuery` として `todo-tools.ts` まで運び、`workspaceMissingError()` がこれを受け取って、値があれば `不正な値: workspace="lif"` のように実際に来た値をエコーし、無ければ従来通り「未指定」の文言を出す。期待する形式（"work" または "life"）と回復手順（URL の `?workspace=` を直す / ツール引数で明示する）は 3 部品構成のまま維持し、①だけを実効化した。有効な値（"work"/"life"）が来た場合の挙動は変えていない。

**波及（レビュー時の見落とし訂正）**: 当初この修正はツール 3 経路（get_agenda / upsert_task / search_tasks）にしか適用していなかったが、`today-agenda` MCP リソースハンドラ（get_agenda ツールとは別物）も同じ「既定 workspace が未解決」の分岐を持ち、こちらは修正前の `workspaceMissingError` 導入以前からある独自のハードコード文言（「既定 workspace が未設定のため表示できません」）をそのまま持っていた。ツール側だけ不正値をエコーしリソース側だけ「未設定」の一点張りになる非対称に理由がないため、`workspaceMissingError` と行配列を共有する `workspaceMissingText()`（プレーンテキスト版）を切り出し、リソースハンドラもこれを通す形に揃えた。ハードコード文言は削除し、`deps.invalidWorkspaceQuery` はツールと同じ経路（`TodoToolDeps`）でリソースハンドラにも届く。

**ソース位置**: `packages/server/src/mcp.ts` の `resolveDefaultWorkspace()`。エラー文の組み立ては `packages/server/src/todo-format.ts` の `workspaceMissingError()` / `workspaceMissingText()`、運搬経路は `packages/server/src/todo-tools.ts` の `TodoToolDeps.invalidWorkspaceQuery`（呼び出し元は 3 ツールハンドラと `today-agenda` リソースハンドラ）

### [15] allowlist を `/mcp` のリクエストごとに再評価する

**問題**: `isGitHubUserAllowed()` の呼び出しは `github-handler.ts` の `GET /callback` の **1 箇所しか無かった**。認可の瞬間にしか照合していないので、`ALLOWED_GITHUB_USERS` から外したユーザーは発行済みトークンでそのままアクセスし続けられる —— access token は最長1時間、refresh を回せば grant の30日いっぱい使える。**allowlist が「入口の鍵」であって「継続的な権限」ではない**状態だった。松本さん個人の運用では実害がほぼ無い（載っているのは本人1人で外す場面が無い）が、セルフホスト前提の OSS として公開すると、設定項目の意味と実際の効果が食い違っていることになる。

**対応**: OAuthProvider の `apiHandler` に渡すものを `withAllowlistGate()` で包み（index.ts の配線。理由は下の「[15/レビュー] ゲートを『配線の性質』にする」）、`ctx.props` の身元を `env.ALLOWED_GITHUB_USERS` と毎リクエスト突き合わせる。ゲートはルート単位なので、`/mcp` に来るものは JSON-RPC のメソッドを問わず全部くぐる —— `initialize` を含む 10 の JSON-RPC 経路（tools / resources / prompts / `whoami`）に加えて、非 POST（`GET` / `DELETE`）と JSON-RPC バッチもカバーされる（テストで固定した。何を選んだかは同テストのコメント）。**`/callback` 側の判定は外さない**。多層防御であって置き換えではなく、「外れたユーザーに新しい grant を作らせない」という入口の意味はそのまま要る。

**判断1: 拒否は 401 `invalid_token`（403 ではない）**

軸 —— ①MCP / OAuth の慣行 ②クライアント（Claude Code）が受け取った後に何をするか ③人間に状況が伝わるか。

- ① RFC 6750 が定義するのは3つだけ（`invalid_request` 400 / `invalid_token` 401 / `insufficient_scope` 403）。今回の拒否は「このトークンの権限の粒度が足りない」ではなく「このトークンの主体がもうこのサーバーを使えない」なので、`insufficient_scope`（"requires higher privileges than provided by the access token"）に当てはまらない。403 で返すと「もっと広い権限を取り直せば通る」という含意が嘘になる。`invalid_token`（"revoked, or invalid for other reasons"）が意味的に近い。
- ② MCP の Authorization 仕様は、401 を受けたクライアントは `WWW-Authenticate` の `resource_metadata`（RFC 9728）から認可サーバーを見つけて認可フローを開始する、としている。Claude Code の初回接続はまさにこの経路（トークン無し → provider の 401 → ブラウザが開く）で成立している。403 に対する既定の振る舞いは仕様に無く、単なる失敗として出る。
- ③ 401 なら再認証がブラウザで走り、`GET /callback` の allowlist に当たって `access_denied` で返る。「もう許可されていない」が人間の目に見える形で出る。403 だと CLI 上の不透明なエラーで終わり、外された本人にも運用者にも理由が伝わらない。

3軸とも 401 側なので 401 にした。ヘッダーは provider 自身の 401（`buildWwwAuthenticateHeader` / `handleApiRequest`）と同じ形に揃え、`resource_metadata` を必ず載せる。末尾に `scope="todo"` を足すのは index.ts の `onError()`（[M-2/P1-3]）と同じ理由・同じ形にするため。

**この選択で受け入れたもの**: 外された人の端末は「ブラウザが開く → 拒否される」を繰り返す可能性がある。これは避けたいコストではなく③で欲しかったものそのもの（黙って失敗し続けるより、拒否が見えるほうがよい）。

**未検証**: Claude Code が実際にこの 401 でブラウザを開くところは、デプロイしないと観測できない（チケット 15 の作業はデプロイ禁止）。根拠は仕様と、同じ形の 401 で初回認証が現に成立している実績まで。

> **README との整合（レビュー指摘、訂正済み）**: README は当初「許可リストに書き戻せばそのまま元に戻る（トークンを revoke しないため、端末の再認可も要らない）」と断定していた。前半（grant を消さない・`/token` に allowlist 判定が無い ＝ サーバーは同じトークンを再び受け付ける）はサーバー側で検証済みだが、**後半はクライアント側の挙動**（401 を受けた端末がキャッシュ済みの grant を捨てるかどうか）で、このリポジトリの管轄外。同じ理由で「クライアントはこの 401 で再認証を試み」も断定できない —— それこそがこの「未検証」の中身だから。README をサーバー側で確かめた範囲と、クライアント依存の範囲に分けて書き直した。

**判断2: 拒否時に grant / token を revoke しない**

軸 —— ①拒否そのものの強度に効くか ②誤りからの回復可能性 ③読み取り経路に書き込みを増やすコスト ④運用の手間（KV の手動削除が要るか）。

- ① 効かない。毎リクエストで拒否する以上、生きているトークンで通せるリクエストはもう無い。revoke が足すのは「このチェック自体が将来壊れたとき」の保険だが、チェックが動いているときにしか発火しない機構なので、まさにその場面では役に立たない。
- ② ここが決め手。revoke は不可逆。allowlist の設定ミス（タイプミス、secret の消失、一時的に外して戻す運用）で誤って発火すると、全端末の grant が消え、**全端末が再認可**しないと戻らない。revoke しなければ、`ALLOWED_GITHUB_USERS` を直した瞬間に何事もなく元に戻る。フェイルクローズ（未設定＝全員拒否）と組み合わせると差は大きい —— secret を入れ忘れたデプロイが「全 grant の破壊」を意味するかどうかが変わる。
- ③ revoke しなければ、拒否は「判断して返すだけ」の経路のままにできる。revoke するなら `OAuthHelpers.revokeGrant(grantId, userId)` が要るが、`handleApiRequest` が `ctx` に載せるのは `props` だけで grantId は無い（`dist/oauth-provider.js` で確認）。取るには Authorization ヘッダを自前で `userId:grantId:secret` に割って provider のトークン形式に依存するか、`unwrapToken()` で KV 読み+復号をもう一往復するかになる。どちらも、provider が既に検証した資格情報をこちらで再解釈する形になる。
- ④ 手動削除の必要性はこの変更自体で消えている。外した人を止めるのに KV を触る必要はもう無い（下の kill switch 項を訂正した）。KV に残る grant は最長30日で自動失効し、その間ずっと 401 で拒否され続ける。

②が決定的で、①が「得るものがほぼ無い」ことを示したので revoke しない。`revokeGrant` が呼ばれないことをテストで固定した。

**判断3: 照合キーは `props.login` と、`props.user_id` から復元した数値 ID の両方**

軸 —— ①入口 `/callback` と同じ許可集合になるか ②`props` からの復元経路が誤って広がらないか ③運用者が書いた記法（ログイン名 / `github:<数値ID>`）のどちらでも効くか。

`/callback` と**同じ** `isGitHubUserAllowed(login, id, raw)` に通す（①③）。判定関数を分けると入口と毎リクエストで許可集合がずれ得るし、フェイルクローズの扱いも二重管理になる。②のために、`props.user_id` からの復元は正規形だけを受ける `githubNumericIdFromUserId()` を新設した（allowlist.ts の [15] の項）。

**未設定・空のときの挙動**: `isGitHubUserAllowed()` の既存の扱い（フェイルクローズ）をそのまま引き継ぐ。「未設定なら発行済みトークンだけは通す」という例外は作らない —— 作ると、secret を失ったデプロイが「新規は誰も入れないが既存トークンは全部通る」という、どちらの意図とも違う状態になる。**帰結として、`ALLOWED_GITHUB_USERS` を空にした瞬間に既存トークンも全部止まる**。これは本チケットの不変条件（外した人は通らない）が「全員を外す」場合にも及ぶというだけで、意図した挙動。テストで固定してある。

**`whoami` も対象にした**: 診断ツールだが素通しにしない。Turso 未設定のときに `whoami` を生かしているのは「サーバーの設定ミスを運用者が診断する」ためで、今回は設定通りに動いている状態にあたる。困っているのは運用者ではなく外された本人であり、その人に返すべき答えは身元の確認結果ではなく「もう許可されていない」（＝ 401 とその後の再認証拒否）。ゲートを1つでも開けると「外されたユーザーは `/mcp` が通らない」という不変条件が「1つのツールを除いて」になる。401 の本文にログイン名を含めないことも合わせてテストで固定した。

**ホットパスのコスト**: リクエストごとに `ALLOWED_GITHUB_USERS`（数十バイト）を split / trim / toLowerCase する。同じリクエストで provider が既に行っている SHA-256（token id 生成）・AES 鍵アンラップ・props 復号や、`createMcpHandler` + `new McpServer` + Zod スキーマ6本の登録に比べれば計測に出ない。env 由来の結果をモジュールスコープにキャッシュする案は採らない —— [09] で「リクエスト間で共有される可変状態を増やさない」と決めた形を、このためだけに崩す価値が無い。

**ソース位置**: `mcp.ts` の `isIdentityAllowed()` / `allowlistDenialReason()` / `identityNotAllowedResponse()` / `withAllowlistGate()`、配線は `index.ts` の `apiHandler`（入口側の判定は `github-handler.ts` の `GET /callback` に残置）

### [15/レビュー] ゲートを「配線の性質」にする（withAllowlistGate）

**問題1（順序が何にも守られていなかった）**: 判定は「scope チェックより先」に置いてあり、mcp.ts のコメントにも本ドキュメントにも理由つきで書いてあった。ところが**その順序を守っているか確かめるものが何も無かった** —— レビュアがブロックを scope チェックの後ろに動かす変異を当てたところ、171 件のテストが全部通った。allowlist のテストはどれも `todo` scope 付きのトークンを持ち、scope のテストはどれも許可リストに載った身元で、**両方に落ちるトークン**を誰も試していなかったから。順序が逆だと、scope を持たず allowlist からも外れたユーザーが `403 insufficient_scope` を受け取る。これは「もっと広い権限のトークンを取り直せば通る」という嘘の含意になり、401 を選んだ理由（判断1 の③、「もう許可されていない」が人間に見える）がその経路で失われる。

**問題2（ゲートが 1 関数の本体の性質だった）**: 判定は `mcpApiHandler.fetch` の**中**にあった。provider は `apiHandlers`（route → handler のマップ）も受け付けるので、将来 2 本目の認証済みルートを足した人は、ゲートを掛けたつもりが無いまま同じトークンで通せるハンドラを公開できる。「認証済みの全ルートが allowlist を再評価する」という不変条件が、mcp.ts の本文だけで担保されていた。

**対応**: 判定を `withAllowlistGate(handler)` というラッパーに出し、index.ts で `apiHandler: withAllowlistGate(mcpApiHandler)` と配線する。

- 順序は**構造で**決まる。ラッパーは中のハンドラより必ず先に走るので、allowlist は `mcpApiHandler` の中にある scope チェックより常に先。
- ルートを足す人は provider に渡すものを書く時点で「ゲートを掛ける／掛けない」を明示的に選ぶことになる。
- ただし「構造的に不可能」ではない（`apiHandlers: { "/x": bareHandler }` と書けてしまう）ので、テストで塞ぐ: `test/wiring.test.ts` が provider の構築オプションを捕まえ、`apiRoute`+`apiHandler` か `apiHandlers` かを問わず**設定されている全ハンドラ**に外された身元のリクエストを通して 401 を要求する。ルートが増えればそのルートも自動的に検査対象になる。
- 順序のほうは `test/mcp.test.ts` の「the allowlist is evaluated before the scope check」で固定した。`scopes: []` かつ allowlist 外のトークンが 401 `invalid_token`（403 `insufficient_scope` ではない）を受け取ること、および同じ props で allowlist に載っていれば 403 が返ること（＝ scope チェックが生きていること）の両方を見る。

**検証**: 上の 2 つの変異（ゲートを scope の後ろに移す／素の `mcpApiHandler` を配線する）を実際に当て、それぞれ対応するテストだけが落ちることを確認した。

**ソース位置**: `mcp.ts` の `withAllowlistGate()` / `ApiHandler`、`index.ts` の `apiHandler`、`test/wiring.test.ts`

### [15/レビュー] refresh_token 時の allowlist 照合（tokenExchangeCallback）を採らない

**指摘**: `/mcp` のゲートが効いていても、外されたユーザーは `refresh_token` で新しい access token を発行し続けられる（grant の残り最長 30 日）。`tokenExchangeCallback` で `grantType === "refresh_token"` のときに allowlist を照合し `OAuthError` を投げれば、grant が能力として生きたままになるのを防げる。

**軸** —— ①今ある不変条件に何を足すか ②既存の制約（リクエスト間の可変状態を持たない）の中で実装できるか ③設定ミスからの回復可能性 ④ポリシーの強制点が何箇所になるか。

- ① ほぼ何も足さない。守りたいのは「外された身元はこのサーバーを使えない」で、`/mcp` の全リクエストが拒否される以上、refresh で得た access token で通せるリクエストはもう無い。増えるのは「grant を能力として早く畳む」ことだけで、それは判断2（revoke しない）で一度「毎リクエストで拒否している以上、得るものがほぼ無い」と評価した性質と同じもの。
- ② 実装できない。`TokenExchangeCallbackOptions` が渡すのは `grantType` / `clientId` / `userId` / `grantId` / `scope` / `requestedScope` / `props` だけで、**`env` も `request` も無い**（dist の 3 箇所の呼び出しと .d.ts で確認）。provider は index.ts のモジュールスコープで 1 度だけ構築されるので、コールバックのクロージャからリクエストごとの `env.ALLOWED_GITHUB_USERS` は見えない。取る手は 2 つしかない —— (a) `fetch()` の中で env をモジュール変数に退避する（[09] と本項の「ホットパスのコスト」で 2 度却下した「リクエスト間で共有される可変状態」そのもの）、(b) provider をリクエストごとに構築し直す（全エンドポイントの配線をこの 1 件のために変える）。
- ③ 悪化する。`/token` が `invalid_grant` を返すのは、クライアントにとって「この grant は死んだ、捨てて認可し直せ」の合図。フェイルクローズ（未設定＝全員拒否）と組み合わせると、secret を落としたデプロイが**全端末に grant を捨てさせる**ことを意味する。判断2 が軸②（誤りからの回復可能性）で避けたのはまさにこの不可逆性で、revoke ほど直接的でないだけで向きは同じ。
- ④ 現在 2 箇所（`/callback` の入口、`/mcp` の毎リクエスト）で、どちらも同じ `isGitHubUserAllowed()` を通している。`/token` を足すと 3 箇所になり、フェイルクローズの扱いを揃え続ける面が増える。①がその対価をほぼゼロと評価している。

**結論: 採らない**。②が単独でほぼ決定的（既存の制約を壊さずには書けない）で、書けるようにした版は③で判断2 が退けた不可逆性を持ち込む。①がその対価に見合うものを返さない。

**受け入れたもの**: 外されたユーザーの grant は KV に最長 30 日残り、その間 refresh で access token を作れる。作れるだけで、`/mcp` はその token を全部拒否する。端末単位で即座に畳みたい場合の手段は従来どおり KV のキー削除（[09/複数端末] の kill switch 項）。

### [15/レビュー] 拒否の理由はログでだけ分ける（応答は同一）

**問題**: `ALLOWED_GITHUB_USERS` が未設定・空だと全員拒否になる（フェイルクローズ、意図どおり）。ただしチケット 15 以降、それは「新規の認可だけが止まる」ではなく「**稼働中の全マシンが即座に全停止**」を意味する。しかも `wrangler.jsonc` はこの名前を意図的に `vars` に出しておらず（`vars` に同名があるとデプロイのたびにシークレットを上書きするため）、起動時の検証も無い。secret を落としたデプロイは何のエラーも出さずに自分を締め出す。

**対応**: ログ行に `reason` を足し、`allowlist_empty`（誰も載っていない ＝ 設定事故）と `identity_not_listed`（載っていない身元 ＝ 意図した除名）を区別する。

**応答は区別しない**。「設定が空です」を応答に出すと、未認可の相手にサーバーの構成情報を渡すことになる。401 の本文・ヘッダー・ステータスは 2 つのケースで完全に同一で、テストがそれを固定している（`keeps the two refusals identical on the wire`。理由の文字列が応答のどこにも現れないことも見る）。

**判定と理由付けを分けた**: `allowlistDenialReason()` はまず `isIdentityAllowed()` を呼び、**拒否が確定してから**理由を分類する。分類側に条件を書くと、判定と分類で許可集合がずれ得る（`/callback` と同じ関数を通す、という判断3 の意図が理由付けの側から崩れる）。

**ソース位置**: `mcp.ts` の `AllowlistDenialReason` / `allowlistDenialReason()` / `withAllowlistGate()`、運用者向けの読み方は README の「運用者向けメモ」

### [15/レビュー] provider の応答形を手で組み直している箇所の正本と drift 検出

**問題**: `identityNotAllowedResponse()` は `resource_metadata` URL と `WWW-Authenticate` を、provider の `buildWwwAuthenticateHeader()` / `handleApiRequest()` とは別に組み立て直している。今はバイト単位で一致しているが、それを保証しているものが無く、ライブラリがヘッダ形式を変えれば黙って乖離する。乖離すると、provider の形しか解釈しないクライアントはこの 401 を「再認証せよ」と読まなくなる —— 判断1 の②がそこに乗っている。加えて、provider が `createErrorResponse()` で全エラー応答に付けている `NO_CACHE_HEADERS`（`Cache-Control: no-store` / `Pragma: no-cache`）が、こちらの 401 にも既存の `insufficientScopeResponse()` の 403 にも付いていなかった。

**対応**:

- 両方の応答に `NO_CACHE_HEADERS` を付けた。認証エラーは同じ URL への次のリクエストで結果が変わり得る（allowlist に書き戻した直後）ので、中間キャッシュに保持させない。
- 正本がどれかをコメントで名指しした: `buildWwwAuthenticateHeader()`（ヘッダ本体）、`handleApiRequest()`（`resourceMetadataUrl` の組み立て）、`createErrorResponse()` + `NO_CACHE_HEADERS`（キャッシュ抑止と本文の形）。いずれも `@cloudflare/workers-oauth-provider` の `dist/oauth-provider.js`。
- コメントだけでは気付けないので、`test/provider-response-shape.test.ts` が**実ライブラリ**を動かして突き合わせる。`OAuthProvider` に Authorization ヘッダ無しの `/mcp` リクエストを渡すと `handleApiRequest()` の 401 が出るので、その `WWW-Authenticate` のうち `error_description` の手前まで（スキーム・realm・`resource_metadata`・エラーコード）をこちらの 401 が前方一致で再現していること、no-cache ヘッダが一致すること、本文が同じ 2 フィールドであることを見る。設計上の差分（`error_description` の中身と末尾の `scope=`）はテストに明示してあるので、drift と区別できる。

`test/oauth-grants.test.ts` と同じ狙い —— **ライブラリを上げるチケット 13 で効くテスト**。実 dist を node プールで動かすのに要る 2 点（`cloudflare:workers` の仮想モジュール差し替えと `server.deps.inline`）は vitest.config.ts に理由つきで書いてある。

**ソース位置**: `mcp.ts` の `NO_CACHE_HEADERS` / `identityNotAllowedResponse()` / `insufficientScopeResponse()`、`test/provider-response-shape.test.ts`

---

## packages/core

### [09] core / server の境界をどこで切ったか

**方針**: core に入れるのは「MCP サーバーと CLI（チケット 11）で同一でなければならないもの」だけ。

- **core**: workspace / status の Zod enum、`Task` 型、Turso クライアント生成、tasks への SQL 全部、時刻（保存フォーマットと「今日」の JST 境界）
- **server**: ツール定義、tool description、行形式 `#id [status] title (due) {project} +memo` の整形、エラー文の組み立て

**なぜこの線**: 表示は「誰に読ませるか」で形が変わる。MCP の応答はモデルに読ませる中間表現で、実会話の観察（07）ではモデルがそれを人間向けの Markdown テーブルに再整形していた。CLI は端末で人間が直接読む。共有すると両方が歪む。逆に「今日」の境界を共有しないと、同じタスクが MCP では期限切れ・CLI ではまだ間に合う、という食い違いが起きる。

**upsert の扱い**: core には `createTask` / `updateTask` の 2 本を置き、「id があれば更新・無ければ作成」の分岐は server 側に残した。`title` の必須性が 2 つのケースで違い（作成では必須、更新では任意）、その必須性違反を伝えるエラー文が MCP 固有だから。SQL はすべて core にある、という本来の要件は満たしている。

### [09] user_id スコープを「grep で確認できる」形に保つ

**問題**: 全クエリに user_id 条件を入れる、という規律は書き忘れれば破れる。破れたときの結果は「他人のタスクが見える／書き換わる」で、静かに起きる。

**対応**: ①SQL を `packages/core/src/tasks.ts` の 1 ファイルに閉じ込める（server 側に生 SQL を書かない）②SELECT / UPDATE は `WHERE user_id = ?` を**リテラルとして**SQL 文字列に持たせる ③INSERT は列リストの先頭に user_id を書く。この形なら、テンプレートリテラルを機械的に抜き出して user_id の有無を判定できる。

**実際に見つかった穴**: 最初の実装では `searchTasks` だけが `conditions` 配列を `join(" AND ")` する形で、`user_id = ?` も配列の 1 要素だった。機械チェックにかけると、この 1 文だけが「user_id 条件なし」と判定された（実行時には正しく効いていた）。条件の並べ替え 1 つで静かにスコープが外れうる形でもあったため、固定部分 `WHERE user_id = ? AND workspace = ?` をリテラルに戻し、可変の絞り込みだけを ` AND ...` として連結する形に直した。**チェックのために書き方を変えたのではなく、チェックが本物の脆さを指した。**

**ソース位置**: `packages/core/src/tasks.ts` 全体、特に `searchTasks()`

### [09] TaskDb を最小インターフェースにして node:sqlite でテストする

**問題**: クエリ関数のテストで守りたいのは「関数が期待どおりの SQL 文字列を組み立てたか」ではなく「その SQL が他人の行を 1 行も返さない・書き換えないか」。SQL 文字列を突き合わせるモックでは、WHERE 句の抜けを検出できない（モックは書かれたとおりに答えるだけ）。

**対応**: core が要求する DB 面を `all()` / `get()` の 2 メソッドだけに絞り、`@tursodatabase/serverless` の `Connection` がそのまま構造的に満たす形にした。テストは同じ形を `node:sqlite`（Node 22 に同梱、in-memory）で実装して渡す。DDL は `packages/core/schema.sql` を読み込むので、Turso に流したのと同じスキーマに対して本物の SQLite が SQL を実行する。

**副次的な制約**: `node:sqlite` の型は `@types/node` から来るため、この import は core の test ディレクトリに閉じ込めてある。server 側の tsconfig は `types: ["@cloudflare/workers-types"]` で node 型を持たない（両者を同じプログラムに混ぜるとグローバルが衝突する）ので、server のテストからは in-memory DB を使えない。ツール層の実挙動は `wrangler dev` + 実 Turso のスモークテストで確認する、という分担にしている。

**ソース位置**: `packages/core/src/db.ts` の `TaskDb`、`packages/core/test/support/sqlite-task-db.ts`

### [09] 書き込みを全部 RETURNING にした理由と往復回数

**問題**: Workers から Turso への 1 クエリは 1 回の HTTPS 往復。INSERT / UPDATE のあとに書いた行を読み直すと、それだけで往復が倍になる。

**対応**: `INSERT ... RETURNING` / `UPDATE ... RETURNING` を使い、書いた行をその場で受け取る。結果として `TaskDb` に `run()` が不要になり、面が `all()` / `get()` の 2 つに減った。

**現在の往復回数**: 作成 1 / 更新 2（現在値の SELECT → UPDATE）/ 完了 1（UPDATE のみ。ただし id が存在しない・既に done だった場合は UPDATE 0 行 → 読み直しで 2）/ 一覧・検索・詳細 各 1。更新系が 2 なのは、応答に「実際に変わった列」を出すために変更前の値が要るから。この差分表示は、AI が同じ更新を繰り返したときに人間が気付ける唯一の手掛かりなので、1 往復と引き換えに残している。完了が 1 に減ったのは、後述の「[09/レビュー] completeTask の冪等性を UPDATE の WHERE 句自体で守る」で SELECT→UPDATE の順序をやめたため。

**ソース位置**: `packages/core/src/tasks.ts` の `createTask()` / `updateTask()` / `completeTask()`

### [09] COUNT(*) OVER () で総件数と先頭 N 件を 1 往復で取る

**問題**: `search_tasks` の応答は「該当 N 件」と「先頭 20 件」の両方を必要とする（超過分は件数だけ示して絞り込みに誘導する、が 07 で確定した形）。素直に書くと COUNT 用と本体用で 2 クエリ＝2 往復になり、その間に件数と中身がずれる余地も生まれる。

**対応**: ウィンドウ関数 `COUNT(*) OVER () AS total_count` を SELECT に混ぜ、`LIMIT` で打ち切る。ウィンドウ関数は LIMIT より前に評価されるので、打ち切っても total は全件数のまま。Turso 上で実際に動くことを事前に確認した（合成行 2 件・`LIMIT 1` で `total_count = 2`）。

**ソース位置**: `packages/core/src/tasks.ts` の `searchTasks()`

### [09] 読み出し時に Zod 検証をしない

**問題**: DB 側に CHECK 制約がない（チケット 03 の決定 —— 値を変えるたびにテーブル再作成が要るため）。したがって理屈の上では、手で書き換えた行などで status が未知の値になりうる。

**対応**: `taskFromRow()` は Zod を通さず、素の型付きマッパーにしてある。1 行の不正値のために一覧全体が例外で落ちる代償のほうが大きい。検証は「書き込みの入口」に置く、が 03 の設計であり、入口は MCP と CLI の 2 つだけで、どちらもこのパッケージの Zod enum を通る。

**ソース位置**: `packages/core/src/schema.ts` の `taskFromRow()`

### [09/レビュー] completeTask の冪等性を UPDATE の WHERE 句自体で守る（同時実行対策）

**問題**: 実装当初の completeTask は「SELECT で現在の status を確認 → done でなければ UPDATE」という順序だった（updateTask と同じ read-then-write の形）。2 台のクライアントがほぼ同時に同じタスクを complete すると、両方の SELECT が「まだ done ではない」を読み、両方が無条件の UPDATE を実行してしまう。後勝ちの UPDATE が先勝ちの closed_at を上書きしたうえ、両方が `alreadyDone: false`（＝「今回自分が完了させた」）と応答する。07 が定めた冪等性（既に done なら「変更なし」と応答する）が、同時実行下では破れる具体例。

**対応**: 「読んでから書く」を「書きながら条件を見る」に変えた。UPDATE の WHERE 句に `AND status != 'done'` を足し、`alreadyDone` の判定を「事前 SELECT の結果」ではなく「UPDATE が行を返したかどうか」に付け替えた。UPDATE が 0 行だった場合だけ、getTask で読み直して「そもそも存在しない（他人の行を含む）」のか「既に done だった」のかを区別する。この形なら、同時に 2 本の complete_task が来ても、先にコミットした 1 本だけが行を更新し、後続は WHERE 句が一致せず 0 行で終わる（＝素直に alreadyDone になる。closed_at は先にコミットした側の値のまま）。

**波及**: 正常系（まだ done ではないタスクを complete する）の往復回数が 2（SELECT → UPDATE）から 1（UPDATE のみ）に減った。往復が増えるのは「id が存在しない」または「既に done だった」場合の 2 パターンだけ。「[09] 書き込みを全部 RETURNING にした理由と往復回数」の記述もこれに合わせて更新した。

**検証**: `packages/core/test/tasks.test.ts` に、`Promise.all` で同じ id への 2 本の completeTask を並べて走らせるテストを追加した。テストが使う node:sqlite 版 TaskDb は `db.all()`/`db.get()` の中身が同期実行を `Promise.resolve()` で包んだだけなので、`Promise.all` の評価順によって「両方の UPDATE が、どちらの結果も読まれるより先に逐次実行される」形に決定的になり、read-then-write レースをこの in-memory DB 上で再現できる。旧実装（SELECT→UPDATE）でこのテストを走らせると、両方が `alreadyDone: false` を返し（「今回完了した」の件数が 1 本ではなく 2 本になる）、想定と食い違って落ちることを確認した。

**識別子の変更（[09/レビュー2]）**: この項に出てくる `alreadyDone: boolean` は現存しない。次項で `outcome: "completed" | "already_done" | "reopened"` に置き換えた（`alreadyDone: false` → `outcome: "completed"`、`alreadyDone: true` → `outcome: "already_done"`）。ここの記述は当時の実装の説明として残してある。

**ソース位置**: `packages/core/src/tasks.ts` の `completeTask()`。テストは `packages/core/test/tasks.test.ts`

### [09/レビュー2] completeTask の応答は返す行の status と一致させる（reopened の追加）

**問題**: 上の修正で `alreadyDone` の判定は「UPDATE が行を返したか」に移ったが、UPDATE が 0 行だったときの読み直し結果の status を確認していなかった（`const current = await getTask(...); return { task: current, alreadyDone: true }`）。コメントには「ここに来た時点で status は既に 'done'」と書いてあったが、これは嘘だった —— UPDATE と読み直しの間（本番では Turso 1 往復）に別マシンが `upsert_task` で done → open に戻すと、読み直した行は done ではない。その行に `alreadyDone: true` が付き、ハンドラは `#1 は既に done です（closed_at: null）。変更なし。` という、同時に返す行の中身と矛盾した本文をモデルに返した（レビューが再現、こちらでも server 経路で再現済み）。

**対応**: `alreadyDone: boolean` を `outcome: "completed" | "already_done" | "reopened"` に置き換えた。boolean は 2 値しか表現できないため、この結末を持てない —— `false` にすれば今度は「完了 ✔」を status=todo の行と一緒に返すことになり、矛盾の向きが変わるだけになる。`outcome` は読み直した行の status から 1 つの式で導出しており（`current.status === "done" ? "already_done" : "reopened"`）、結末と行の中身は構造上ずれない。ハンドラは 3 分岐とも `outcome` だけを見る。

**`reopened` で UPDATE をやり直さない理由**: open に戻した更新のほうが新しい意思表示なので、自動で done に上書きすると、後から来た変更を古い呼び出しが静かに巻き戻す（last-writer-wins の逆転）。事実（done にならなかった）を `isError` で返し、呼び直すかどうかの判断はモデル（と人間）に渡す。応答は 3 部品構成: 何が起きたか / なぜか / 呼び直しか upsert_task で status 明示。

**波及**: `already_done` の応答から `closed_at` が null のときの括弧を落とした。status=done なら closed_at は常に入るが、手で書き換えた行では欠けうるので、`（closed_at: null）` と書くくらいなら出さない。

**検証**: core 側は「UPDATE が 0 行で返った直後・getTask の前に reopen を差し込む」`TaskDb` ラッパーで固定（`packages/core/test/tasks.test.ts` の `[fix-1]`）。server 側は UPDATE が `[]`・再読が status=todo を返す fake で、応答本文が「既に done」とも「完了 ✔」とも言わないことを固定（`packages/server/test/mcp.test.ts` の `[fix-1]`）。`outcome` を無条件 `already_done` に戻す変異で両方落ちることを確認した。

**ソース位置**: `packages/core/src/tasks.ts` の `completeTask()` / `CompleteTaskOutcome`、`packages/server/src/todo-tools.ts` の `complete_task` ハンドラ、`packages/server/src/todo-format.ts` の `completeReopenedError()`

### [09/レビュー2] project / memo の空文字を null に正規化する（書けるが読めない値を作らない）

**問題**: `upsert_task({project: ""})` は通り、`INSERT` の args に `project=""` が入っていた（実測）。しかし `todo-format.ts` の `if (task.project)` は空文字を falsy として落とすので一覧にも詳細にも `{}` が出ず、`tasks.ts` の `if (params.project)` も空文字を無視するので project 絞り込みでは永久にヒットしない。直前の修正で `searchTasksInput.project` にだけ `.min(1)` が入り `upsertTaskInput.project` には入らなかったため、`""` を検索して探すこともできない状態だった。`memo` にも同じ穴がある（`if (task.memo)` が空文字を落とすので `+memo` マーカーが出ない）。つまり**モデルが自力で気付けず復旧もできない不可視の値**が作れた。07 のプロトタイプ観察で見つかった「memo は書けるが読めない」と同じ欠陥クラス。

**対応**: 拒否ではなく正規化を選んだ。`""` を送る意図は実質「消す」なので、往復を強いる意味がない。core の `createTask()` / `updateTask()` で `nullIfEmpty()` を通し、`project` / `memo` の「値なし」の正準表現を null 一つに揃えた。**入口（MCP ハンドラ）ではなく core に置いた**のは、CLI（チケット 11）も同じ書き込み経路を通るため —— 入口ごとに書くと、次の入口で忘れられる。`title` は「消す」を表現できる列ではないので正規化しようがなく、入口で拒否する（次項）。

**波及**: 現在値が null の行に `""` を渡しても `changed` は空のまま（`setIfChanged` の比較が正規化後に走る）。ラベルが付いた行に `""` を渡すと `変更: project` と正直に出て null になる。

**検証**: `packages/core/test/tasks.test.ts` の `[fix-3]` 4 本（作成・更新・no-op・検索から見えること）で、戻り値・`getTask` の読み直し・DB の生の行の 3 段で null を確認。server 側は `[fix-3]` で INSERT / UPDATE のバインド値に `""` が現れないことを固定。ツール経由の実測（実 SQLite）でも `upsert_task({project:"", memo:""})` → `get_task` が `{}`・`+memo` なしで返り、生の行が `{"project":null,"memo":null}` であることを確認した。

**ソース位置**: `packages/core/src/tasks.ts` の `nullIfEmpty()` / `createTask()` / `updateTask()`

### [09/レビュー] updateTask の SELECT→UPDATE は非トランザクション —— 許容している理由

**問題**: completeTask と違い、updateTask の「先に SELECT して差分を取る → UPDATE」という形は今回直していない。理由は差分表示（`changed`）の仕組みごと作り替えになるため——07 が定めた「実際に変わった列を返す」という応答形が、この事前 SELECT に依存している（「[09] 書き込みを全部 RETURNING にした理由と往復回数」参照）。したがって updateTask には completeTask と同種の read-then-write の隙間が残ったままである。

**実際の限界**: 2 台が同時に同じタスクを異なるフィールドで更新すると、後勝ちの UPDATE が計算する `assignments`（変更差分）は自分が読んだ古い `current` を基準にしているため、応答の `changed` が「実際に他方の変更を踏まえた差分」ではなく「自分が読んだ時点からの差分」になりうる。

**それでも壊れないもの**: status と closed_at は常に同一の UPDATE 文の中で一緒に書かれる（status 専用の分岐が `assignments.push("status = ?", "closed_at = ?")` を同時に積む）。そのため、同時実行があっても「status=done なのに closed_at=null」のような矛盾した中間状態を作ることはできない —— 最終的にどちらが勝っても、勝った側が送った status と closed_at のペアがそのまま反映されるだけ。

**ソース位置**: `packages/core/src/tasks.ts` の `updateTask()`

### [09/レビュー2] 同時実行テストが依存するハーネスの性質を固定する

**問題**: 上の同時実行テスト（`Promise.all` で 2 本の completeTask）は、`createInMemoryTaskDb()` の `all()` が「同期実行を `Promise.resolve()` で包んだだけ」であることに依存している。コメントはそう述べていたが、**その性質を固定するアサーションがどこにも無かった**。ハーネスが将来 `node:sqlite` の非同期 API や実 libsql に差し替わると、このテストは落ちるのではなく**無意味になる** —— インターリーブが変わり、実装が壊れていても winners=1 が偶然成立し続けうる。テストが「守っているつもりで何も守っていない」状態は、テストが無いより悪い（回帰検知があると誤認する）。

**対応**: ①ハーネス側（`sqlite-task-db.ts`）に「この性質に依存しているテストがある」ことを doc コメントで明記し、差し替え時の手順（先に性質のテストが落ちるのを見てから同時実行テストを設計し直す）を書いた。②テスト側に、依存が生きていることを直接確かめるアサーションを置いた —— `completeTask()` を **await せずに**呼び、その時点で行が既に done になっていることを同期読み（`querySync`）で確認する。真に非同期なハーネスではこれが落ちる。

**`querySync` について**: ハーネスにだけ生やしたテスト専用の同期読み口。プロダクションコードは `TaskDb` 型で受け取るので、この口は型から見えない（`InMemoryTaskDb` を知っているのは core の test だけ）。

**検証**: `all()` を `await new Promise(setTimeout)` 経由の実非同期に差し替える変異で、この性質テストが落ちることを確認した。

**ソース位置**: `packages/core/test/support/sqlite-task-db.ts` の `createInMemoryTaskDb()` / `InMemoryTaskDb`、`packages/core/test/tasks.test.ts` の `[fix-7]`

---

## packages/migrate（チケット 10: 旧 todos.db からの移行）

### [10] 移行スクリプトを packages/migrate という新しいワークスペースにした

**選択肢**: ①`packages/core/scripts/` に置く ②リポジトリ直下に `scripts/` を作る ③`packages/*` の作法どおり新しいワークスペースにする。

**決め手になった軸**: (a) リポジトリ自身の `npm run typecheck` / `npm test` が自動で拾うか (b) core の依存表面を汚さないか (c) 消しやすいか。

**判断**: ③。(a) ルートの `"workspaces": ["packages/*"]` に自動で乗るので、`--workspaces --if-present` の typecheck とテストが最初から効く（②は workspace ではないので、この 2 つの網から外れる）。(b) このスクリプトは Node 専用のもの（`node:sqlite`・`process.argv`・TS ランナーの `vite-node`）を要求する。core は Worker にも CLI（チケット 11）にもバンドルされる唯一の共有層で、「core / server の境界をどこで切ったか」がこの設計の背骨なので、1 回きりのスクリプトのために core の devDependencies と tsconfig の `types` を動かしたくない。①はその境界の記述を弱める。(c) パッケージごと消せば跡形もなく消える。

**波及**: `packages/cli`（チケット 11）が増えても同じ形で並ぶ。`npm test` の内訳は core 39 / migrate 18 / server 121 になった。

**ソース位置**: `packages/migrate/package.json`、`packages/migrate/tsconfig.json`

### [10] INSERT を core の `importTask()` にして、移行スクリプトに生 SQL を書かなかった

**問題**: 移行は「旧 id を保持し、created_at / updated_at / closed_at に過去の値を置く」INSERT を必要とする。`createTask()` はどれもできない（id は DB が発番、タイムスタンプは「今」、closed_at は status から導出）。

**選んだ形**: core に `importTask()` を足し、スクリプトからはそれを呼ぶ。`createTask()` にオプション引数として足す形は採らなかった —— id とタイムスタンプを外から指定できる権限が日常の書き込み経路（MCP ツール）に生えることになり、「作成日時を偽装したタスク」や「他人が使う予定の id を先に埋める INSERT」が書けてしまう。別関数なら、その経路は移行スクリプトからしか届かない。

**core に置いた理由**: `tasks.ts` 冒頭の不変条件 —— tasks への SQL は全部このファイルにあり、user_id を条件または値に持たない文が 1 つも無いことを grep で確認できる —— を移行でも壊さないため。スクリプト側に INSERT を書くと、その日から「grep で確認できる」が嘘になる。

**ソース位置**: `packages/core/src/tasks.ts` の `importTask()` / `ImportTaskInput`

### [10] sqlite_sequence だけは移行パッケージ側の生 SQL にした

**理由**: `sqlite_sequence` は tasks ではなく SQLite 内部の採番状態で、user_id で絞る対象が存在しない。core に置くと「user_id を持たない文」が 1 本混ざり、上の不変条件が grep で確認できなくなる。tasks 以外を触る唯一の操作なので、`packages/migrate/src/sequence.ts` に隔離した。

**何のために要るか**: `--only-open` では移行しない done の id（最大 153）がカウンタに載らない場合があり、新規タスクがアーカイブ済みの番号を再利用しうる。会話 UI で「12 番終わった」と言える設計（03 §5）では、番号の重複が履歴の取り違えに直結する。引き上げのみ（既存値のほうが大きければ何もしない）にしてあるのは、下げると使用済み id を再発番する DB を作ってしまうため。

**実測**: 旧 id を明示した INSERT で SQLite が自動的にカウンタを 153 まで上げるため、実際にはこの UPDATE は「変更なし」で終わった。それでも残すのは、`--only-open` で最大 id の行が open でないケース（今後 done が増えれば起こる）では自動更新が 153 に届かないため。**この「変更なしで終わった」ことの意味は [10/レビュー] で改めた** —— 書き込み分岐が一度も実行されていない、ということでもあった。

**ソース位置**: `packages/migrate/src/sequence.ts` の `raiseTaskSequence()`

### [10] updated_at に created_at をそのまま入れた

**問題**: 新スキーマの `updated_at` は NOT NULL だが、旧 todos.db に更新履歴に相当する列が無い。候補は ①`created_at` と同値 ②移行を実行した「今」 ③`closed_at` があればそれ。

**判断**: ①。②は「全 148 行が移行日に更新された」という起きていない出来事を記録することになり、`fmtDetail` が `created: ... / updated: ...` を出す目的（塩漬け判定 —— 最後に触ったのはいつか）を正面から潰す。③は done の行だけ整合するが、open の行には使えないので結局 2 通りの規則が混ざる。①なら「移行後に一度も更新されていない」という事実がそのまま読める。

**既知の歪み**: 全件移行した場合、done の行は `updated_at < closed_at` になる（例: created 2026-03-30 / closed 2026-03-31 / updated 2026-03-30）。「done にした操作」もまた更新なので、厳密には updated_at はそれ以上であるべき。実運用では done 140 件を prod へ移す予定が無い（`--only-open`）ので放置している。全件を prod に入れる判断をするなら、ここは `MAX(created_at, closed_at)` に直すか、歪みを承知で残すかを決め直すこと。

**ソース位置**: `packages/migrate/src/transform.ts` の `transformRow()`

### [10] `YYYY-MM-DD HH:MM` の due を日付に丸めた（旧 DB に 2 件実在）

**問題**: 旧 DB の `due` は 87 件が NULL、59 件が `YYYY-MM-DD`、そして **2 件（#91 / #92）が `YYYY-MM-DD HH:MM`**（`2026-03-30 18:00` / `2026-03-31 18:00`）だった。どちらも done。03 §7 は「`due` のみ日付 `YYYY-MM-DD` のまま —— 締切は瞬間ではなく日」と決めている。

**判断**: 時刻部分を落として日付だけにし、落としたことを実行ログに `due_time_dropped` として出す。verbatim で通すと、`isCalendarDate()` を通らない値が新 DB に残る —— upsert_task はこの形式を受け付けないので**ツール経由では二度と作れず、直すこともできない**値になり、`fmtLine` の表示や `buildAgenda` の日付比較が想定していない領域に出る。失うのは「18:00」という、新スキーマがそもそもモデル化していない情報。

**射程**: 2 件とも done なので `--only-open`（prod へ移す予定の経路）では 1 件も当たらない。全件移行でのみ発火する。

**丸める範囲**: [10/レビュー] で「先頭 10 文字が日付なら採用」から「`YYYY-MM-DD HH:MM` に完全一致したときだけ」に狭めた。理由はそちらの項に書いた。

**ソース位置**: `packages/migrate/src/transform.ts` の `normalizeDue()`

### [10] `"" → null` の防御は入れたが、実データでは 1 件も発火しなかった

**背景**: [09/レビュー2]「project / memo の空文字を null に正規化する」と同じ欠陥クラス —— `""` は書けるのに `fmtLine` / `fmtDetail` / `searchTasks` のどの真偽判定にも引っかからず、不可視の値になる。移行は core の書き込み関数を通るので `importTask()` 側の `nullIfEmpty()` でも潰れるが、変換側（`transform.ts`）にも同じ正規化を置き、発火したら `empty_to_null` として実行ログに出すようにした。

**実測**: 旧 DB の `category` / `memo` / `due` / `title` に空文字は 0 件。148 件の全件移行でも `empty_to_null` は 1 度も出ていない。「実データに無いから要らない」ではなく「入ってきたら壊れる」ので入口に置いてある、という位置づけ。防御が生きていることは合成データのテストで固定した（`packages/migrate/test/transform.test.ts`）。

**ソース位置**: `packages/migrate/src/transform.ts` の `textOrNull()`

### [10] 2 回実行すると PRIMARY KEY で止まる（事故防止として機能する）

**実測**: 同じ対象に `--execute` を 2 回かけると、1 行目（id=1）の INSERT が `SQLITE_CONSTRAINT: UNIQUE constraint failed: tasks.id` で失敗し、`0/8 件を投入済み` と表示して終了コード 1 で止まる。行数も sqlite_sequence も変化しない。旧 id を明示保持する設計の副産物として、二重投入は DB 側で構造的に不可能になっている。

**トランザクションを張っていないことの限界**: 途中の行（例: ネットワーク断で 100 件目）で落ちると、そこまでの行は入ったまま残る。復旧は「**移行が投入した id だけを消して**やり直す」で、そのために失敗時は必ず投入済み件数を出す（対象 DB を丸ごと空にする手順は [10/レビュー] で撤回した —— 部分投入の後に MCP 経由で作られたタスクまで消える）。再実行が上記のとおり必ず 1 行目で止まるので、「部分的に入った状態にもう一度重ねる」事故は起きない。

**ソース位置**: `packages/migrate/src/execute.ts` の `executeImport()` の INSERT ループ

### [10] 接続先の取り違えを 2 段で塞ぐ

**設計**: ①`--target dev|prod` を必須にし、資格情報も `TURSO_DEV_*` / `TURSO_PROD_*` と target ごとに別の環境変数から読む（共通の `TURSO_DATABASE_URL` は読まない —— シェルに残った値の向き先で書き込み先が決まる形を作らない）。②それでも防げない「環境変数の中身を貼り間違えた」場合のために、URL のホスト名が `todo-mcp-<target>` で始まることを確認し、違えば接続する前に止める。

**モードにも既定値を置かない**: `--dry-run` と `--execute` はどちらか一方が必須で、両方でも片方も無しでもエラー。既定値があると「どちらが既定だったか」を思い出す必要が生まれ、思い出し間違いがそのまま書き込みになる。

**ソース位置**: `packages/migrate/src/cli.ts` の `resolveTarget()` / `parseArgs()`（[10/レビュー] で `main.ts` から切り出した）

### [10/レビュー] Turso が `sqlite_sequence` への書き込みを受けるかを実測した

**問題**: `raiseTaskSequence()` の 2 つの書き込み分岐（`INSERT INTO sqlite_sequence` / `UPDATE sqlite_sequence`）は、**Turso に対して一度も実行されていなかった**。dev は明示 id の INSERT で既に `seq=153` になっていたため、常に「変更なし」側だけが走っていた。`sqlite_sequence` は SQLite の内部テーブルで、通常の INSERT / UPDATE は `SQLITE_DBCONFIG_DEFENSIVE` が off のときだけ許される。Turso 側がどう設定しているかはこのリポジトリのどこにも書かれていなかった。

**実測**（2026-08-08、`todo-mcp-dev` に `@tursodatabase/serverless` 経由で発行）:

| 文 | 結果 |
|---|---|
| `UPDATE sqlite_sequence SET seq = seq WHERE name='tasks'`（値を変えない） | OK（seq 153 のまま） |
| `UPDATE sqlite_sequence SET seq = 200 WHERE name='tasks'` | OK（seq 200 に変化） |
| `DELETE FROM sqlite_sequence WHERE name='tasks'` | OK（行が消える） |
| `INSERT INTO sqlite_sequence (name, seq) VALUES ('tasks', 153)` | OK（行が戻る） |

つまり Turso は防御モードを有効にしておらず、両分岐とも本番でも通ると期待してよい。dev は実測後 `seq=153` に戻してある。

**残る不確かさ**: これは dev で測った値であり、prod で同じ設定である**保証**はない（同じ組織・同じ group なので同じ設定である蓋然性は高い、という以上のことは言えない）。もし prod で拒否されれば、引き上げは `--execute` の最初の 1 文で失敗し、`SequenceRaiseError(phase: "before")` として「行は 1 件も入っていない」と表示して止まる —— 壊れた状態は作らない。

**ソース位置**: `packages/migrate/src/sequence.ts` の doc コメント

### [10/レビュー] 採番カウンタを INSERT ループの前に上げる

**問題**: `raiseTaskSequence()` の呼び出しが INSERT ループの**後**にあった。ループが途中で落ちる経路はカウンタを上げずに終了する。3 件だけ入って落ちた状態を再現すると `seq=13` になり、**次に MCP 経由で作られるタスクが id 14 を取る**。id 14 は旧 DB に実在するアーカイブ済みタスク（done「レイヤーX社専用の職務経歴書を作成する」）で、sequence.ts 自身が「履歴の取り違えに直結」と書いている事態が静かに起きる。しかも ids 14〜148 がアーカイブのものだと記録している場所が無いので、後から気付いて直すこともできない。露出窓は本番実行そのもの。

**判断**: 引き上げを INSERT より前に移した。SQLite は `seq` を下げないので、先に上げても失うものが無い（153 に上げた後に明示 id=5 を入れても seq は 153 のまま、次の自動発番は 154）。ループ後には**冪等な再アサート**を残してある —— 前段が成功していれば読むだけで終わり、最終値を報告に使える。

**失敗メッセージを分けた理由**: 「カウンタ操作だけが失敗した」は復旧手順が正反対になる。前段の失敗は行が 1 件も入っていない（そのままやり直せる）。後段の失敗は**全行が入っている**（DB を空にしてはいけない）。同じ汎用ハンドラに流すと、README の復旧手順が良いデータを破壊しうる。`SequenceRaiseError` に `phase` を持たせ、ハンドラで別々の文面を出している。

**ソース位置**: `packages/migrate/src/execute.ts` の `executeImport()` / `SequenceRaiseError`

### [10/レビュー] 投入後の検証を値レベルにした（そして何を確かめていないか）

**問題**: 投入後の確認が総件数の増分しか見ていなかった。`created_at` が全行 1 年ずれていても、行数さえ合えば成功終了する。チケット 10 の完了条件は「件数一致、**status 別件数一致**、**期限付きタスクの欠落なし**」で、増分だけでは満たせない。

**対応**: 投入した全行を `getTask()` で 1 件ずつ読み直し、`ImportTaskInput` と全 10 列（id / workspace / project / title / status / due / memo / created_at / updated_at / closed_at）を突き合わせる。食い違った列は id と列名を挙げて `ImportVerificationError` で止める。`getTask()` は user_id で絞るので、**間違った user_id で書かれた行は「読み直しても行が無い」として検出される**（user_id 列も実質ここで見ている）。

**この検証が答えられない問い**: 「旧 DB と一致するか」。`transformRow()` が値を取り違えていれば、その間違った値が「書いたはずの値」になるので、ここは一致してしまう。変換の正しさは `packages/migrate/test/transform.test.ts` の管轄で、**両方が揃って初めて「旧 DB → Turso」の経路全体が担保される**。片方だけを見て「検証済み」と言わないこと。

**なぜ core の読み取り関数を使うのか**: 「このスクリプトが書いた行を、このスクリプトで読み直す」形なのは承知のうえ。ここで確かめたいのは「core の書き込み関数が、渡した値をそのまま保存したか」であり、それには core の読み取り経路が正しい相手になる（生 SQL を書けば `tasks.ts` の不変条件が壊れる）。

**往復回数**: 1 行 1 往復。本番スコープは 8 行なので問題にならない。全件（148 行）を入れる判断をするなら、ここは `searchTasks` の一括読みに変えるか、往復を承知で残すかを決め直すこと。

**ソース位置**: `packages/migrate/src/verify.ts` の `diffImportedTask()` / `verifyImported()`

### [10/レビュー] `--user-id` を検証しないと、投入後の確認が誤入力を追認する

**問題**: `--workspace` は `workspaceSchema` を通すのに `--user-id` は任意の文字列を受けていた（非対称）。名前空間を欠いた値（`64899536`）や別ユーザーの値を渡すと、全行が誰にも見えないスコープへ入る。しかも**投入後の確認も同じ指定値で検索する**ので、増分は一致して成功扱いになる —— 誤入力を検証が自分で追認する形。

**対応**: `/^github:\d+$/` に一致しない値を接続前に拒否する。この形は 08 で確定した canonical identity で、`packages/server/src/allowlist.ts` の `githubUserId()` が作る形と同じ。

**ソース位置**: `packages/migrate/src/cli.ts` の `USER_ID_FORMAT`

### [10/レビュー] 未知の `due` 形式を丸めるのをやめた

**問題**: `normalizeDue()` が「先頭 10 文字が有効な日付なら採用」していたので、`2026-03-30oops` のような**有効な日付で始まる不正値**が正常な due として静かに投入される。transform.ts 全体の方針（判断できない値は握りつぶさず止める）と矛盾していた。

**対応**: 丸めるのは旧形式として実在を確認済みの `YYYY-MM-DD HH:MM`（#91 / #92）だけにし、正規表現を全体一致にした。それ以外は `MigrationDataError` で id と値を挙げて停止する。日付部分が実在しない（`2026-02-31 18:00`）場合も止まる。

**ソース位置**: `packages/migrate/src/transform.ts` の `LEGACY_DUE_WITH_TIME` / `normalizeDue()`

### [10/レビュー] `--only-open` を必須にして、全件移行を実行前に止める

**問題**: `--only-open` を外すと done 140 件を含む全行が**単一の `--workspace` 値**で入る。旧 category には `PKSHA` 4 / `work` 5 / `ラクス` 5 / `ナウキャスト` 4 / `Rox Products` 2 が混ざっており、03 §2 の境界では `work` に落ちるものがある。しかも PKSHA でも 2026-05-01 入社前の行は転職活動＝私事なので、機械的に割り切れない。

**確定事項**（2026-08-08 松本さん決定）: 本番へは `--only-open` の 8 件のみ。done 140 件は旧 `todos.db` にアーカイブとして残す。全件移行は今回やらない。

**判断**: `--only-open` を必須引数にし、無ければ `parseArgs()` の段階で（`--dry-run` でも）止める。停止メッセージに「全件移行には category → workspace のマッピング決定が要る」と理由を書いた。dry-run も止めるのは、全件の下見それ自体が同じ判断を必要とするから。**この停止を外すこと自体が「マッピングを決めた」という判断の記録になる**、という形にしてある。

**ソース位置**: `packages/migrate/src/cli.ts` の `parseArgs()`

### [10/レビュー] 取り違えガードを純粋関数に切り出してテストを付けた

**問題**: `--target` と URL ホスト名の照合、`--dry-run` / `--execute` の必須化 —— **誤って本番に書くのを止める仕組みそのもの**に自動テストが 1 本も無かった。`parseArgs` / `resolveTarget` が `main.ts` のモジュール private で、テストから import できない形だったため。`vitest.config.ts` は省略を意図的と書いていたが、その理由（「実 DB に触る部分」）はこの 2 つの純粋関数には当てはまらない。

**対応**: `packages/server/src/allowlist.ts` / `redirect-uri.ts` と同じ「純粋なガード + I/O シェル」の形に揃え、`cli.ts` に切り出した。`resolveTarget()` は `process.env` を読まず `env` を引数で受ける（両方向の貼り間違いをテストから直接与えられる）。

**ホスト照合の形**: `host !== expected && !host.startsWith(expected + "-")`。`||` に変えるとホスト名がちょうど `todo-mcp-prod` の DB を拒否し、`startsWith(expected)` だけにすると `todo-mcp-prod2.turso.io` のような別 DB を通す。この 2 つは別々のテストで押さえてある（変異を入れるとそれぞれ落ちる）。

**ソース位置**: `packages/migrate/src/cli.ts`、`packages/migrate/test/cli.test.ts`

### [10/レビュー] 「tasks への SQL は core にある」を実行できる形に戻した

**問題**: `tasks.ts` 冒頭は「tasks テーブルに対する SQL は全部ここにある」と書いていたが、10 で `legacy.ts` に **core 外・`user_id` 条件なしの `FROM tasks`** が 3 箇所入った。旧 todos.db のテーブル名も `tasks` なので、リポジトリ全体の grep はこの不変条件を確認できなくなった。09 で「機械的な確認がテストより先に穴を見つけた」道具を、10 が鈍らせた形。

**言明の作り直し**: 新旧を分ける軸は「`TaskDb`（新 DB のハンドル）を受け取るか」。`legacy.ts` は `node:sqlite` でローカルファイルを開くだけで `TaskDb` を受け取らないので、新 DB に文を送る手段を構造的に持たない。`sequence.ts` は `TaskDb` を受け取るが `sqlite_sequence` しか触らない。よって言明は「**`TaskDb` を受け取るファイルのうち、新 tasks への SQL を持つのは `packages/core/src/tasks.ts` ただ 1 つ**」になる。

**確認手順を 2 本の grep にした**（tasks.ts の doc コメントに全文がある）:

```
$ grep -rEln '(FROM|INTO|UPDATE) tasks' packages --include='*.ts' --exclude-dir=test --exclude-dir=node_modules
packages/core/src/tasks.ts
packages/migrate/src/legacy.ts

$ grep -n 'import .*TaskDb' packages/migrate/src/legacy.ts
（出力なし）
```

**2 本目で一度間違えた**: 最初は `grep -l TaskDb packages/migrate/src/legacy.ts` と書いたが、legacy.ts に足した「`TaskDb` を一切受け取らない」という説明文自体が `TaskDb` という語を含むため、常にヒットして手順が成り立たなかった（実行して気付いた）。判定したいのは「受け取るか」＝ import の有無なので、そちらを見る形に直した。

**さらにテストにした**: doc コメントは古びるし、上のように手順そのものを間違えもする。同じ判定を `packages/core/test/invariants.test.ts` で実行し、`TaskDb` と tasks への SQL を同時に持つファイルが現れたら落ちるようにした（判定はコメントを落としてから行うので、legacy.ts の doc コメント中の `TaskDb` という語には反応しない）。

**ソース位置**: `packages/core/src/tasks.ts` 冒頭、`packages/migrate/src/legacy.ts` 冒頭、`packages/core/test/invariants.test.ts`

### [10/レビュー] 本番スコープを 8 件に確定したことで残る限界

本番へ入れるのは生存 8 件のみで、done 140 件は旧 `todos.db` にアーカイブとして残す（2026-08-08 決定）。この決定が残す限界を、後から掘り返さなくて済むように書いておく。

- **後から done を追記する経路は無い**。`--skip-existing`（既存 id を飛ばして残りを入れる）を足す案は採らなかった —— 本番スコープが確定した以上、移行スクリプトに**未検証のコード経路を増やす**ほうが危ない。後から done も欲しくなった場合は「prod を DELETE して全件やり直す」で、松本さんはこれを承知のうえで選んでいる。そしてそのやり直しには、上記の category → workspace マッピング決定が先に要る。
- **`updated_at < closed_at` の歪みは是正していない**。`--only-open` では該当 0 件（全件だと 114/148）。全件を入れる判断をするときに、`MAX(created_at, closed_at)` に直すか歪みを承知で残すかを決め直すこと。
- **`due_time_dropped` は 8 件では発火しない**。該当の #91 / #92 はどちらも done。
- **`empty_to_null` も 8 件では発火しない**（旧 DB に空文字が 0 件）。防御が生きていることはテストでのみ固定されている。

---

## todo-tools.ts / todo-format.ts

### [09] user_id を引数から受け取らない構造（withUser）

**問題**: user_id をツール引数にすると、モデルが別の値を渡した瞬間に他人のタスクへ到達できる。出どころは OAuth の grant に封じた props ただ 1 つでなければならない。

**対応**: 入力スキーマに user_id を一切置かない。さらに全ツールハンドラを `withUser()` で包み、第 1 引数として userId を渡す形にした。これにより「user_id を解決し忘れたハンドラ」は型が合わず書けない。認証コンテキストを読むのはこの 1 箇所だけで、core 側のクエリ関数は `getMcpAuthContext()` を一切知らない（userId は必ず引数で来る）。

**ソース位置**: `todo-tools.ts` の `currentUserId()` / `withUser()`

### [09] due だけスキーマ検証にしない理由

**説明**: 06 で確定したエラー文は 3 部品（①不正値のエコー ②期待する形式 ③モデルが機械計算できるアンカー）。due の ③ は「今日の日付」で、これがないとモデルは「明日」を絶対日付に直せない。Zod スキーマ側で弾くと SDK 自動生成の文言（`Input validation error: ... expected ...`）になり、今日を注入する余地がない。そのため due だけはスキーマを `z.string()` に緩め、ハンドラ内で `isCalendarDate()` を使って検証している。

**実測**: 未知の workspace 値（`"private"`）を渡すと、SDK が `Input validation error: Invalid arguments for tool get_agenda: workspace: Invalid option: expected one of "work"|"life"` を `isError` で返した（07 の「スキーマ違反は JSON-RPC error ではなく isError」の再確認）。この文言は enum なら十分だが、日付には足りない。

**ソース位置**: `todo-tools.ts` の `upsert_task` ハンドラ、`todo-format.ts` の `invalidDueError()`

### [09] ToolText を interface ではなく type にした理由

**問題**: ツール応答の形を `interface ToolText` として定義したところ、`registerTool` に渡すハンドラが型エラーになった（`Type 'ToolText' is not assignable to ... Property 'resultType' is missing`）。

**原因**: SDK 側の戻り値型は `[x: string]: unknown` のインデックスシグネチャを持つ。TypeScript は **type エイリアス**には暗黙のインデックスシグネチャを与えるが、**interface** には与えない（interface は宣言マージで後から拡張されうるため）。

**対応**: `ToolText` を `type` エイリアスに変えた。

**ソース位置**: `todo-format.ts` の `ToolText`

### [09] プロトタイプから変えた点（agenda フッターの文言）

**問題**: プロトタイプの agenda フッターは、セクションに出なかった残りを「someday N 件・**期限なし todo** M 件」と表現していた。しかし実際の M には「期限が 8 日以上先のタスク」も入る（どのセクションの条件にも当たらないため）。プロトタイプのシードには遠い将来の期限を持つタスクが無く、観察では顕在化しなかった。

**対応**: 「someday N 件・**期限なし or 7日より先** M 件」に直した。読み手はモデルであり、件数の説明が実態と食い違うと、そのまま人間への報告に乗る。

**実測**: スモークテストで #3 の期限を 8/20（今日から 12 日先）に動かしたところ、まさにこの分岐に入り `_他に open 1 件（someday 0 件・期限なし or 7日より先 1 件）は含まれていない。_` と表示された。

**ソース位置**: `todo-format.ts` の `buildAgenda()`

### [09] ツール呼び出しログに載せるもの・載せないもの

**背景**: 07 の観察では `[observe]` ログにセッション識別子がなく、呼び出し 3 件の出どころを確定できないまま記録に残った（同チケットの「反省」）。

**対応**: `[todo]` の 1 行 JSON ログに、リクエストヘッダ由来の識別子（`mcp-session-id`、無ければ Cloudflare の `cf-ray`）を `req` として載せる。

**載せないもの**: `title` と `memo`。個人のタスク本文が Workers のログに残るのを避ける。載せるのはツール名・解決後の workspace・id・結果の種別（作成/更新/変更列名/not_found など）だけで、これで「どのツールがどう呼ばれたか」は追える。

**ソース位置**: `mcp.ts` の `resolveRequestId()`、`todo-tools.ts` の `log()`

### [09/レビュー] upsert_task の not-found アンカーを workspace で絞らない

**問題**: upsert_task の更新経路（id 指定）で not-found になったとき、実在する open id の一覧（アンカー）を `listOpenTaskIds(db, { userId, workspace: resolveWorkspace(args.workspace) })` という、workspace で絞った形で取っていた。しかし `args.workspace` はこの呼び出しにおいて「移動先として設定したい値」であって、探索用のレンズではない。id を打ち間違えたとき、正解の id が別 workspace にあると、そのアンカーから欠落してしまい、モデルが自己修正できない。

**対応**: get_task・complete_task と同じく `listOpenTaskIds(db, { userId })`（workspace 指定なし、全 workspace 対象）に揃えた。id しか手がかりがないツール呼び出しでは、どちらの workspace の話か決め打ちできないので、探索は常に全 workspace で行う、という原則を 3 ツールで統一した。

**ソース位置**: `todo-tools.ts` の `upsert_task` ハンドラ（更新経路の not-found 分岐）

### [09/レビュー2] not-found アンカーと CAP 20 の相互作用（既知の限界）

**記録の趣旨**: 上の修正（アンカーを全 workspace から出す）は妥当なので**コードは変えていない**。ただし 2 つの副作用が未記録だったので、ここに残す。

**限界 1 —— CAP 20 は合算後に効く**: `openIdsAnchor()` の `CAP = 20` は、両 workspace の open id を id 昇順で混ぜた**後**に先頭 20 件を切る。したがって片方の workspace に古い（＝小さい id の）open タスクが 20 件以上あると、アンカーがそちらだけで埋まり、モデルが実際に扱っている workspace の id が 1 つも出ないことがありうる。旧 todos.db からの移行（チケット 10）で id 1〜149 が入るので、これは仮想的な話ではない。現状はこの状態でもアンカー末尾の `…他N件` が「まだある」ことを示し、モデルは `search_tasks` に降りられる（`get_task` / `complete_task` の not-found は `include_closed` ヒント付き）。直すなら「workspace ごとに配分して混ぜる」か「アンカーに workspace ラベルを添える」だが、どちらも 07 が確定したレスポンス行形式に手を入れることになるため、実際に不便が観測されるまで動かさない。

**限界 2 —— `?workspace=work` の接続でも life の数値 id が出る**: `mcp.ts` の `resolveDefaultWorkspace()` の doc コメントは、既定 workspace の意義を「明示し忘れたときに life が会社 PC の画面に出ないための保険」と説明している。全 workspace アンカーはこの保険とわずかに緊張する —— work 接続のエラー文に life の id が混ざるため。**新しい漏れ口ではない**（出るのは数値 id だけで、title も project も出ない。そして id を指定した `get_task` は元々 workspace を問わず引ける）が、「work 接続では life の情報が一切出ない」とまでは言えなくなった、という事実は明記しておく。

**ソース位置**: `todo-format.ts` の `openIdsAnchor()`（CAP）、`todo-tools.ts` の 3 つの not-found 分岐、`mcp.ts` の `resolveDefaultWorkspace()`（「保険」の趣旨）

### [09/レビュー] search_tasks の 0 件時のスコープ表示を実効検索条件に合わせる

**問題**: `buildSearchResult()` の 0 件メッセージは `include_closed` だけを見て「open のみ」/「closed 含む」を出し分けていた。しかし core 側の `searchTasks()` は `status` 指定があればそれを優先し `includeClosed` を無視する分岐になっている（`if (params.status) {...} else if (!params.includeClosed) {...}`）。この非対称性が formatter に伝わっていなかったため、`status: "done"` を指定して 0 件のときに「open のみ。done / cancelled も探すには include_closed: true」という、実際の検索条件と矛盾する案内を出してしまっていた（status を優先しているのに、まだ include_closed を勧める）。逆に status を open 値に絞りつつ `include_closed: true` のときは、実際より広いスコープを表示していた。

**対応**: formatter が受け取る引数を `includeClosed` 単体から `{ status, includeClosed }`（実際に SQL が使った実効条件）に変えた。0 件時のスコープ表示は「status 指定があればそれ」「なければ includeClosed の有無」で組み立て、SQL の分岐と 1 対 1 に対応させる。`include_closed: true` への誘導文は「status 未指定 かつ includeClosed が false」のとき —— つまり実際に `include_closed: true` にすることで検索範囲が広がる場合 —— だけ出す。status 指定時や、すでに `includeClosed: true` のときは、オンにしても結果が変わらないので誘導しない。

**ソース位置**: `todo-format.ts` の `buildSearchResult()`（呼び出し元は `todo-tools.ts` の `search_tasks` ハンドラ）

### [09/レビュー] title / project / query の空文字をスキーマ側で弾く → [09/レビュー2] で撤回

**当初の問題（有効）**: `upsertTaskInput` の `title` は更新経路（id あり）では一切検証されていなかった。`upsert_task(id: 12, title: "")` を呼ぶと `updateTask()` の `setIfChanged` が空文字を「現在値と違う」として素直に書き込み、一覧表示が `#12 [todo] ` になって可読性とモデルの参照性を壊す。同様に `searchTasksInput` の `project` / `query` は空文字を許していたため、`if (params.project)` / `if (params.query)`（core 側 `searchTasks()`）が空文字を falsy として無視し、絞ったつもりのフィルタが黙って外れ、全件を返す「絞れていないのに絞れた顔をする」応答になっていた。

**当初の対応（撤回）**: `title` / `project` / `query` を `z.string().min(1).optional()` に変えた。「due と違い、この 3 フィールドには『今日』のような呼び出し時にしか分からない値を注入する必要がないから素直に Zod へ寄せられる」と判断したが、これは 3 部品のうち①②だけを見て③（回復手順）を勘定に入れていなかった。

**撤回の理由**: 検証位置がハンドラから Zod スキーマへ移った結果、モデルに届く文言が SDK 自動生成の英語 1 行になった —— `Input validation error: Invalid arguments for tool upsert_task: title: Too small: expected string to have >=1 characters`。3 部品（①不正値のエコー ②期待する形式 ③アンカー・回復手順）のどれも満たしておらず、とくに title の回復手順（「新規作成なら title 必須 / 既存を更新したいなら id を指定」）が丸ごと消えた。「スキーマ検証に落とすと SDK 自動文言になる」ことは due について既に判断済みだった（「[09] due だけスキーマ検証にしない理由」）のに、同じ判断がこの 3 フィールドには適用されなかった。**この退化はサーバー側 87 テストのどれにも捕捉されなかった**（回帰検知が無かったこと自体が別項の「[09/レビュー2] fakeTaskDb を…」の動機）。

あわせて、当時のコミットは `titleRequiredError` の文言を `title=(未指定)` → `title=(未指定または空)` に書き換えたが、`.min(1)` により空文字はその経路に到達しなくなっていた。**到達不能な経路の文言を「その経路も説明します」と書き換えた**状態になっていた。

**現在の対応**: `.min(1)` を外し、検証をハンドラに戻した（due と同じ位置）。エラー文は日本語 3 部品で、それぞれ**実際にその経路へ到達する条件だけ**を説明する:

| 経路 | 到達条件 | 関数 | ③（回復手順） |
|---|---|---|---|
| upsert_task 作成 | id 未指定 かつ title が未指定 or `""` | `titleRequiredError(received)` | 既存を更新したいなら id を指定 |
| upsert_task 更新 | id あり かつ title が `""` | `emptyTitleError()` | 変えないなら title を省略 |
| search_tasks | query が `""` | `emptyQueryError()` | 絞らないなら query を省略 |
| search_tasks | project が `""` | `emptyProjectError()` | 絞らないなら project を省略 |

`titleRequiredError` は受け取った値（`undefined` / `""`）をそのままエコーし分けるので、文言と到達条件が一致する。`project` / `memo` の `""` は**拒否ではなく null 正規化**（core 側、前掲の項目）—— 検索の `project` と作成・更新の `project` で扱いが違うのは、前者が「一致させる値」、後者が「保存する値」だから。

**検証**: `packages/server/test/mcp.test.ts` の `[fix-2]`（5 ケース）。3 行であること・`Input validation error` を含まないこと・DB に一切触らずに弾かれることを固定。`.min(1)` を戻す変異で 4 本落ちることを確認した。

**ソース位置**: `todo-tools.ts` の `upsertTaskInput` / `searchTasksInput` と各ハンドラの検証、`todo-format.ts` の `titleRequiredError()` / `emptyTitleError()` / `emptyQueryError()` / `emptyProjectError()`

### [09/レビュー2] エラー文にエコーする外部由来の値を無害化する（規約側で塞ぐ）

**問題**: `?workspace=` の生値をテンプレートリテラルに直挿ししていた（`` `不正な値: workspace="${invalidQueryValue}"` ``）。改行がそのまま通るので、`?workspace=life%22%0A%0A%3CIMPORTANT%3E...` を送ると 3 行のエラー文が 6 行に割れ、注入文が独立した段落として応答本文に入り、閉じ引用符が 3 行下へ流れた（レビューが再現、こちらでも再現済み）。長さ制限も無く、`a`×5000 の値が 5123 文字の応答になった。同じ穴が `invalidDueError`（due の生エコー）にもあった。

読み手はモデルなので、応答本文の行構造は「どこまでがサーバーの言葉か」の唯一の手掛かりになる。値がそれを割れる状態は、エラー文フォーマット規約側の穴。

**対応**: エコーをやめるのではなく（①は 3 部品の一部で、原因特定に要る）、`echoValue()` を 1 つ作って**エコーする値は全部そこを通す**形にした。個々のエラー関数側で生値を埋め込む限り、次に足すエラーで同じ穴が開く。

- 制御文字（C0 / DEL）・改行・タブ・Unicode 行区切り（U+2028 / U+2029）をエスケープ表記に落とす → 値が 1 行を超えられない
- `"` と `\` もエスケープ → 閉じ引用符の位置を値の中身から動かせない
- エスケープ後 80 文字で切り、元の文字数を添える（何が来たかは分かり、長さは有界）。切るのはエスケープ単位・code point 単位なので、表記もサロゲートペアも割れない

**実測（対応後）**: 注入値 → 3 行・212 文字（改行は `\n` として 1 行目の中に見える）。`a`×5000 → 3 行・215 文字・`（全 5000 文字）` 付き。due に改行を含む値 → 3 行。

**検証**: `packages/server/test/todo-format.test.ts` の `[fix-4]`（echoValue 単体 + 「どんな入力値でも 3 行」）と `packages/server/test/mcp.test.ts` の `[fix-4]`（実際のツール経路）。生挿入に戻す変異で両方落ちることを確認した。

**副次的な発見**: 最初この変異検知を `vitest -t fix-4` で走らせたとき、`todo-format.test.ts` 側が「落ちない」と出た。原因は仕様ではなくテスト名 —— `[fix-4]` マーカーが describe の**コメント**にしか無く、フィルタが 22 件全部を skip していた（0 件実行の成功）。マーカーを describe のタイトルに入れて再実行し、落ちることを確認した。**マーカーは名前に入れる**（コメントに書くと、選択にも grep にも効かない）。

**ソース位置**: `todo-format.ts` の `echoValue()`。呼び出し元は `workspaceProblemLines()` / `invalidDueError()` / `completeReopenedError()`

### [09/レビュー2] workspace エラーの③（回復手順）はツールとリソースで共有しない

**問題**: 前回「リソース経路もツールと揃える」と決めた結果、`today-agenda` リソースがツール用の文言をそのまま返し、「ツール引数 `workspace` を明示して呼び直してください」と案内していた。しかし `resources/read` のこの Resource には **workspace 引数が存在しない**ので、その手順ではどうやっても再読できない。揃えるべきだったのは**不正値のエコー**であって**回復手順**ではなかった。

**対応**: 共有するのは①②（`workspaceProblemLines()`）だけにし、③は経路ごとに持つ。

| 経路 | ③に書く回復手順 | 実行できるか |
|---|---|---|
| ツール（get_agenda / upsert_task / search_tasks） | ツール引数 `workspace` を明示して呼び直す | ○（3 ツールとも引数を持つ） |
| リソース（todo://today） | 接続 URL の `?workspace=` を直して繋ぎ直す / `get_agenda` ツールを使う | ○（このリソースに引数が無いことも明記） |

**判断の一般形**: 「経路をまたいで揃えるもの」は事実（何が来たか・何を期待するか）であり、「揃えないもの」は呼び出し側の能力に依存する手順。前回は前者と後者を区別せずに揃えた。

**検証**: `packages/server/test/mcp.test.ts` の `[fix-9]` 2 本（リソースが実行不能な手順を含まないこと／ツール側は従来の手順を保つこと）。リソースをツール文言に戻す変異で落ちることを確認した。

**ソース位置**: `todo-format.ts` の `workspaceProblemLines()` / `workspaceMissingError()` / `workspaceMissingText()`

### [09/レビュー2] workspaceMissingError の引数を必須にする

**問題**: `workspaceMissingError` / `workspaceMissingText` の `invalidQueryValue` が optional だったため、5 つ目の呼び出しを足すときに渡し忘れてもコンパイルが通り、「不正値を受け取ったのに『未指定』と答える」修正前の挙動へ静かに戻る。直前のコミット（`fdcccc7`）が直したのがまさにその形の非対称（リソース経路だけ値を受け取っていなかった）であり、**同じ罠が型レベルで残っていた**。

**対応**: `invalidQueryValue: string | undefined` にした。呼び出し側は「クエリが無い」ことを `undefined` として**明示的に**渡す。`SearchScope.status` を optional にせず `Status | undefined` にしたのと同じ判断（「値が無い」を型の上で省略可能にしない）。

**検証**: `packages/server/test/todo-format.test.ts` の `[fix-6]` に `@ts-expect-error` 付きの省略呼び出しを置いた。optional に戻すとディレクティブが未使用になり `tsc --noEmit` が落ちる（実際に optional へ戻す変異で `error TS2578` が出ることを確認）。回帰検知が実行時ではなく型検査にあるケース。

**ソース位置**: `todo-format.ts` の `workspaceMissingError()` / `workspaceMissingText()`

### [09/レビュー] 表示層・ツール層に DB 不要の単体テストを追加した

**問題**: `buildAgenda()`（このサーバーで一番複雑な分類ロジック）の担保が手動スモーク 1 回だけだった。「server の tsconfig には node 型がなく node:sqlite の in-memory DB が使えない」という制約（「[09] TaskDb を最小インターフェースにして node:sqlite でテストする」参照）は、DB を実際に触るテスト（クエリ関数のテスト）にしか当てはまらない。`buildAgenda()` / `buildSearchResult()` / `openIdsAnchor()` は Task の配列とプリミティブしか受け取らない純関数であり、この制約の対象外。

**対応**: `packages/server/test/todo-format.test.ts` を新設し、buildAgenda のセクション境界（期限切れ / 今日が期限 / horizon ちょうど / horizon+1 の除外 / someday に due がある行の除外 / 進行中・待ちの期限なし判定）とフッター件数の内訳、buildSearchResult の 0 件時スコープ表示と絞り込み誘導行、openIdsAnchor の 20 件超過時の挙動を直接テストした。あわせて `packages/server/test/mcp.test.ts` に、素の `all`/`get` だけを持つ fake TaskDb（node:sqlite ではない）を注入した get_agenda 呼び出しを追加し、`?workspace=` の URL 既定値とツール引数 workspace の優先順位（引数が常に勝つ）を実際のツール呼び出し経由で検証した。

**ソース位置**: `packages/server/test/todo-format.test.ts`（新設）、`packages/server/test/mcp.test.ts` の `get_agenda workspace resolution ([09])`

### [09/レビュー2] fakeTaskDb を SQL 分岐型に一般化し、直した振る舞いに回帰検知を付けた

**問題**: 前回追加したテストは副次経路（リソース経路の workspace 解決、URL 既定 vs 引数の優先順位）を固定していたが、**修正の主目標 3 つにテストが無かった**——①ツール 3 経路での不正な `?workspace=` 値のエコー ②`upsert_task` の not-found アンカーに別 workspace の id が載ること ③空文字の拒否。その結果、空文字の応答が日本語 3 部品から SDK の英語 1 行に退化しても、サーバー側 87 テストのどれも落ちなかった。

原因は `mcp.test.ts` の `fakeTaskDb` の形にもあった。`get_agenda` 専用（`all()` は必ず `[]`、引数は無条件に `args[1]` を記録）で、**複数のクエリを区別する必要がある経路には使い回せない**——not-found 経路は `getTask()` の後に `listOpenTaskIds()` を撃つので、固定行を返し分けられないと検証できない。

**対応**: `fakeTaskDb` を SQL 文字列で分岐する形に一般化した。SQL を正規化して 6 種（insert / update / search / openIds / getTask / openTasks）に分類し、種別ごとに固定行を返す。分類できない SQL は `[]` を返さず**投げる**——クエリの形が変わったとき、空の結果に化けるのではなくその場で表面化する。あわせて `workspacesQueried` の記録を `openTasks` 種別だけに限定した（次項）。

これを土台に、今回と前回で直した振る舞いに回帰検知を付けた: `[fix-1]`（complete の結末）/ `[fix-2]`（空文字 5 ケース）/ `[fix-3]`（空文字の null 正規化がバインド値に出ること）/ `[fix-4]`（エコーの無害化）/ `[fix-5]`（3 経路のエコー・両 workspace アンカー）/ `[fix-8]`（下記）/ `[fix-9]`（リソースの回復手順）。**すべて、修正を剥がす変異を実際に当てて落ちることを確認済み**（13 変異／全検知）。

**ソース位置**: `packages/server/test/mcp.test.ts` の `fakeTaskDb()` / `classifyQuery()` / `taskRow()`

### [09/レビュー2] fakeTaskDb は引数の位置に暗黙依存しない

**問題**: 旧 `fakeTaskDb` は全ての `all()` 呼び出しについて `args[1]` を記録していた。`args[1]` が workspace なのは `listOpenTasks()` のバインド順（`[userId, workspace, ...OPEN_STATUSES]`）に限った話なので、`get_agenda` が将来 2 本目のクエリを発行すると、優先順位テストの `toEqual(["work","life"])` が「優先順位が壊れたから」ではなく「クエリ本数が増えたから」落ちる。テストが指す原因と実際の原因がずれる。

**対応**: 記録を `openTasks` 種別のクエリだけに限定した（SQL 分類の副産物）。`[fix-8]` として、2 本のクエリを撃つツール（not-found の `get_task`）を呼んでも `workspacesQueried` が空のままであることを固定してある。

**ソース位置**: `packages/server/test/mcp.test.ts` の `fakeTaskDb()` の `openTasks` 分岐、`[fix-8]`

---

## github.ts

### GitHub 認可 URL に scope を一切渡さない理由

**説明**: `scope` パラメータを渡さないため、GitHub は空スコープのトークンを発行する。それでも `GET /user` は `login` と `id` を返してくれ、アイデンティティ確認にはそれで十分。`read:user` のような広いスコープを要求すると、万一 upstream トークンが漏れた場合に、使う予定のないプロフィール情報まで読み取られてしまう。

**ソース位置**: `github.ts` の `buildGitHubAuthorizeUrl()`

### GitHub の token エンドポイントはエラーも HTTP 200 で返す

**説明**: `Accept: application/json` を送ると GitHub は JSON で応答するが、失敗時も HTTP ステータスは 200 のままで、ボディの `error` フィールドにエラーが入る。そのため、HTTP ステータスだけでなく必ずボディの中身を見て判定する必要がある。

**ソース位置**: `github.ts` の `exchangeGitHubCode()`

### fetchGitHubIdentity が保持するのは login と id のみ

**説明**: GitHub から返るユーザー情報のうち、保持するのは `login` と `id` だけ。`id` が不変の識別子であり、これが props の `github:<id>` になる（詳細は allowlist.ts の設計ノートを参照）。

**ソース位置**: `github.ts` の `fetchGitHubIdentity()`
