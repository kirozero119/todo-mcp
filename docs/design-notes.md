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
