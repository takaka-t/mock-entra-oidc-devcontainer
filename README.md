# Mock Entra ID / OIDC Provider

Microsoft Entra IDをIdPとするアプリケーションのローカル開発・障害試験用OIDC Providerです。認可とセッション管理は`oidc-provider`、Entra 固有のトークン発行は公開 grant 拡張と`jose`、HTTP障害・遅延・不正JWT・claim変更の注入は独立したシナリオ層が担います。Entra ID完全互換ではなく、Microsoft Graph APIも提供しません。

対応フローは固定単一テナントの認可コード・更新・ログアウトです。認証はユーザー選択式、同意は自動で、MFA・条件付きアクセス・管理者同意は再現しません。任意の `claims` 要求は受け付けますが、要求によるトークン内容の変更は行いません。client_credentials・OBO・device code・implicit・SAML、front-channel／back-channel logout、claims challenge・DPoPは未対応です。

> ローカル試験専用です。インターネットへ公開しないでください。HTTPSでもAdmin APIは認証なし、ユーザー認証は選択式です。Client Secretは設定ファイル・Admin API・Admin UIで平文として扱います。

## 目次

- [起動](#起動)
- [エンドポイント](#エンドポイント)
- [TLS証明書とローカルCA](#tls証明書とローカルca)
- [ホストと別Composeからの接続](#ホストと別composeからの接続)
- [OIDCクライアントとテストユーザー](#oidcクライアントとテストユーザー)
- [開発用アクセストークンの直接発行](#開発用アクセストークンの直接発行)
- [シナリオ API](#シナリオ-api)
- [アクセスログ](#アクセスログ)
- [鍵と状態](#鍵と状態)
- [開発コマンド](#開発コマンド)

## 起動

devcontainerとNode.js 24を使用します。Tenant ID、issuer、host、portは固定で、実行時に変更できません。

```text
Tenant ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
Issuer:    https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0
```

### devcontainer起動前の準備

1. **外部networkを作成**: 初回起動前に`docker network create mock-idp-network`を実行します。
2. **ホストの名前解決を設定**: 管理者権限でhostsファイルへ`127.0.0.1 mock-idp.test`を追加します（自動変更なし）。ファイルはmacOS / Linuxでは`/etc/hosts`、Windowsでは`C:\Windows\System32\drivers\etc\hosts`です。

### devcontainer起動後のセットアップ

1. **依存関係の導入完了を確認**: `docker ps`でコンテナ名を調べ、`docker logs <コンテナ名>`で自動実行される`npm ci`の結果を確認します。失敗時や手動で入れ直す場合は、コンテナ内で`npm ci`を実行します。
2. **TLS証明書を生成**: 初回起動時と`tls-private`用named volumeの再作成時に`npm run setup:tls`を実行します（[生成ファイルと更新方法](#tls証明書とローカルca)）。
3. **Mock IdPを起動**: `npm run dev`を実行します。必要な証明書・秘密鍵の不足や不正があれば起動に失敗します（[読み込み対象](#生成されるファイル)）。
4. **接続元でCAを信頼し、疎通確認**: [接続元でローカルCAを信頼する](#接続元でローカルcaを信頼する)に従って設定し、`/health`で確認します。利用可能なURLは[エンドポイント](#エンドポイント)を参照してください。

依存関係は`.devcontainer/docker/docker-compose.yml`の`command`が起動ごとに導入します。初回・`node_modules`用named volumeの再作成・`package-lock.json`更新を反映しますが、VS Code接続直後は導入中の場合があります。導入に失敗してもコンテナは利用できます。

## エンドポイント

Mock IdPは直接HTTPSで待ち受け、HTTP listenerやHTTPSへのredirectは提供しません。OIDC endpointのpathはMicrosoft Entra ID (v2.0 endpoint)の[公式仕様](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)に準拠します。

| Endpoint                         | URL                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Discovery                        | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/.well-known/openid-configuration` |
| Authorization                    | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/oauth2/v2.0/authorize`                 |
| Token                            | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/oauth2/v2.0/token`                     |
| JWKS                             | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/discovery/v2.0/keys`                   |
| Logout (RP-Initiated Logout)     | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/oauth2/v2.0/logout`                    |
| Connectivity Probe（`HEAD`のみ） | `https://mock-idp.test:9000/common/oauth2/v2.0/authorize`                                               |
| Admin UI                         | `https://mock-idp.test:9000/__mock`                                                                     |
| Admin API                        | `https://mock-idp.test:9000/__mock/api/*`                                                               |
| Health                           | `https://mock-idp.test:9000/health`                                                                     |

- **path**: tenant直下の`/v2.0`はissuerとDiscovery用です。authorize/token/logoutは`/oauth2/v2.0`、JWKSは`/discovery/v2.0`配下にあります。Admin UI・Admin API・Healthはorigin直下です。
- **issuer**: SPAなどのauthority/issuerには固定のv2.0 issuerを設定します。Discoveryの各endpointと正常なID Tokenの`iss`はこれを基準に生成し、`tid`は固定Tenant IDです。Access Tokenは[バージョン別の設定](#アクセストークンのバージョン)を参照してください。OIDC要求のscheme・Hostがissuerのoriginと一致しない場合は`400 invalid_request_origin`です。
- **Logout**: 確認ページを経由します。送信先はtenant直下の`/oauth2/v2.0/logout/confirm`、完了ページは`/oauth2/v2.0/logout/success`で、クライアントから直接呼びません。`post_logout_redirect_uri`はアプリのリダイレクト URI に登録済みの値だけを受け付けます。GET・POST と hint の省略に対応します。
- **Connectivity Probe**: Entraへのサインイン前の到達性確認（`HEAD https://login.microsoftonline.com/common/oauth2/v2.0/authorize`）に対応します。Mockでは表のorigin直下のURLを使用し、`HEAD`のみ受け付けます（CORS preflightの`OPTIONS`は204、他のmethodは404）。Entraのmulti-tenant aliasである`common`を使った認証フローは未対応です。
- **PAR**: EntraのDiscoveryと同じく`pushed_authorization_request_endpoint`を公開せず、機能を無効化しています。

### MSAL利用時の注意

`mock-idp.test:9000`はMicrosoftの既知クラウドインスタンスではないため、HTTPSでもMSALのinstance discovery（既知authority検証）でブロックされます。

- MSAL.js（Browser / Node）は`knownAuthorities`へ`mock-idp.test:9000`を追加します。MSAL Node v5の設定先は`system`です。[custom OIDC authorityの説明](https://learn.microsoft.com/en-us/entra/msal/javascript/node/initialize-public-client-application)と[使用versionの設定リファレンス](https://learn.microsoft.com/en-us/entra/msal/javascript/node/configuration)を確認してください。
- endpointのpathはEntra準拠です。`protocolMode`の既定値（AAD）で動作するかを使用するSDK/バージョンで確認してください。`OIDC`への変更は不要な場合があります。
- MSAL.NETなど他の実装でも、対象versionとflowが提供するcustom OIDC authority APIを使用します。
- authority metadata、Discovery、issuer、署名、audience、証明書の検証は無効化しないでください。

#### `claims` パラメーター

認可（GET・form POST）、認可コード交換・更新（form POST）で `claims` を受け付けます。MSAL が既定で追加する次の任意要求を含め、mock が持たない情報はトークンに追加せず省略します。クライアント側でこの要求を取り除く設定は不要です。

```json
{
  "id_token": {
    "signin_state": { "essential": false },
    "login_hint": { "essential": false },
    "tenant_region_sub_scope": { "essential": false }
  }
}
```

- 個々の claim は `null` または要求オブジェクトで指定します。空の要求や未知の claim も受け付けます。[OIDC の仕様](https://openid.net/specs/openid-connect-core-1_0.html#IndividualClaimsRequests)に従い、通常の claim は `essential: true` であっても情報がなければ省略します。トークン内容は既存の scope とクライアント・API 設定で決まり、要求から値を転記したり profile 情報を追加したりしません。`userinfo` の要求を受け付けても UserInfo endpoint は提供しません。
- `access_token.xms_cc` の機能通知（例：`{"access_token":{"xms_cc":{"values":["CP1"]}}}`）も受け付けます。`values` は文字列の配列で、大文字小文字や未知の機能名でも拒否しません。`xms_cc` の発行には API 側の optional claim 設定が必要です。この mock は `xms_cc` 用の設定を提供していないため、アクセストークンから省略します。[Microsoft の仕様](https://learn.microsoft.com/en-us/entra/identity-platform/claims-challenge)
- `acr` の任意要求（`essential` の省略または `false`）は `value` / `values` があっても受け付け、この mock では省略します。`sub` の `value` / `values` によるユーザー指定、`acr` の `essential: true`、`acrs` の `essential: true` または `value` / `values` による認証制約は未対応です。認証制約と任意要求が混在していても `invalid_request` を返します。
- 不正 JSON、不正な型、`value` と `values` の併用、`claims` パラメーターの重複は `invalid_request` です。単一の空値（`claims=`）は未指定として扱います。認可では検証済みの redirect URI に `state` とエラーを要求された response mode で返し、コード交換・更新では HTTP 400 の JSON を返します。コード交換で拒否しても認可コードは消費しません。

[Microsoft の公開 Discovery](https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration)と同様に `claims_parameter_supported` は省略します。任意要求を受け付けるための互換処理であり、汎用的な claim 選択や条件付きアクセスの完全互換を示すものではありません。

### 公開プロトコルの互換性

Entra ID v2 と OIDC / OAuth の仕様を基準にしています。要求例と期待する応答は、[claims の互換性テスト](test/claims-compatibility.test.ts)と[公開プロトコルの互換性テスト](test/protocol-compatibility.test.ts)で確認できます。

- 認可の `query`・`fragment`・`form_post` に対応します。検証済みのクライアントと redirect URI がある場合、認可の意味検証エラーも指定された形式で `state` とともに返します。不明なクライアント、不正・未登録・重複した redirect URI には返しません。本文サイズ・項目数の上限を超えた要求は直接拒否します。
- 認可・コード交換・更新・ログアウトで、単一の空パラメーターは未指定として扱います。空白だけの値は空値ではありません。空値を含む重複パラメーターは正規化で消さず、認識するパラメーターの重複を拒否します。未知の拡張パラメーターは無視します。
- `login_hint` は `preferred_username` と空でない `mail` を大文字小文字を区別せず照合します。`prompt=none` で現在のユーザーと一致しない場合は `login_required` です。対話型では既存のユーザー選択を行い、明示的な選択後は hint と異なるユーザーでも認証できます。opaque な hint は解釈しません。hint 自体で認証を成立させることはありません。
- 認可・コード交換・更新で `client_info=1` を指定すると、応答パラメーター `client_info` に Base64url 形式の JSON `{"uid":"<ユーザーの oid>","utid":"<固定 Tenant ID>"}` を返します。各リクエストで判断し、省略・空値・`0`・未知の値では追加しません。JWT の claim や保存形式は変えません。固定単一テナントのため、ゲストのホームテナント情報は再現しません。
- `domain_hint` によるフェデレーション先の選択や、`logout_hint` による確認画面の省略は再現しません。ログアウトは引き続き確認フローを経由します。

## TLS証明書とローカルCA

### 生成されるファイル

`npm run setup:tls`でローカルCAと`mock-idp.test`用サーバー証明書を生成します。

| ファイル                           | 用途                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| `.data/tls/ca.crt`                 | 接続元へ登録する公開CA証明書。起動時に検証用に読み込む         |
| `.data/tls/server.crt`             | Mock IdPが提示するサーバー証明書。起動時に読み込む             |
| `.data/tls-private/ca.key.pem`     | CA秘密鍵。証明書更新時のみ使用し、サーバー起動時は読み込まない |
| `.data/tls-private/server.key.pem` | サーバー秘密鍵。起動時に読み込む                               |

- **保存先とpermission**: 公開証明書はリポジトリのbind mountに含まれ、ホストから参照できます。秘密鍵は`node_modules`と同様に専用named volume（`tls-private`）へ保存し、ホストのファイルシステムからは直接見えません。Linux VM上のファイルシステムを使うことで、Windows Docker Desktopのbind mountでPOSIX permissionを保持できない問題を回避します。
- `.data/tls-private`は0700、秘密鍵は0600で作成・検証します。検査の回避や権限の緩和はしないでください。機密情報でない公開証明書には、bind mount側での正確なpermission一致を要求しません。
- `--output-dir`と`--private-dir`は独立したディレクトリを指定します。正規化後に同一・親子関係となる場合は、ファイル生成前にエラーで終了します。
- **配布対象は`ca.crt`だけ**です。両秘密鍵を共有ストレージ、接続元コンテナ（mount・COPYを含む）、ホストOSのtrust storeへコピーしないでください。

### 接続元でローカルCAを信頼する

HTTPS接続には、接続元で公開CAの`.data/tls/ca.crt`を信頼させる必要があります。Mock IdPコンテナ自身のOS trust storeへの登録は不要です。

- **ホストのブラウザ・アプリ**: ホストOS、ブラウザ、runtimeのtrust storeへ登録します。
- **別Composeのアプリ**: 公開CAをread-only mountまたはimageへ組み込み、接続元のOS・runtime・SDKで信頼を設定します。CA更新後はimageの再build、またはmount先プロセスの再起動・reloadが必要です。
- 登録・解除は利用環境（OS・ブラウザ・runtime・SDK・base image）の公式手順と組織のセキュリティポリシーに従います。信頼するのは開発端末・テスト用コンテナだけとし、不要になったら解除してください。
- curlの`-k`/`--insecure`やruntime・SDKの設定で証明書検証を無効化しないでください。devcontainer内の疎通確認例:

```bash
curl --cacert .data/tls/ca.crt https://mock-idp.test:9000/health
```

### 証明書の更新とCAローテーション

`npm run setup:tls`の再実行時の動作は次のとおりです。更新後はMock IdPを再起動します。

| 状態                                                                                             | 結果                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 両ディレクトリに有効な2ファイルずつが揃い、CAの残存期間が397日より長く、サーバー証明書が30日以上 | 変更なし                                         |
| サーバー証明書の残存期間が30日未満または期限切れで、CAの残存期間は397日より長い                  | 同じCAでサーバー証明書だけ更新（CAの再登録不要） |
| CAの残存期間が397日以下                                                                          | 失敗。有効期限内のCAローテーションが必要         |
| CAが期限切れ、ファイルが不足・不正、または両ディレクトリの状態が不一致                           | 失敗。自動上書きしない                           |

**CAのローテーション手順**

1. サーバーを停止する。
2. 旧CAをすべての接続元のtrust storeから解除する。
3. `npm run setup:tls -- --rotate-ca`で新規CAを生成する。
4. 新しい`ca.crt`をすべての接続元へ再登録する。
5. [接続元への反映方法](#接続元でローカルcaを信頼する)に従ってimageを再buildし、Mock IdPと接続元プロセスを再起動する。

> CAが期限切れの場合も`--rotate-ca`は不正なディレクトリを上書きしません。Mock IdPを停止し、`.data/tls`と`.data/tls-private`をそれぞれ別名へ退避してから手順3を実行してください。

**異常終了時の復旧手順**

異常終了時は次のファイルが残る場合があります。復旧候補がある間は新しいCAを生成できません。ロックだけを削除して再実行しないでください。

| 残存ファイル       | 場所・形式                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 同時実行防止ロック | `.data/tls.setup.lock`                                                                                                               |
| backup             | 各ディレクトリ内の`<ファイル名>.backup-<pid>-<uuid>`（例: `.data/tls/ca.crt.backup-*`、`.data/tls-private/server.key.pem.backup-*`） |
| 一時ディレクトリ   | `.data/tls/.tls-setup-*`、`.data/tls-private/.tls-setup-*`                                                                           |

1. 別の`setup:tls`プロセスが動いていないことを確認する。
2. 正規の`.data/tls`・`.data/tls-private`と上記の復旧候補を確認する。
3. 正規ディレクトリがなければ、確立済みCAを含むbackupをそれぞれ元のパスへ戻して検証する。

## ホストと別Composeからの接続

Composeのservice名は`app`、公開hostnameはDocker network aliasの`mock-idp.test`です。コンテナの`0.0.0.0:9000`をホストの`127.0.0.1:9000`へ公開します。

```text
ホストのブラウザ:
  https://mock-idp.test:9000 → hosts (mock-idp.test → 127.0.0.1) → localhost:9000 → Docker port forwarding → app (Mock IdP):9000

別Composeのアプリケーションコンテナ:
  https://mock-idp.test:9000 → Docker DNS / network alias → mock-idp-network → app (Mock IdP) Container
```

別Composeのアプリを同じexternal networkへ参加させ、[公開CAを信頼](#接続元でローカルcaを信頼する)させます。名前解決はDocker DNSが行うため、コンテナ内のhosts設定は不要です。network名はComposeのproject名に依存しません。

```yaml
services:
  app:
    networks:
      - mock-idp-network

networks:
  mock-idp-network:
    external: true
```

- issuerを`localhost`へ置き換えないでください。`localhost`は各実行環境自身を指し、接続元ごとにissuerを変えるとDiscoveryやJWTの`iss`検証が不整合になります。
- hostnameにはテスト用の予約ドメイン`.test`を使います。`.local`はmDNSの名前解決と衝突する可能性があります。

## OIDCクライアントとテストユーザー

API 登録・OIDC クライアント・テストユーザーを Admin UI または Admin API で管理します。変更は再起動なしで反映し、設定は `.data/resources.json`・`.data/clients.json`・`.data/users.json` に0600で保存します。初回起動では初期データを作成します。

API 登録でアクセストークンの形式と公開スコープを、クライアント登録で要求可能な API 権限と ID トークンの claim 設定を管理します。

### Entra ID のアプリ登録との対応

Entra ID のアプリ登録は1種類で、設定内容によってクライアント・API の役割が決まります。このモックでは役割ごとに次の登録へ分けて管理します。

| Entra ID のアプリ登録の設定                                                          | このモックの登録先                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 認証（プラットフォーム・リダイレクト URI）、証明書とシークレット                     | OIDCクライアント（`redirectUris`・`clientType`・`clientSecret`）                                             |
| API のアクセス許可                                                                   | OIDCクライアント（`requiredResourceAccess`）                                                                 |
| API の公開（Application ID URI・スコープ）、マニフェストのアクセストークンバージョン | API 登録（`identifierUri`・`scopes`・`requestedAccessTokenVersion`）                                         |
| トークン構成（groups・email）                                                        | ID トークンは OIDCクライアント、アクセストークンは API 登録（`groupMembershipClaims`・`emailOptionalClaim`） |

- SPA とバックエンド API をそれぞれアプリ登録する構成では、SPA を OIDCクライアント、バックエンド API を API 登録として登録し、SPA の API 権限でバックエンド API のスコープを許可します。トークンを検証するだけのバックエンド API は OIDCクライアントの登録が不要です。
- 1つのアプリ登録がサインインと API の公開を兼ねる構成は、同じ GUID で OIDCクライアントと API 登録の両方を登録して再現します（例: `identifierUri` を `api://<clientId>` とし、クライアントの API 権限に自身の API を追加）。アクセストークンの `aud` と `azp` は同じ値になります。
- Entra ID の `groupMembershipClaims` はアプリ単位の設定です。同じ GUID で両方を登録する場合は、OIDCクライアントと API 登録の groups 設定をそろえてください。このモックは両者を別々に保存し、一致を検証しません。

### API 登録

初期 API は次の設定です。

```json
{
  "resourceAppId": "55555555-5555-4555-8555-555555555555",
  "identifierUri": "api://55555555-5555-4555-8555-555555555555",
  "scopes": ["access_as_user", "api.read", "api.write"],
  "requestedAccessTokenVersion": 2,
  "emailOptionalClaim": true,
  "groupMembershipClaims": "SecurityGroup"
}
```

- `resourceAppId` は対象 API のアプリケーション ID（GUID）。`identifierUri` は `api://` または `https://` の Application ID URI です。ID・URI は重複できません。
- `scopes` は公開する委任権限の名前。要求では `<identifierUri>/<scope>` を使用します。API ID を接頭辞にした指定も受け付けます。スコープ名は大文字小文字を区別します。
- `requestedAccessTokenVersion` は `2` が v2.0、`1`・`null` が v1.0。呼び出し元のクライアントや v2.0 認証エンドポイントから独立して決定します。
- `emailOptionalClaim` と `groupMembershipClaims` は、この API 向けアクセストークンの claim 設定です。Admin UI の「アクセストークンの属性」で「groupsを含める」「emailを含める」を切り替えます。`groupMembershipClaims` は `None` または `SecurityGroup` として保存し、登録グループはすべてセキュリティグループとして扱います。所属グループなし・メールアドレス未設定の場合は対応する属性を省略します。API側のemailが無効の場合、クライアント側のemail設定や `email` スコープの要求では有効になりません。
- 新規API登録と初期APIではgroups・emailを両方有効にします。これは試験の利便性を優先したモックの初期値です。既存ファイルの設定は無効の値も維持し、初期APIの値は初回生成と明示的なリセット時に適用します。管理API・保存JSONの形式は変更せず、移行は不要です。
- クライアントが参照している API の削除、参照スコープの削除、それらを削除するリセットは409です。参照元のクライアント設定を先に変更してください。

### OIDCクライアント

| 初期アプリ | clientId                               | 認証区分     | プラットフォーム | 認証方式            |
| ---------- | -------------------------------------- | ------------ | ---------------- | ------------------- |
| ネイティブ | `00000000-0000-4000-8000-000000000001` | PUBLIC       | native           | none                |
| Web        | `00000000-0000-4000-8000-000000000002` | CONFIDENTIAL | web              | client_secret_basic |
| SPA        | `00000000-0000-4000-8000-000000000003` | PUBLIC       | spa              | none                |

初期リダイレクト URI は `http://localhost:3000/callback`。Web の secret は `mock-client-secret-change-me`。初期アプリには初期 API の全公開スコープを許可します。

```json
{
  "clientId": "00000000-0000-4000-8000-000000000003",
  "clientType": "PUBLIC",
  "tokenEndpointAuthMethod": "none",
  "redirectUris": [{ "uri": "http://localhost:3000/callback", "type": "spa" }],
  "requiredResourceAccess": [
    {
      "resourceAppId": "55555555-5555-4555-8555-555555555555",
      "scopes": ["access_as_user", "api.read", "api.write"]
    }
  ],
  "emailOptionalClaim": true,
  "groupMembershipClaims": "SecurityGroup"
}
```

- `clientId` は GUID。PUBLIC は secret なし・認証方式 `none`、CONFIDENTIAL は secret と `client_secret_basic` または `client_secret_post` を指定します。`web` URI は CONFIDENTIAL、`spa` URI は PUBLIC を使用します。認証方式はこのモックではクライアント単位の設定です。
- `redirectUris` の各項目は `uri` と `type`（`spa`・`web`・`native`）。HTTPS とローカル HTTP を使用でき、native は登録済みカスタムスキームも使用できます。フラグメント、認証情報、IPv6 localhost、国際化ドメイン、特殊文字 `! $ ' ( ) , ;` は受け付けません。最大256件、各256文字です。localhost は照合時にポートを無視しますが、コード交換の `redirect_uri` は認可時の値と一致させます。パスの大文字小文字は区別します。
- localhost でポートだけが異なる複数 URI の登録は拒否します。アプリ種別の区別にはパスを変えてください。
- `requiredResourceAccess` はローカル自動同意の許可リストです。対象 API と公開スコープが存在する必要があります。要求していない API 権限はトークンに追加しません。
- クライアントの `emailOptionalClaim`・`groupMembershipClaims` は **ID トークン用**です。Admin UI の「IDトークンの属性」で「groupsを含める」「emailを常に含める」を切り替えます。新規登録・初期クライアントでは両方が有効です。編集時は既存の設定を保持し、保存済みの無効設定を自動で有効にしません。email は未チェックでも `email` スコープを要求すると含まれます。メールアドレス未設定・所属グループなしの場合は対応する属性を省略します。アクセストークンには対象 API の設定を使用します。
- ログアウト後の URI も `redirectUris` に登録します。別の `postLogoutRedirectUris` 設定はありません。`post_logout_redirect_uri` 単独での GET／POST ログアウトも処理します。未登録の遷移先へはリダイレクトしません。

### 認可コード・PKCE・スコープ

認可要求の例（実際は URL エンコードしてください）:

```text
GET /aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/oauth2/v2.0/authorize
  ?client_id=00000000-0000-4000-8000-000000000003
  &response_type=code
  &redirect_uri=http://localhost:3000/callback
  &scope=openid profile offline_access api://55555555-5555-4555-8555-555555555555/api.read
  &state=<ランダム値>
  &nonce=<ランダム値>
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &code_challenge_method=S256
```

- SPA は PKCE 必須。Web・native は省略可能ですが、使用を推奨します。指定した PKCE はどのアプリでも検証し、`S256`・`plain` に対応します。challenge のみ指定した場合は `plain` として扱います。
- SPA のコード交換・更新にはリダイレクト URI と同じ origin の `Origin` ヘッダーが必要です。Web・native のコードはブラウザから交換できません。`Origin` がある要求で client secret を使用できません。
- `scope=<API URI>/.default` はクライアントに許可した対象 API のスコープへ展開します。`.default` と個別 API スコープの混在はエラーです。認可時は複数 API への同意が可能です。コード交換で `scope` を明示する場合、API は1つに限定します。省略時は認可要求の最初の API 向けに発行します。更新では同意済みの別 API を選択でき、複数 API を指定した場合は最初の API 向けに発行します。
- 不明な API・スコープ・未許可の権限は `invalid_scope`。更新では取得済み権限の縮小が可能で、新しい権限の追加は拒否します。明示した `scope` から `profile`・`email`・`openid` を外すと、対応する claim・ID トークンも返しません。更新トークンの同意済み権限は保持され、`scope` を省略した更新では、元の認可要求の OIDC スコープと最初の API 権限を使います。
- `openid` で ID トークン、`profile` で `oid`・`name`・`preferred_username`、`email` またはクライアントの任意 claim 設定で、存在する場合に `email` を返します。
- OIDC スコープだけの要求には Graph／UserInfo 向けの不透明なモックアクセストークンを返します。カスタム API の権限は付与しません。このモックは Graph／UserInfo API を実装しておらず、そのトークンで実サービスを呼び出すこともできません。
- `offline_access` でリフレッシュトークンを返します。`prompt=consent` の強制指定は不要です。更新のたびに新しい値を発行し、旧値も期限まで有効です。SPA は最初の発行から24時間を後続値にも継承し、それ以外は発行から90日です。ログアウトだけでは失効しません。
- 認可コードは60秒、通常の ID／アクセストークンは3600秒です。コードは一度だけ交換でき、並行要求でも再利用を拒否します。

### アクセストークンのバージョン

| 検証対象         | v1.0 Access Token                                                  | v2.0 Access Token / ID Token                                           |
| ---------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| issuer           | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/` | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0` |
| Discovery        | `/{tenant}/.well-known/openid-configuration`                       | `/{tenant}/v2.0/.well-known/openid-configuration`                      |
| JWKS             | `/{tenant}/discovery/keys`                                         | `/{tenant}/discovery/v2.0/keys`                                        |
| Access Token aud | 要求した API の URI または GUID                                    | 対象 API の `resourceAppId`                                            |
| 呼び出し元       | `appid`・`appidacr`                                                | `azp`・`azpacr`（Access Token のみ）                                   |
| ユーザー名       | `unique_name`                                                      | `preferred_username`（profile 要求時）                                 |

ID トークンの `aud` は常に呼び出し元の `clientId`、`ver` は `2.0` です。JWT ヘッダーは `typ: JWT`・`alg: RS256`・`kid` を持ちます。`/token` で発行する ID トークンには `at_hash`・`c_hash` を含めません。`scp` は要求・許可した API スコープ名の空白区切りで、レスポンスの `scope` はその API URI を付けた値です。

v1 の `aud` は、要求スコープの接頭辞が `resourceAppId` なら GUID、`identifierUri` なら URI です。同じ API を両方の接頭辞で指定した場合は先頭の指定を使います。直接発行では `identifierUri` を使います。

v1 の Discovery はアクセストークン検証用で、issuer・JWKS URI・RS256 のみ公開します。v1 の認可／トークンエンドポイントは提供しません。実環境の `sts.windows.net` の代わりに、このモックの origin を使用します。

### テストユーザーと識別子

| 内部 ID（保存上の sub） | 表示名            | preferred_username         | oid                                    | 初期グループ |
| ----------------------- | ----------------- | -------------------------- | -------------------------------------- | ------------ |
| `user-admin`            | Admin User        | `admin@example.com`        | `11111111-1111-1111-1111-111111111111` | 管理者・一般 |
| `user-normal`           | Normal User       | `user@example.com`         | `22222222-2222-2222-2222-222222222222` | 一般         |
| `user-unauthorized`     | Unauthorized User | `unauthorized@example.com` | `33333333-3333-3333-3333-333333333333` | なし         |

管理者グループ ID は `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1`、一般グループ ID は `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2` です。

- ユーザー設定の `sub` はサインイン画面と Admin API が使用する**内部キー**で、JWT の `sub` とは別です。JWT の `sub` はテナント・ユーザーの `oid`・受信アプリから導出します。ID トークンの受信者はクライアント、アクセストークンの受信者は API。別アプリ間で異なり、同じ受信者には再起動・鍵更新後も同じ値を返します。
- 内部キーは前後の空白を除いて1〜100文字の印字可能ASCII（`.`・`..` は不可）。作成時に省略すると UUID を生成します。作成後は変更できません。
- `oid` と `groups` は GUID を小文字に正規化します。`oid` と `preferred_username` はユーザー間で重複不可。表示名・username は Unicode を保持し、改行を拒否します。
- `mail` はメールアドレスまたは空文字です。空の場合は `email` claim を返しません。`tid` は固定値でユーザー設定には含めません。
- グループが0件または出力設定が `None` の場合は `groups` を省略します。200件までは GUID 配列、201件以上では `_claim_names`・`_claim_sources` の overage 表現を返します。参照先 Graph API はこのモックの提供範囲外です。
- `sid` はログインセッションごとの GUID。認可コード交換・更新を通して同じ値を維持します。

### 共通の動作

管理画面下部の登録一覧は、テストユーザー・OIDCクライアント・API登録の順に表示します。登録フォームは主ボタンの「登録／更新」と「キャンセル」を下部に配置します。完了通知は画面右上に縦に並び、「閉じる」で個別に消せます。通常は10秒後に消えますが、通知上にマウスやキーボードフォーカスがある間は維持します。

接続情報・アクセストークンはラベル横のコピーアイコンからコピーします。成功・失敗は右上通知で表示し、フォーム内に結果ラベルを追加しません。コピーできない場合も元の値は保持します。登録フォーム3種の入力エラーは、各項目の直下とフォーム上部の一覧に表示します。一覧から該当項目へ移動でき、送信時は最初のエラー項目へ移動します。入力を変更するとその項目の古いエラーを消し、次の送信で再検証します。

アクセストークン発行の候補は、同じ管理画面での登録・編集・削除・初期化に合わせて更新します。候補を取得できなかった場合は、エラーで開いた該当一覧の「一覧を再読み込み」から再試行してください。登録内容の表は、狭い画面では表の領域内を横スクロールできます。

### 管理 API

base URL は `https://mock-idp.test:9000`。POST／PUT は `application/json` が必要で、指定された `Origin` はこの origin と一致する必要があります。

| 対象           | 一覧・作成                         | 更新・削除                                          | リセット                           |
| -------------- | ---------------------------------- | --------------------------------------------------- | ---------------------------------- |
| API 登録       | GET / POST `/__mock/api/resources` | PUT / DELETE `/__mock/api/resources/:resourceAppId` | POST `/__mock/api/resources/reset` |
| クライアント   | GET / POST `/__mock/api/clients`   | PUT / DELETE `/__mock/api/clients/:clientId`        | POST `/__mock/api/clients/reset`   |
| テストユーザー | GET / POST `/__mock/api/users`     | PUT / DELETE `/__mock/api/users/:sub`               | POST `/__mock/api/users/reset`     |

更新本文は ID を除いた全設定、リセット本文は `{}`。作成成功201、削除成功204、入力不正400、未登録404、重複・参照中409です。変更を直列化し、保存に失敗した場合は以前のメモリ・ファイル・Provider 設定を維持します。

Admin UI では1クライアントにつきプラットフォームを1種類選択し、その下に複数のリダイレクト URI を登録します。新規登録のプラットフォームは未選択、URI は空欄です。選択肢はシングルページアプリケーション（SPA）・Web・モバイル／デスクトップです。「URIを追加」で行を追加し、各行の「削除」で削除します（1〜256件）。ログアウト先も同じ欄へ登録してください。貼り付けた内容は切り詰めず、前後の空白を除去してから各 URI の256文字制限を保存時に検証します。既存設定が複数種類を含む場合はURIをすべて表示し、プラットフォームを明示的に選択するまで保存できません。保存すると、URIを削除せず選択した1種類へ統一します。

クライアントの認証区分（PUBLIC／CONFIDENTIAL）はプラットフォームとは別の設定です。このモックでは認証方式をクライアント単位で管理するため、SPA は PUBLIC、Web は CONFIDENTIAL が必要で、SPA と Web の混在には対応しません。組み合わせは保存時に検証します。API・保存 JSON は従来どおり各 URI に type（spa・web・native）を持ち、移行は不要です。

Admin UIのプラットフォーム候補は、PUBLICではSPA・モバイル／デスクトップ、CONFIDENTIALではWeb・モバイル／デスクトップに絞ります。認証区分を変更して利用できなくなった選択は未選択に戻し、URIは保持します。利用可能な選択は維持します。管理APIの整合性検証は引き続き行います。

登録APIの入力検証エラーは、従来のHTTPステータス・`error`・`message`に加えて `issues: [{ path, message }]` を返します。`path`の配列添字は0始まりです。UIではこの情報を使ってURIの該当行やスコープなどの入力欄にエラーを表示します。通信失敗や項目を特定できないエラーはフォーム上部に表示し、入力は維持します。

API 権限は「権限を追加」から登録済みの自APIを選び、公開スコープをチェックして追加します。複数APIの権限を設定でき、追加済みの権限はAPI・スコープ・種類（委任）の一覧から個別に削除できます。ログインだけの試験では設定不要で、新規登録時は未選択です。`access_as_user` はAPIをユーザーとして呼び出す権限、`api.read`・`api.write` は操作別の権限の命名例であり、特別な動作を持つ予約名ではありません。

候補の選択中はクライアントを保存できません。「選択した権限を追加」で編集内容に反映するか、「キャンセル」で選択を破棄してください。API候補は「権限を追加」を開くと自動取得します。取得に失敗した場合は「キャンセル」で閉じてから開き直してください。追加済みの権限は維持します。未登録になったAPI・スコープは一覧に表示して削除でき、保存時はサーバーでも登録内容を検証します。保存形式は従来の `requiredResourceAccess: [{ resourceAppId, scopes }]` のままで、移行は不要です。Microsoft Graph・アプリケーション権限・管理者同意の設定には対応しません。保存失敗時は入力を維持し、未保存で閉じる場合は変更の破棄を確認します。

## 開発用アクセストークンの直接発行

通常のサインインを省略して、バックエンド API の試験用 JWT を発行します。Admin UI でクライアント・ユーザー・API・許可スコープを選択するか、次の API を呼びます。これは開発専用機能で、Entra ID の OAuth grant ではありません。profile を要求した通常フロー相当のユーザー情報を付与し、API の任意 claim 設定を適用します。

```bash
curl --cacert .data/tls/ca.crt \
  https://mock-idp.test:9000/__mock/api/tokens \
  -H 'content-type: application/json' \
  -d '{
    "clientId":"00000000-0000-4000-8000-000000000001",
    "userId":"user-admin",
    "resourceAppId":"55555555-5555-4555-8555-555555555555",
    "scopes":["api.read"]
  }'
```

戻り値は `access_token`・`token_type`（Bearer）・`expires_in`（3600）・`scope`・`fault`。ID／リフレッシュトークンやログインセッションは作成しません。JWT は通常フローと同じ署名鍵・API 設定・権限検証・claim 生成を使用します。未登録対象は404、不正な本文・権限は400で、障害回数を消費しません。

`NO_GROUPS`、`WRONG_AUDIENCE`、`WRONG_ISSUER`、`WRONG_TENANT`、`MISSING_CLAIM`、`EXPIRED_TOKEN`、`FUTURE_NBF`、`INVALID_SIGNATURE`、`UNKNOWN_KID`、`SIGNING_KEY_ROLLOVER`、`ALG_NONE` を適用できます。ID トークン専用・HTTP・認可・Discovery・JWKS 障害は直接発行には適用しません。LIMITED は1要求で最大1回消費し、適用した場合は `fault` とアクセスログ以外の管理通知で確認できます。

## シナリオ API

Admin APIのbase URLは[エンドポイント](#エンドポイント)のとおりorigin直下です。

```bash
MOCK_ORIGIN=https://mock-idp.test:9000
CURL_CA=.data/tls/ca.crt

curl --cacert "$CURL_CA" "$MOCK_ORIGIN/__mock/api/scenario"

curl --cacert "$CURL_CA" -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_500","mode":"LIMITED","failureCount":2}'

curl --cacert "$CURL_CA" -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_TIMEOUT","mode":"CONTINUOUS","parameters":{"delayMs":100}}'

curl --cacert "$CURL_CA" -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_429","mode":"LIMITED","failureCount":1,"parameters":{"retryAfterSeconds":60}}'

curl --cacert "$CURL_CA" -X DELETE "$MOCK_ORIGIN/__mock/api/scenario"
curl --cacert "$CURL_CA" -X POST "$MOCK_ORIGIN/__mock/api/reset" \
  -H 'content-type: application/json' \
  -d '{}'
```

### シナリオの適用ルール

- **`CONTINUOUS`**: 解除・Resetまで対象要求すべてに適用します。
- **`LIMITED`**: 1以上の`failureCount`が必須です。対象要求だけが同期的に回数を消費し、最後の1回にもFaultを返してNORMALへ戻ります。Timeoutは遅延開始時に消費し、クライアント切断でも戻しません。対象外endpoint・method・`OPTIONS`では消費しません。
- **対象method**: Connectivity Probeは`HEAD`、Tokenは`POST`、JWKS・Discoveryは`GET`です。Authorization endpointはHTTP faultの対象外です。認可応答・Token改変の消費条件は[認証応答の不正](#認証応答の不正)、直接発行は[適用する障害シナリオ](#適用する障害シナリオ)を参照してください。
- **共有範囲**: 状態はプロセス全体で1つです。`client_id`・redirect URI・セッション単位では分離されず、別テスト・別アプリ・silent SSOのiframeなどの対象要求が先にFaultを消費すると、そちらに作用し、意図した要求には作用しない場合があります。1インスタンス内では認可フローを直列実行し、並列テストではワーカーごとにMock IdPを分離してください。

### シナリオ一覧

`WRONG_*`・`EXPIRED_TOKEN`・`FUTURE_NBF`・`MISSING_CLAIM`・`NONCE_*`は通常鍵で署名します。

| シナリオ                                             | 対象                                 | 動作                                                                                                   |
| ---------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `NORMAL`                                             | なし                                 | Faultなし                                                                                              |
| `ACCESS_DENIED`                                      | Authorization OAuth                  | 検証済みredirect URIへ`access_denied`                                                                  |
| `AUTH_LOGIN_REQUIRED`                                | Authorization OAuth                  | 検証済みredirect URIへ`login_required`                                                                 |
| `AUTH_INTERACTION_REQUIRED`                          | Authorization OAuth                  | 検証済みredirect URIへ`interaction_required`                                                           |
| `AUTH_TEMPORARILY_UNAVAILABLE`                       | Authorization OAuth                  | 検証済みredirect URIへ`temporarily_unavailable`                                                        |
| `AUTH_SERVER_ERROR`                                  | Authorization OAuth                  | 検証済みredirect URIへ`server_error`                                                                   |
| `AUTH_STATE_MISMATCH`                                | Authorization response               | 成功応答の`state`を固定値`mock-mismatched-state`に置換                                                 |
| `AUTH_STATE_MISSING`                                 | Authorization response               | 成功応答の`state`を削除                                                                                |
| `AUTH_CODE_INVALID`                                  | Authorization response               | 成功応答の`code`を無効なランダム値に置換。交換時は`invalid_grant`                                      |
| `AUTH_CODE_MISSING`                                  | Authorization response               | 成功応答の`code`を削除（`error`なし）                                                                  |
| `AUTH_CODE_WITH_ERROR`                               | Authorization response               | 成功応答の`code`を残し、`error=server_error`・`error_description`を追加                                |
| `AUTH_400`                                           | `HEAD` Connectivity Probe            | HTTP 400、本文なし                                                                                     |
| `AUTH_429`, `AUTH_500`                               | `HEAD` Connectivity Probe            | HTTP 429/500、任意の`Retry-After`、本文なし                                                            |
| `AUTH_TIMEOUT`                                       | `HEAD` Connectivity Probe            | 指定時間遅延後にHTTP 200                                                                               |
| `NO_GROUPS`                                          | ID/Access Token                      | `groups`を削除（空配列にはしない）                                                                     |
| `WRONG_AUDIENCE`                                     | ID/Access Token                      | `aud`を実際の`client_id`と無関係な固定値に変更                                                         |
| `WRONG_ISSUER`                                       | ID/Access Token                      | `iss`を実際のissuerと異なる固定値に変更                                                                |
| `WRONG_TENANT`                                       | ID/Access Token                      | `tid`・`iss`内のtenant IDを固定値`ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb`に変更                          |
| `EXPIRED_TOKEN`                                      | ID/Access Token                      | `exp`を`expiredAgoSeconds`秒前、`iat`・`nbf`をその1時間前に設定（前後関係を維持）                      |
| `FUTURE_NBF`                                         | ID/Access Token                      | `nbf`を`nbfAheadSeconds`秒先に設定（上限は`exp`の1秒前）                                               |
| `MISSING_CLAIM`                                      | ID/Access Token                      | `claim`で指定したclaimを削除                                                                           |
| `INVALID_SIGNATURE`                                  | ID/Access Token                      | 非公開Key Bで署名し、公開Key Aの`kid`を設定                                                            |
| `UNKNOWN_KID`                                        | ID/Access Token                      | Key Aで署名し、JWKSにない`kid`を設定                                                                   |
| `ALG_NONE`                                           | ID/Access Token                      | `alg: none`、`kid`なし、署名部が空の未署名JWT                                                          |
| `SIGNING_KEY_ROLLOVER`                               | Token/JWKS                           | 新鍵で署名し、旧鍵・新鍵をJWKSへ公開                                                                   |
| `NONCE_MISMATCH`                                     | ID Token                             | `nonce`を固定値`mock-mismatched-nonce`に変更（Access Tokenは変更なし）                                 |
| `NONCE_MISSING`                                      | ID Token                             | `nonce`を削除（Access Tokenは変更なし）                                                                |
| `TOKEN_NO_ID_TOKEN`                                  | `POST` Token                         | HTTP 200応答から`id_token`を削除                                                                       |
| `TOKEN_400`                                          | `POST` Token                         | 設定したOAuth errorをHTTP 400で返す                                                                    |
| `TOKEN_429`, `JWKS_429`, `DISCOVERY_429`             | `POST` Token / `GET` JWKS・Discovery | HTTP 429、任意の`Retry-After`、JSONの`error: temporarily_unavailable`。`error_description`にシナリオ名 |
| `TOKEN_500`, `JWKS_500`, `DISCOVERY_500`             | `POST` Token / `GET` JWKS・Discovery | HTTP 500、任意の`Retry-After`、JSONの`error: server_error`。`error_description`にシナリオ名            |
| `TOKEN_TIMEOUT`, `JWKS_TIMEOUT`, `DISCOVERY_TIMEOUT` | `POST` Token / `GET` JWKS・Discovery | 指定時間遅延後に通常処理を続行                                                                         |
| `JWKS_INVALID`                                       | `GET` JWKS                           | HTTP 200。`keys`は1件で、RSA必須の`n`・`e`を欠くkey（空配列にはしない）                                |

### Parameters

| Parameter                   | 対象シナリオ     | 値                                                                                                                              |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `retryAfterSeconds`         | `*_429`, `*_500` | 1以上のsafe integer。任意。指定時だけ`Retry-After`を返す                                                                        |
| `delayMs`                   | `*_TIMEOUT`      | 1〜300,000ms。既定30,000ms                                                                                                      |
| `expiredAgoSeconds`         | `EXPIRED_TOKEN`  | 1〜31,536,000（365日）の整数。既定600秒                                                                                         |
| `nbfAheadSeconds`           | `FUTURE_NBF`     | 1〜3,599の整数（ID/Access TokenのTTL 3,600秒未満）。既定600秒                                                                   |
| `claim`                     | `MISSING_CLAIM`  | `sub`・`oid`・`tid`・`iss`・`aud`・`exp`・`iat`。既定`sub`                                                                      |
| `error`, `errorDescription` | `TOKEN_400`      | `error`は既定`invalid_grant`。`error_description`は`errorDescription`指定時だけ返す。`AUTH_400`への指定は`400 invalid_scenario` |

時刻改変の既定600秒は、Spring Security（60秒）・.NET（300秒）の既定clock skew許容を超える値です。

### OAuth redirect errorとConnectivity ProbeのHTTP fault

OAuth redirect errorは認証要求のcallback応答、Connectivity Probe faultは認証前の到達性確認に作用します。`AUTH_SERVER_ERROR`と`AUTH_500`、`AUTH_TEMPORARILY_UNAVAILABLE`と`AUTH_429`は用途が異なります。

- **OAuth redirect error**: [一覧](#シナリオ一覧)の5種類が対象です。Providerの要求検証後にOAuth errorと元の`state`を登録済みredirect URIへ返します。`response_mode=query`・`form_post`はProviderの標準処理です。`error_description`は固定文（例: "Login required by mock scenario"）です。
- **Connectivity Probe fault**（`AUTH_400`・`AUTH_429`・`AUTH_500`・`AUTH_TIMEOUT`）: `HEAD .../common/oauth2/v2.0/authorize`だけに作用します。正常時はEntraと同じ200、障害時は一覧のstatus・遅延を返します。本文はなく、`content-type`は正常・障害とも`text/html; charset=utf-8`です。`AUTH_400`は`error`・`errorDescription`を受け付けません。通常の`GET {tenant}/oauth2/v2.0/authorize`にはCONTINUOUSでも影響せず、LIMITED回数も消費しません。

### 認証応答の不正

`AUTH_STATE_*`・`AUTH_CODE_*`・`NONCE_*`・`ALG_NONE`・`WRONG_TENANT`・`MISSING_CLAIM`・`TOKEN_NO_ID_TOKEN`で、不正な認証応答をRPが拒否できるかを試験します。ブラウザE2Eで書き換えにくいredirectやトークンをMock側で改変します。

- **認可応答の改変**: `AUTH_STATE_*`・`AUTH_CODE_*`は成功応答の送信直前（`authorization.success`）に`query`・`form_post`のパラメーターを変更します。LIMITEDは成功応答を返す要求だけで消費し、interactionへのredirect・OAuth errorでは消費しません。先に成功した別フローが消費しうる点は[共有範囲](#シナリオの適用ルール)を参照してください。
- **codeの扱い**: `AUTH_CODE_INVALID`・`AUTH_CODE_MISSING`でも実際のcodeは未使用のままTTL（600秒）で失効します。`AUTH_CODE_WITH_ERROR`は`query`で303 redirect、`form_post`では`error`を含むため自動送信フォームをHTTP 400で返します。
- **Token改変**: refresh_token grantを含むすべての成功したToken応答が対象です。LIMITEDではsilent refreshが先に消費しないよう注意してください。`NONCE_*`は`nonce`を持つID Token（認可要求で`nonce`指定）、`TOKEN_NO_ID_TOKEN`は`id_token`を持つ応答だけに作用し、それ以外では改変・回数消費しません。
- **テナントの不正**: `WRONG_TENANT`は`iss`・`tid`の整合を保って別テナントに変更します。`WRONG_ISSUER`は`iss`だけを無関係な値にします。

### 回復試験

Mock自身は回復のための待機・再試行を行いません。Entraの[クライアントの回復性](https://learn.microsoft.com/en-us/entra/architecture/resilience-client-app)と[MSALのthrottling例](https://learn.microsoft.com/en-us/entra/msal/dotnet/advanced/client-and-server-throttling)に沿って、特定のAADSTS番号に依存せず次を試験します。

- 429・5xxでは`Retry-After`の終了まで待ち、指定がなければ指数バックオフする。Timeoutでも即時再試行を避ける。
- `prompt=none`で`login_required`・`interaction_required`を受けたら、silent requestを繰り返さず対話型認証へ切り替える。[Authorization error](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-codes-for-authorization-endpoint-errors)の返却先は検証済みredirect URIだけです。

### Provider標準機能との責務分離

正常なAuthorization Code Flow・PKCEと、次の入力検証は`oidc-provider`の標準機能で試験します。

| 入力                                         | エラー           |
| -------------------------------------------- | ---------------- |
| 不正・期限切れ・再利用済みAuthorization Code | `invalid_grant`  |
| `code_verifier`不一致                        | `invalid_grant`  |
| Confidential client secret不正               | `invalid_client` |
| Token交換時の`redirect_uri`不一致            | `invalid_grant`  |

専用シナリオ`AUTH_CODE_EXPIRED`・`AUTH_CODE_REUSED`・`PKCE_MISMATCH`・`INVALID_CLIENT`・`REDIRECT_URI_MISMATCH`はありません。IdP側からPKCE失敗や任意のToken errorを返すには`TOKEN_400`を使います（本文のない`AUTH_400`は使用不可）。AADSTS50196のloop検出を再現する例:

```json
{
  "scenario": "TOKEN_400",
  "mode": "LIMITED",
  "failureCount": 1,
  "parameters": {
    "error": "invalid_grant",
    "errorDescription": "AADSTS50196: The server terminated an operation because it encountered a loop while processing a request"
  }
}
```

### 署名鍵のシナリオ

- `JWKS_INVALID`・`UNKNOWN_KID`・`SIGNING_KEY_ROLLOVER`で、[Entraの推奨動作](https://learn.microsoft.com/en-us/entra/identity-platform/signing-key-rollover#best-practices-for-keys-metadata-caching-and-validation)（複数鍵の保持、未知の`kid`でmetadata再取得、不正metadata受信時のlast-known-good継続）を試験します。
- rollover鍵はシナリオ完了・NORMALへの変更・別シナリオへの切り替え後もJWKSに残り、Reset時だけ初期鍵へ戻ります。

### シナリオの追加

`src/scenario/types.ts`に名前・入力型を、`src/scenario/registry.ts`に対象endpoint、effect、parameter/UI metadataを追加します。実装は責務ごとに、HTTP Faultは`src/faults/http-fault.ts`、認可応答の改変は`src/faults/authorization-fault.ts`、claim生成は`src/oidc/provider.ts`、意図的なJWT異常は`src/faults/token-generator.ts`へ行い、Store・Integration Testを追加してください。

## アクセスログ

受け付けた要求とその時点のシナリオを記録します。認証を試した後、Admin UIの「アクセスログ」を再読み込みすると、要求の到達と障害の適用を確認できます。受付の新しい順に表示し、適用した行は「適用」と赤い背景で示します。

- **対象**: `/__mock`配下（Admin UI/API）・`/health`・ブラウザが自動要求する`/favicon.ico`を除く全要求。Host不一致の`400 invalid_request_origin`も記録します。
- **機密情報の除外**: URLはpathnameだけを記録し、query・本文・ヘッダーは残しません（`code`・`client_secret`・`code_verifier`などの記録を防止）。
- **保持**: メモリ上に最新200件を保持し、超過分は古い順に破棄します。[永続化対象外](#鍵と状態)で、再起動すると消えます。
- **操作**: 自動更新はありません。「アクセスログを再読み込み」で取得、「アクセスログをクリア」で全件削除します。シナリオの「初期状態に戻す」（`POST /__mock/api/reset`）では消えません。カードの開閉は[Admin UIの共通動作](#共通の動作)に従います。

```bash
CURL_CA=.data/tls/ca.crt
MOCK_ORIGIN=https://mock-idp.test:9000

curl --cacert "$CURL_CA" "$MOCK_ORIGIN/__mock/api/access-log"
curl --cacert "$CURL_CA" -X DELETE "$MOCK_ORIGIN/__mock/api/access-log"
```

`GET`は受付の新しい順の配列、`DELETE`は204を返します。

| 項目         | 内容                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | プロセス内で受付順に単調増加（応答完了順ではない）。クリアでもリセットしない                                                                                           |
| `receivedAt` | 受付時刻（ISO 8601）                                                                                                                                                   |
| `method`     | HTTP method                                                                                                                                                            |
| `path`       | pathname（queryを含まない）                                                                                                                                            |
| `endpoint`   | `discovery`, `authorization`, `interaction`（サインイン画面）, `token`, `jwks`, `logout`, `connectivity-probe`（`HEAD .../common/oauth2/v2.0/authorize`のみ）, `other` |
| `statusCode` | HTTP status。応答前に切断された場合は`null`（Timeout時などの確認用）                                                                                                   |
| `durationMs` | 受付から応答完了・切断までのミリ秒                                                                                                                                     |
| `scenario`   | 受付時のシナリオ名（`NORMAL`を含む）。対象外endpoint・Host不一致などで作用しない場合も記録                                                                             |
| `fault`      | 実際に消費したFault。`scenario`, `endpoint`, `mode`, `parameters`, `remainingBefore`, `remainingAfter`を含む。未適用なら`null`                                         |

typoや未対応の`common`・`organizations` authorityなどは`other`に分類します。`scenario`と`fault`で、有効でも作用しなかった要求を区別できます。

- `TOKEN_500`有効時、JWKS取得は`scenario: "TOKEN_500"`・`fault: null`、Tokenへの`POST`は`fault.scenario: "TOKEN_500"`です。LIMITEDの消費回数は`remainingBefore`・`remainingAfter`で追えます。
- OAuth redirect errorは最初の`GET .../authorize`にFaultが付き、続くサインイン画面・`.../authorize/{uid}`は`fault: null`です。
- `AUTH_STATE_*`・`AUTH_CODE_*`は成功応答の行にFaultが付きます。通常はサインイン後の`.../authorize/{uid}`、セッションがあれば最初の`.../authorize`です。

## 鍵と状態

初回起動で`.data/keys`に通常鍵・rollover鍵・異常署名鍵を生成し、秘密鍵は0600で保存します。鍵ディレクトリを削除すると再生成します。JWKSは既定で通常鍵だけ、`SIGNING_KEY_ROLLOVER`適用後は通常鍵とrollover鍵の公開部分を掲載します（[公開状態のリセット](#署名鍵のシナリオ)）。

| 保存先                | 内容                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `.data/`（Git対象外） | 署名鍵（`keys`）、TLS証明書・秘密鍵（`tls`・`tls-private`）、クライアント・ユーザー設定（`resources.json`・`clients.json`・`users.json`、0600） |
| 単一プロセスのメモリ  | OIDC artifact（認可コード・Session・Grant・Access Token・Refresh Tokenの内部状態）、シナリオストア・履歴、アクセスログ。再起動で消失            |

認可コードの対応情報とリフレッシュトークンは各最大1000件で、期限切れ・容量超過・再起動により破棄されます。

## 開発コマンド

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build:check
```

整形の適用は`npm run format`です。
