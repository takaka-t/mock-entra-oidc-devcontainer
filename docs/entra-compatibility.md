# Microsoft Entra ID 準拠レビュー対応表

対象は固定テナントの v2.0 認可コード・更新・ログアウトと、カスタム API 向け v1／v2 アクセストークン。公式仕様の確認日は2026-11-18。旧形式の設定移行は提供しない。

## 発見事項と修正

| 項目               | 旧実装の問題                                                  | 修正・検証                                                                                                                            | 公式根拠                                                                                                                                    |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| API 登録と形式     | API の audience・形式・スコープを呼び出し元クライアントに保存 | API 登録へ分離。複数クライアントで同一設定を共有。`resources.test.ts`、`entra-conformance.test.ts`                                    | [トークン所有権](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens)                                                   |
| v2 audience        | 任意 URI を v2 の aud に使用                                  | 対象 API の GUID に変更。v1 は要求した URI／GUID、ID トークンは呼び出し元 GUID。両形式の署名・issuer・aud 検証を追加                  | [Access Token claims](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)                              |
| 委任権限           | 要求に関係なく固定 scp を付与                                 | 公開・許可・要求スコープから解決。`.default`、縮小、権限追加拒否、複数 API を試験                                                     | [スコープと同意](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)                                                     |
| OIDC のみ          | カスタム API の権限を無条件付与                               | 不透明な Graph／UserInfo 向けモックトークンと区別。カスタム API JWT を返さない                                                        | [OIDC scopes](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)                                                        |
| subject            | 保存上のユーザーキーを全アプリの sub に使用                   | テナント・oid・受信者の SHA-256 により pairwise subject を生成。署名鍵から独立。アプリ間分離・同一 API の共通性・再起動・鍵更新を検証 | [ID Token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)                                      |
| ID Token profile   | openid だけでも氏名等を返却                                   | profile による oid・name・preferred_username 制御と、email の有無・任意 claim の分離を検証                                            | [ID Token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)                                      |
| JWT ヘッダー・hash | ID トークンの typ 不足、ライブラリ依存の hash claim           | typ=JWT・RS256・kid を明示。token endpoint の at_hash・c_hash を除外                                                                  | [ID Token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)                                      |
| グループ           | 任意文字列、常時出力、件数制限なし                            | GUID、受信アプリ設定、0／200／201件の出力を検証。overage は claim_sources 表現                                                        | [Groups overage](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference#groups-overage-claim)                  |
| セッション ID      | ライブラリの uid を直接使用                                   | セッション uid から GUID を導出。コード交換・更新間で一致を検証                                                                       | [sid claim](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)                                        |
| PKCE               | 全クライアントに S256 必須                                    | SPA の必須制約と、Web／native の省略許可。plain・方式省略・不一致・不正形式を検証                                                     | [認可コードフロー](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)                                      |
| URI 種別・Origin   | PUBLIC／CONFIDENTIAL のみで SPA を区別できない                | URI ごとの種別、認可時の種別保存、コード／更新の Origin 制約、ブラウザでの secret 拒否                                                | [SPA redirects](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#redirect-uris-for-single-page-apps-spas) |
| リダイレクト       | 任意 HTTP を許容、localhost の照合差                          | HTTPS・loopback・native URI、localhost ポート例外、パスの大小、フラグメント拒否を検証                                                 | [URI 制約](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)                                                             |
| CORS               | 障害層で Origin を無条件反射                                  | 独立層へ分離。token は登録 SPA origin、公開メタデータは公開取得、authorize は CORS 非対応。正常・障害・preflight を試験               | [認可コードフロー](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)                                      |
| offline_access     | ライブラリが prompt=consent なしの要求を除去                  | 内部アダプターで Entra の同意動作に合わせる。外部には標準スコープだけ公開。明示 consent なしでも発行を検証                            | [offline_access](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-offline_access-scope)                            |
| 更新・期限         | public の旧 RT 失効、confidential の毎回更新なし、14日期限    | 毎回新しい値を発行し旧値を維持。SPA の最初の24時間、その他90日。Grant／Session の短い期限から分離                                     | [Refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)                                                  |
| ログアウト         | 別の logout URI 登録、hint なしの遷移を破棄                   | アプリ登録 URI を照合。GET／POST、hint なし、セッション終了、RT 継続を試験                                                            | [Sign-out](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc#send-a-sign-out-request)                             |
| エラー・Discovery  | 依存ライブラリの機能と Entra 対応範囲が混在                   | JSON エラー・診断情報、公開 capability の整合。Accept に依存しない token error を検証                                                 | [エラー仕様](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes)                                               |
| 永続化             | API 登録・参照制約が存在しない                                | 同一キューで登録・参照変更を直列化。保存失敗・競合・再起動・API reset を試験                                                          | モックの設定管理要件                                                                                                                        |
| 障害注入           | 固定 claim を前提とする試験                                   | 新設定で既存試験を継続し、実際の JWT／claim に適用できる場合だけ回数を消費                                                            | モックの障害試験要件                                                                                                                        |

## 実装上の境界

認可・ユーザー選択・同意・セッション・認可コードの保存とクライアント認証は `oidc-provider` が担当する。Entra 固有のコード交換と更新は公開 `registerGrantType` で実装し、JWT は `jose` で署名する。依存ライブラリの内部ファイルへの import や `node_modules` の変更は行わない。

`request-compatibility.ts` は plain PKCE を等価な S256 challenge へ変換する。offline_access はライブラリの consent 強制を避ける内部スコープへ変換し、発行時に標準スコープへ戻す。内部スコープの外部指定は拒否し、Discovery に公開しない。query を変更しても外部 endpoint の mount を維持する。

認可時の URI 種別・origin をコードに対応付け、交換後は更新トークンに保持する。RT はクライアント・ユーザー・同意済み権限に結び付く。SPA の期限は固定、その他の更新値は発行時から90日。ログアウトによる Cookie／セッションの終了と RT の期限管理を分離する。

## 修正後の再レビュー

| 発見した不備                                                          | 修正・検証                                                                                                             | 公式根拠・制限                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 更新で縮小した OIDC スコープを元の権限で上書き                        | 明示要求に合わせて claim・ID トークンを制御。同意済み RT 権限と、今回の発行スコープを分離。`entra-conformance.test.ts` | [更新要求の scope](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token)            |
| v1 の audience を常に URI へ変換                                      | 解決した接頭辞を保持し、GUID 要求・URI 要求と更新時の省略・明示を検証。v2 は常に API の GUID                           | [aud claim](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)                                       |
| コード交換で複数 API の明示指定を許容                                 | 認可時の複数 API 同意と区別し、交換時は単一 API を検証。拒否後のコード交換も確認。`resources.test.ts`                  | [コード交換の scope](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#redeem-a-code-for-an-access-token) |
| 末尾 `/` 付き URL で互換処理・Discovery 補正・JWT 障害・鍵公開を迂回  | GET／POST 認可・ログアウト、トークン診断、LIMITED 回数、ローテーション鍵の署名検証を追加                               | 末尾 `/` は既存モックの受付仕様。各 endpoint の動作は本表の公式根拠に従う                                                                  |
| 標準ライブラリ既定のフォーム項目数上限により末尾の要求を黙って破棄    | GET／POST を全項目で解析し、1000項目を超える入力を明示拒否。本文は56 KiB 以下に制限                                    | 未対応 claim 要求を無視しないモックの仕様                                                                                                  |
| DPoP を広告する一方、独自 grant は Bearer のみ発行                    | DPoP を無効化し要求を明示拒否。Discovery には実装済みの distributed group claim を反映                                 | DPoP は未実装の制限。`entra-conformance.test.ts`                                                                                           |
| native scheme と HTTPS IPv4 loopback URI の併用を依存ライブラリが拒否 | 内部メタデータの変換を IPv4 にも適用し、外部の登録 URI と照合・交換する                                                | [リダイレクト URI](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)                                                    |
| 発行できない CONFIDENTIAL＋SPA と、ホストのない API URI を保存可能    | 登録時に400で拒否し、保存前後の整合性を検証。`resources.test.ts`                                                       | 認証方式を登録単位とするモックの制限と、登録 URI の形式要件                                                                                |
| API 一覧の取得失敗がトークン発行用のユーザー候補を消去                | エディター別の状態を分離。新しい複数行フォームの保存も実行検証。`direct-token-ui.test.ts`                              | モック管理画面の要件                                                                                                                       |
| 互換層の早期エラーがプレーンテキストになる                            | JSON／ブラウザ用 HTML、診断フィールド、キャッシュ禁止を統一                                                            | [OAuth エラー応答](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-response)                      |

## 設定変更と登録制約の追加レビュー

追加確認では、設定変更を挟む次の境界ケースも修正した。

| 発見した不備                                                                        | 修正・検証                                                                                             | 根拠                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 認可後に API 権限を増やすと、コード交換で `.default` を再展開して未同意の権限を発行 | コード発行時にスコープを展開・保存。設定変更後の権限追加拒否、元のスコープでの交換・更新を検証         | [コード交換の scope](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#redeem-a-code-for-an-access-token)                          |
| URI が別 API へ再割り当てされると、古いコード・更新トークンの同意を転用             | 同意は API の GUID とスコープ名で識別。別 GUID への転用拒否と、同じ GUID の URI 変更後の明示要求を検証 | [アクセストークンの対象 API](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)                                               |
| コード発行後の oid 変更で別ユーザーとして発行                                       | 認可時の oid もコードに結び付け、保存 ID の再利用による置換を拒否                                      | モックのユーザー管理と認証結果の整合性                                                                                                                              |
| URI 登録の禁止文字・IDN・件数制限が不足                                             | 特殊文字・Unicode／punycode ドメインを拒否。256件の正常系と超過拒否を検証                              | [Redirect URI 制約](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)                                                                            |
| MSAL の補助ヘッダーを送るブラウザ要求が preflight で失敗                            | テレメトリー・ルーティング・アプリ情報のヘッダーを明示許可し、SPA origin の制約を維持                  | [Microsoft MSAL のヘッダー定義](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/msal-common-v14.0.0/lib/msal-common/src/utils/Constants.ts) |

認可情報の保存には URI ではなく API の GUID を使用する。省略時の更新先も API の GUID で保持するため、同一 API の URI 変更後も更新できる。URI 形式の v1 audience は現在の登録 URI を使用し、GUID 形式で要求した audience は GUID を維持する。

## セッションと hint の追加レビュー

| 発見した不備                                                                 | 修正・検証                                                                                                                                                      | 根拠                                                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 内部ユーザーキーを再利用すると、既存セッションが別 oid のユーザーとして SSO  | provider 内の accountId を oid に統一。oid 更新・削除後の再作成で silent 認証を拒否し、再認証で回復。表示名・グループだけの変更では SSO 継続を確認              | oid をユーザーの識別子とするモックの整合性要件                                                                 |
| POST 認可で SSO が成立すると認可障害が未適用                                 | GET／POST の両方で同じ認可 policy を適用。POST＋prompt=none の LIMITED 障害が1回消費されることを検証                                                            | モックの障害注入要件                                                                                           |
| 正しい id_token_hint でも pairwise sub と内部 accountId が一致せず再ログイン | 公開 interaction policy の check を、通常発行と同じ pairwise subject の照合へ変更。正しい hint による silent SSO、別ユーザー・別 audience・不正署名の拒否を検証 | [OpenID Connect Core の認可要求](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest)            |
| 別 API の権限削除により、対象 API へのコード交換・省略更新まで失敗           | 同意全体を保存しつつ、今回発行する単一 API の権限を検証。未指定時は元の先頭 API を GUID で解決。残った API への発行成功・削除した API への拒否を検証            | [コード交換・更新の scope](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) |

ユーザー選択・Admin API は保存上の内部キーを引き続き使用する。セッション・認可コード・Grant のアカウント識別子は oid、JWT の sub は受信者ごとの pairwise subject とし、各用途を分離する。hint の署名・issuer・audience の検証は provider の通常処理で実施し、その後に認証済みユーザーとの対応を確認する。

## 管理画面と登録設定の追加レビュー

| 発見した不備                                         | 修正・検証                                                                                                                         | 根拠                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 候補の再読み込みで手入力したスコープが全権限に戻る   | クライアントと API が同じ場合は入力を保持。権限追加後も要求範囲を増やさず、空欄は空欄のまま発行を無効化。`direct-token-ui.test.ts` | 指定したスコープだけを発行するモック管理画面の要件    |
| 大文字の HTTPS スキームと native scheme の併用を拒否 | URL の protocol で内部メタデータ変換を判定し、大文字小文字を区別せず変換。localhost／IPv4 と小文字／大文字の組み合わせで交換を検証 | 登録時の URI 検証と provider のメタデータ検証の整合性 |
| 初期 API がない状態でクライアント reset が500になる  | 他のクライアント管理操作と同じ400応答に統一。失敗後のメモリ・ファイル維持と、API 復元後の再実行成功を確認。`resources.test.ts`     | モック管理 API の入力検証と保存失敗時の整合性要件     |

## 要求解析と検証エラーの追加レビュー

| 発見した不備                                                                    | 修正・検証                                                                                                                                                                                                         | 根拠                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| トークン要求の1000項目を超える位置の scope が捨てられ、省略時の広い権限で発行   | 認可コード交換・更新にも全項目解析と項目数検証を適用。SPA／Web／native で400・JSON診断・CORS・キャッシュ禁止・拒否後の再試行を確認。1000項目ちょうどの正常系と重複 scope の拒否も検証。`entra-conformance.test.ts` | [トークン要求の scope](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)。項目数上限はモックの制限 |
| API 参照の検証エラーでも OIDC Provider の汎用エラーになり、修正対象が分からない | 対象クライアントIDと検証理由を管理APIの400応答に含める。API／スコープの参照不備と、初期APIがない状態でのリセットを検証。`resources.test.ts`                                                                        | モック管理APIの入力検証と診断要件                                                                                                    |

## 意図的な制限

- 固定単一テナント・ローカル origin。v1 issuer のホストは実 Entra の `sts.windows.net` と異なる。v1 Discovery は API トークン検証専用。
- 選択式のモック認証・自動同意。登録された API 権限を自動同意の許可リストとして使用する。管理者同意、条件付きアクセス、MFA、実際の資格情報検証は提供しない。
- クライアント認証方式は登録単位。SPA は PUBLIC 登録、Web は CONFIDENTIAL 登録を使用する。別種別のアプリで同じ API を共有できる。
- Graph／UserInfo API は提供しない。Graph 向け不透明トークンと overage の参照先は実サービスを呼べない。`groups` は SecurityGroup または None のみで、ディレクトリロールやグループ名出力には対応しない。
- client_credentials、OBO、device code、implicit、SAML、multi-tenant alias による認証、front-channel／back-channel logout は未実装。`common` は HEAD の接続プローブのみ。
- 動的 `claims` パラメーターと claims challenge、DPoP は未実装。要求は明示的に拒否し、Discovery は `claims_parameter_supported: false`、DPoP 署名方式は非公開。email・groups の設定と profile スコープによる claim 制御は対応する。
- アクセストークンの寿命は再現可能な3600秒。Microsoft 内部用の不透明 claim、認証画面、診断文面、非公開の発行アルゴリズムの完全再現は対象外。
- 状態はプロセス内。RT とコード対応情報は各最大1000件で、期限切れ・容量超過・再起動で失われる。容量による破棄は実 Entra の期限とは異なるモックの制限。
- 直接発行はモック専用 Admin API。通常の profile 付きフロー相当の JWT を作り、認証・同意・セッション作成を省略する。

## 検証コマンド

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build:check
```

主要な準拠試験は `test/entra-conformance.test.ts` と `test/resources.test.ts`。既存の OIDC・interaction・logout・HTTP fault・TLS・管理 UI・永続化テストを併用する。`https-integration.test.ts` は実 HTTPS 上の認可コードフローと証明書検証を実行する。`build:check` は空の一時ディレクトリに証明書・設定を作り、ビルド済みサーバーの新規起動を実 HTTPS で確認する。
