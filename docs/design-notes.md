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
- [packages/core](#packagescore)
  - [09] core / server の境界をどこで切ったか
  - [09] user_id スコープを「grep で確認できる」形に保つ
  - [09] TaskDb を最小インターフェースにして node:sqlite でテストする
  - [09] 書き込みを全部 RETURNING にした理由と往復回数
  - [09] COUNT(*) OVER () で総件数と先頭 N 件を 1 往復で取る
  - [09] 読み出し時に Zod 検証をしない
  - [09/レビュー] completeTask の冪等性を UPDATE の WHERE 句自体で守る（同時実行対策）
  - [09/レビュー] updateTask の SELECT→UPDATE は非トランザクション —— 許容している理由
- [todo-tools.ts / todo-format.ts](#todo-toolsts--todo-formatts)
  - [09] user_id を引数から受け取らない構造（withUser）
  - [09] due だけスキーマ検証にしない理由
  - [09] ToolText を interface ではなく type にした理由
  - [09] プロトタイプから変えた点（agenda フッターの文言）
  - [09] ツール呼び出しログに載せるもの・載せないもの
  - [09/レビュー] upsert_task の not-found アンカーを workspace で絞らない
  - [09/レビュー] search_tasks の 0 件時のスコープ表示を実効検索条件に合わせる
  - [09/レビュー] title / project / query の空文字をスキーマ側で弾く
  - [09/レビュー] 表示層・ツール層に DB 不要の単体テストを追加した
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

**ソース位置**: `allowlist.ts` の `isGitHubUserAllowed()`

### userId のコロン制約（githubGrantUserId）

**問題**: workers-oauth-provider はアクセストークンを `${userId}:${grantId}:${secret}` という形式で発行し、検証時に `:` で分割して「ちょうど3パーツ」であることを要求する（`dist/oauth-provider.js` の `createAccessToken` / `handleApiRequest` で確認済み）。`userId` に `:` が含まれると、そのトークンは永久に検証できなくなる。

**対応**: `OAuthProvider.completeAuthorization()` に渡す `userId`（grant の識別子）だけは `-` 区切りの `github-<id>` 形式にする。props 側に保存する正規のユーザー識別子（`user_id`）は従来通り `github:<id>` のコロン区切りのまま。

**なぜこの形**: grant 識別子とアプリ内の正規ユーザー ID を別の関数（`githubGrantUserId()` / `githubUserId()`）に分けることで、provider 側の制約とアプリの識別子表現を両立させている。

**ソース位置**: `allowlist.ts` の `githubGrantUserId()` / `githubUserId()`

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

**ソース位置**: `packages/core/src/tasks.ts` の `completeTask()`。テストは `packages/core/test/tasks.test.ts`

### [09/レビュー] updateTask の SELECT→UPDATE は非トランザクション —— 許容している理由

**問題**: completeTask と違い、updateTask の「先に SELECT して差分を取る → UPDATE」という形は今回直していない。理由は差分表示（`changed`）の仕組みごと作り替えになるため——07 が定めた「実際に変わった列を返す」という応答形が、この事前 SELECT に依存している（「[09] 書き込みを全部 RETURNING にした理由と往復回数」参照）。したがって updateTask には completeTask と同種の read-then-write の隙間が残ったままである。

**実際の限界**: 2 台が同時に同じタスクを異なるフィールドで更新すると、後勝ちの UPDATE が計算する `assignments`（変更差分）は自分が読んだ古い `current` を基準にしているため、応答の `changed` が「実際に他方の変更を踏まえた差分」ではなく「自分が読んだ時点からの差分」になりうる。

**それでも壊れないもの**: status と closed_at は常に同一の UPDATE 文の中で一緒に書かれる（status 専用の分岐が `assignments.push("status = ?", "closed_at = ?")` を同時に積む）。そのため、同時実行があっても「status=done なのに closed_at=null」のような矛盾した中間状態を作ることはできない —— 最終的にどちらが勝っても、勝った側が送った status と closed_at のペアがそのまま反映されるだけ。

**ソース位置**: `packages/core/src/tasks.ts` の `updateTask()`

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

### [09/レビュー] search_tasks の 0 件時のスコープ表示を実効検索条件に合わせる

**問題**: `buildSearchResult()` の 0 件メッセージは `include_closed` だけを見て「open のみ」/「closed 含む」を出し分けていた。しかし core 側の `searchTasks()` は `status` 指定があればそれを優先し `includeClosed` を無視する分岐になっている（`if (params.status) {...} else if (!params.includeClosed) {...}`）。この非対称性が formatter に伝わっていなかったため、`status: "done"` を指定して 0 件のときに「open のみ。done / cancelled も探すには include_closed: true」という、実際の検索条件と矛盾する案内を出してしまっていた（status を優先しているのに、まだ include_closed を勧める）。逆に status を open 値に絞りつつ `include_closed: true` のときは、実際より広いスコープを表示していた。

**対応**: formatter が受け取る引数を `includeClosed` 単体から `{ status, includeClosed }`（実際に SQL が使った実効条件）に変えた。0 件時のスコープ表示は「status 指定があればそれ」「なければ includeClosed の有無」で組み立て、SQL の分岐と 1 対 1 に対応させる。`include_closed: true` への誘導文は「status 未指定 かつ includeClosed が false」のとき —— つまり実際に `include_closed: true` にすることで検索範囲が広がる場合 —— だけ出す。status 指定時や、すでに `includeClosed: true` のときは、オンにしても結果が変わらないので誘導しない。

**ソース位置**: `todo-format.ts` の `buildSearchResult()`（呼び出し元は `todo-tools.ts` の `search_tasks` ハンドラ）

### [09/レビュー] title / project / query の空文字をスキーマ側で弾く

**問題**: `upsertTaskInput` の `title` は更新経路（id あり）では一切検証されていなかった。`upsert_task(id: 12, title: "")` を呼ぶと `updateTask()` の `setIfChanged` が空文字を「現在値と違う」として素直に書き込み、一覧表示が `#12 [todo] ` になって可読性とモデルの参照性を壊す。同様に `searchTasksInput` の `project` / `query` は空文字を許していたため、`if (params.project)` / `if (params.query)`（core 側 `searchTasks()`）が空文字を falsy として無視し、絞ったつもりのフィルタが黙って外れ、全件を返す「絞れていないのに絞れた顔をする」応答になっていた。

**対応**: `title` を `z.string().min(1).optional()`、`project` / `query` を `z.string().min(1).optional()` に変えた。空文字は SDK のスキーマ検証段階で弾かれ、モデルには自動生成された Input validation error が isError で返る。due と違い、この 3 フィールドのエラー文には「今日」のような呼び出し時にしか分からない値を注入する必要がない（「[09] due だけスキーマ検証にしない理由」参照）ため、素直に Zod 側へ寄せられる。

**ソース位置**: `todo-tools.ts` の `upsertTaskInput` / `searchTasksInput`。`titleRequiredError()` の文言も「title=(未指定)」から「title=(未指定または空)」に更新した（`todo-format.ts`）

### [09/レビュー] 表示層・ツール層に DB 不要の単体テストを追加した

**問題**: `buildAgenda()`（このサーバーで一番複雑な分類ロジック）の担保が手動スモーク 1 回だけだった。「server の tsconfig には node 型がなく node:sqlite の in-memory DB が使えない」という制約（「[09] TaskDb を最小インターフェースにして node:sqlite でテストする」参照）は、DB を実際に触るテスト（クエリ関数のテスト）にしか当てはまらない。`buildAgenda()` / `buildSearchResult()` / `openIdsAnchor()` は Task の配列とプリミティブしか受け取らない純関数であり、この制約の対象外。

**対応**: `packages/server/test/todo-format.test.ts` を新設し、buildAgenda のセクション境界（期限切れ / 今日が期限 / horizon ちょうど / horizon+1 の除外 / someday に due がある行の除外 / 進行中・待ちの期限なし判定）とフッター件数の内訳、buildSearchResult の 0 件時スコープ表示と絞り込み誘導行、openIdsAnchor の 20 件超過時の挙動を直接テストした。あわせて `packages/server/test/mcp.test.ts` に、素の `all`/`get` だけを持つ fake TaskDb（node:sqlite ではない）を注入した get_agenda 呼び出しを追加し、`?workspace=` の URL 既定値とツール引数 workspace の優先順位（引数が常に勝つ）を実際のツール呼び出し経由で検証した。

**ソース位置**: `packages/server/test/todo-format.test.ts`（新設）、`packages/server/test/mcp.test.ts` の `get_agenda workspace resolution ([09])`

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
