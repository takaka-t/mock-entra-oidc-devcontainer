# Mock Entra ID / OIDC Provider

Microsoft Entra IDをIdPとするアプリケーションのローカル開発・障害試験用OIDC Providerです。正常処理は`oidc-provider`、HTTP障害・遅延・不正JWT・claim変更の注入は独立したシナリオ層が担います。Entra ID完全互換ではなく、Microsoft Graph APIも提供しません。

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
- **Logout**: 確認ページを経由します。送信先はtenant直下の`/oauth2/v2.0/logout/confirm`、完了ページは`/oauth2/v2.0/logout/success`で、クライアントから直接呼びません。`post_logout_redirect_uri`は対象クライアントのPost Logout Redirect URIに登録済みの値だけを受け付けます。
- **Connectivity Probe**: Entraへのサインイン前の到達性確認（`HEAD https://login.microsoftonline.com/common/oauth2/v2.0/authorize`）に対応します。Mockでは表のorigin直下のURLを使用し、`HEAD`のみ受け付けます（CORS preflightの`OPTIONS`は204、他のmethodは404）。Entraのmulti-tenant aliasである`common`を使った認証フローは未対応です。
- **PAR**: EntraのDiscoveryと同じく`pushed_authorization_request_endpoint`を公開せず、機能を無効化しています。

### MSAL利用時の注意

`mock-idp.test:9000`はMicrosoftの既知クラウドインスタンスではないため、HTTPSでもMSALのinstance discovery（既知authority検証）でブロックされます。

- MSAL.js（Browser / Node）は`knownAuthorities`へ`mock-idp.test:9000`を追加します。MSAL Node v5の設定先は`system`です。[custom OIDC authorityの説明](https://learn.microsoft.com/en-us/entra/msal/javascript/node/initialize-public-client-application)と[使用versionの設定リファレンス](https://learn.microsoft.com/en-us/entra/msal/javascript/node/configuration)を確認してください。
- endpointのpathはEntra準拠です。`protocolMode`の既定値（AAD）で動作するかを使用するSDK/バージョンで確認してください。`OIDC`への変更は不要な場合があります。
- MSAL.NETなど他の実装でも、対象versionとflowが提供するcustom OIDC authority APIを使用します。
- authority metadata、Discovery、issuer、署名、audience、証明書の検証は無効化しないでください。

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

### 共通の動作

- **初期化と保存**: 初回起動で[初期クライアント](#oidcクライアント)・[初期ユーザー](#テストユーザー)を作成します。Admin UIの「OIDC クライアント一覧」「テストユーザー一覧」またはAdmin APIで追加・編集・削除でき、再起動なしで反映します（ユーザーはサインイン画面・トークンに反映）。保存先とpermissionは[鍵と状態](#鍵と状態)を参照してください。
- **Admin UI**: 登録・編集ダイアログは保存成功で閉じて通知し、失敗時は入力を保持してエラーを表示します。一覧更新だけの失敗は「一覧を再読み込み」で再試行できます。未保存で閉じる場合は確認します。シナリオ以外のカードは見出しで折りたため、初回は閉じた状態です。開閉状態はブラウザに保存します。
- **IDと検証**: Client ID・`sub`は前後の空白を除いて1〜100文字の印字可能ASCII（`.`・`..`は不可）。作成後の変更は削除・再作成が必要です。Admin APIの必須項目不足は400です。設定ファイルにも同じ検証を適用し、不適合なIDや改行入りの項目は自動変換せず起動に失敗します。該当ファイルを修正してください。
- **reset**: `POST /__mock/api/clients/reset`はクライアントだけ、`POST /__mock/api/users/reset`はユーザーだけを初期化し、シナリオや他方へ影響しません。
- **発行済み状態**: 設定の削除・resetでは、発行済みJWTを含むartifactは完全には失効しません。Provider内部状態はインスタンス単位のメモリに保持し、Providerを含むappの再構築・プロセス再起動で破棄します（[保持対象](#鍵と状態)）。
- **ユーザー削除・reset後**: 消えたユーザーのセッションは次の認可要求でユーザーを再選択し、`prompt=none`なら`login_required`を返します。そのユーザーの認可コード・Refresh Token交換は`invalid_grant`です。同じ`sub`を再作成すると残存セッション・Grantを再利用できる場合があります。

### OIDCクライアント

初期クライアントは次のとおりです。

| 項目                           | 既定値                             |
| ------------------------------ | ---------------------------------- |
| Public client                  | `mock-public-client`（secretなし） |
| Confidential client            | `mock-confidential-client`         |
| Confidential secret            | `mock-client-secret-change-me`     |
| Redirect URI                   | `http://localhost:3000/callback`   |
| Access token audience/resource | `urn:mock-api`                     |

通常のOIDCフローでは全クライアントでAuthorization Code FlowとS256 PKCEが必須です。APIだけの検証には[アクセストークンの直接発行](#開発用アクセストークンの直接発行)も使えます。Discovery・issuer・audience・期限・署名・JWKS・redirect URI・client IDの検証は無効化しないでください。

| 設定項目               | 内容                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| クライアント           | Client ID、Public/Confidential種別、secret                                                      |
| Token Endpoint認証方式 | Public: `none`。Confidential: `client_secret_basic`または`client_secret_post`                   |
| Redirect先             | Redirect URI、Post Logout Redirect URI                                                          |
| Access Token           | Audience、`accessTokenScope`（`scp`の委任scope名）、[バージョン](#アクセストークンのバージョン) |
| email                  | `emailOptionalClaim`（[emailを常に含める設定](#トークンのclaim)）                               |

`accessTokenScope`・`emailOptionalClaim`はAdmin APIの作成（`POST`）・更新（`PUT`）で必須です。Admin UIの新規作成時はscopeに`access_as_user`を入力済みです。

- **標準OIDC scope**: 全クライアントで`openid`, `profile`, `email`, `offline_access`を利用できます。Entra IDのアプリ登録項目ではなく、認可リクエストの`scope`で要求します。`offline_access`でRefresh Tokenを発行し、`email`は[claimの条件](#トークンのclaim)に従います。
- **制限**: `scp`はクライアントに設定した単一の委任scope名を返す簡易モデルです。Microsoft Graph・独自Web APIの複数permission、admin consent、Expose an APIの管理UIは対象外です。

```bash
CURL_CA=.data/tls/ca.crt

curl --cacert "$CURL_CA" https://mock-idp.test:9000/__mock/api/clients

curl --cacert "$CURL_CA" -X POST https://mock-idp.test:9000/__mock/api/clients \
  -H 'content-type: application/json' \
  -d '{
    "clientId":"my-app",
    "clientType":"PUBLIC",
    "tokenEndpointAuthMethod":"none",
    "redirectUris":["http://localhost:8080/callback"],
    "postLogoutRedirectUris":[],
    "accessTokenAudience":"urn:my-api",
    "accessTokenScope":"access_as_user",
    "accessTokenVersion":"2.0",
    "emailOptionalClaim":false
  }'

curl --cacert "$CURL_CA" -X POST https://mock-idp.test:9000/__mock/api/clients/reset \
  -H 'content-type: application/json' \
  -d '{}'
```

### アクセストークンのバージョン

Admin UIのクライアント編集、またはAdmin APIの`accessTokenVersion`で`"1.0"`・`"2.0"`を選びます。作成時・`clients.json`での省略は`"2.0"`、更新時の省略は現在値を維持します。変更は次の取得・更新から反映し、発行済みトークンは変わりません。

SPAのauthority・Authorization/Token endpoint・ID Tokenはv2.0です。Access TokenはAuthorization Code・Refresh Tokenのどちらでも選択したバージョンになります。これはEntra IDの[認証エンドポイントから独立したバージョン指定](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#token-ownership)に相当します。

バックエンドAPIの検証設定は次のとおりです。`aud`は両バージョンとも`accessTokenAudience`です。

| バックエンドの検証設定 | v1.0                                                                                               | v2.0                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| issuer（`iss`）        | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/`（末尾`/`あり）                  | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0`                                  |
| メタデータURL          | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/.well-known/openid-configuration` | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/.well-known/openid-configuration` |
| JWKS URL               | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/discovery/keys`                   | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/discovery/v2.0/keys`                   |

v1.0のメタデータはAPIのAccess Token検証専用で、`issuer`・`jwks_uri`・`id_token_signing_alg_values_supported`を返します。メタデータ・JWKSにはorigin検証、CORS、Discovery/JWKS障害、署名鍵ローテーション、アクセスログを適用します。v1.0のAuthorization/Token endpointや`resource`による認証要求は未対応です。SPAのサインイン用Discoveryにはv2.0を使ってください。

Entra IDはAPI側の`requestedAccessTokenVersion`で指定しますが、MockはAPI登録を持たず、Audience・scopeと同じくクライアントに保持します。同じAPIを使うクライアントには同じバージョンを設定してください。v1.0 issuerは実環境の`sts.windows.net`を使わず、Mockのoriginです。

### テストユーザー

初期ユーザーは次のとおりです。

| sub                 | 表示名            | username                   | oid                                    | groups                                    |
| ------------------- | ----------------- | -------------------------- | -------------------------------------- | ----------------------------------------- |
| `user-admin`        | Admin User        | `admin@example.com`        | `11111111-1111-1111-1111-111111111111` | `app-admin-group-id`, `app-user-group-id` |
| `user-normal`       | Normal User       | `user@example.com`         | `22222222-2222-2222-2222-222222222222` | `app-user-group-id`                       |
| `user-unauthorized` | Unauthorized User | `unauthorized@example.com` | `33333333-3333-3333-3333-333333333333` | なし                                      |

| 項目                 | 内容                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sub`                | サインイン画面の選択値・トークンの`sub`。新規作成時のAdmin UIは編集可能なランダムUUIDを入力済み。空欄保存・Admin APIでの省略時はサーバーがUUIDを一度生成して保存 |
| `oid`                | GUID形式で、小文字に正規化して保存。新規作成時のAdmin UIは編集可能なランダムUUIDを入力済み                                                                       |
| `name`               | 表示名                                                                                                                                                           |
| `preferred_username` | UPN相当の値                                                                                                                                                      |
| `mail`               | メール形式。`email` claimとして返される                                                                                                                          |
| `groups`             | Admin UIは1行1件、Admin APIは文字列配列。重複を除去し、空も指定可能                                                                                              |

- `name`・`preferred_username`・各グループ名は前後の空白を除去し、改行（CR/LF）を拒否します。Unicode・内部の空白は保持します。
- `oid`・`preferred_username`はユーザー間で重複不可（後者は大文字小文字を区別しない）。`tid`は固定Tenant IDで設定不可です。`users.json`に含めると起動時に検証エラーになります。
- Admin APIの作成（`POST /__mock/api/users`）は`sub`以外の全項目、更新（`PUT /__mock/api/users/:sub`）は全項目が必須です。エラーは`invalid_user`（400）、`user_conflict`（409）、`user_not_found`（404）です。

```bash
CURL_CA=.data/tls/ca.crt

curl --cacert "$CURL_CA" https://mock-idp.test:9000/__mock/api/users

curl --cacert "$CURL_CA" -X POST https://mock-idp.test:9000/__mock/api/users \
  -H 'content-type: application/json' \
  -d '{
    "sub":"user-auditor",
    "oid":"44444444-4444-4444-4444-444444444444",
    "name":"Auditor User",
    "preferred_username":"auditor@example.com",
    "mail":"auditor@example.com",
    "groups":["app-auditor-group-id"]
  }'

curl --cacert "$CURL_CA" -X PUT https://mock-idp.test:9000/__mock/api/users/user-auditor \
  -H 'content-type: application/json' \
  -d '{
    "oid":"44444444-4444-4444-4444-444444444444",
    "name":"Auditor User",
    "preferred_username":"auditor@example.com",
    "mail":"auditor@example.com",
    "groups":["app-auditor-group-id","app-user-group-id"]
  }'

curl --cacert "$CURL_CA" -X DELETE https://mock-idp.test:9000/__mock/api/users/user-auditor

curl --cacert "$CURL_CA" -X POST https://mock-idp.test:9000/__mock/api/users/reset \
  -H 'content-type: application/json' \
  -d '{}'
```

### トークンのclaim

通常のOIDCフローの共通claimは`sub`, `oid`, `tid`, `name`, `groups`, `iss`, `aud`, `iat`, `exp`, `nbf`, `ver`, `sid`です。[Entra IDのバージョン差](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)に対応する違いは次のとおりです（`—`は含まない項目）。

| 項目                 | ID Token             | v1.0 Access Token | v2.0 Access Token    |
| -------------------- | -------------------- | ----------------- | -------------------- |
| `ver`                | `"2.0"`              | `"1.0"`           | `"2.0"`              |
| ユーザー名           | `preferred_username` | `unique_name`     | `preferred_username` |
| client_id            | —                    | `appid`           | `azp`                |
| クライアント認証方式 | —                    | `appidacr`        | `azpacr`             |
| 委任scope名          | —                    | `scp`             | `scp`                |
| JWTヘッダーの`typ`   | 未設定（既知の制限） | `"JWT"`           | `"JWT"`              |

- `unique_name`はユーザーの`preferred_username`の値です。`appidacr`・`azpacr`はPublicで`0`、client secretで認証するConfidentialで`1`です。v1.0 Access Tokenに`azp`・`azpacr`・`preferred_username`は含めません。
- `scp`はクライアント設定の委任scope名です。JWTに`scope` claimは含めず、`scope`はToken応答とOIDCのスコープ処理で使用します。
- `email`はユーザーの`mail`の値です。`email` scopeの要求時、または`emailOptionalClaim`有効時に含めます（Entra IDの[optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims)相当）。表示・連絡先に使い、ユーザー識別には`oid`と`tid`の組または`sub`を使ってください。
- `mail`はMicrosoft Graphのプロパティ名であり、Entra IDのトークンclaimには含まれません。Access Tokenの`typ:"JWT"`はEntra IDと同じですが、ID Tokenの`typ`はEntra IDと異なり未設定です。

## 開発用アクセストークンの直接発行

サインイン操作なしで、バックエンドAPI検証用のAccess Tokenを発行できます。

1. Admin UIの「アクセストークン発行」で登録済みクライアント・ユーザーを選び、「発行」を押す。
2. 「アクセストークンをコピー」で取得する。コピー失敗時は表示されたトークンを手動でコピーする。

候補の取得失敗時や別画面での設定変更後は「候補を再読み込み」を使ってください。

### Admin APIで発行してAPIを呼び出す

`POST /__mock/api/tokens`にJSONで`clientId`・`userSub`を指定します（両方必須）。PUBLIC／CONFIDENTIALともsecret不要です。ローカル試験専用で、Host・Origin・JSON本文の検証とキャッシュ抑止を適用します。

以下は`jq`を使用します。呼び出し先URLを検証対象のバックエンドAPIに置き換えてください。

```bash
CURL_CA=.data/tls/ca.crt
MOCK_ORIGIN=https://mock-idp.test:9000

TOKEN_RESPONSE=$(curl --fail-with-body --silent --show-error --cacert "$CURL_CA" \
  "$MOCK_ORIGIN/__mock/api/tokens" \
  -H 'content-type: application/json' \
  -d '{"clientId":"mock-public-client","userSub":"user-admin"}')
ACCESS_TOKEN=$(printf '%s' "$TOKEN_RESPONSE" | jq -er '.access_token')

curl -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:8080/api/example
```

成功時は200で次の形式を返します。

```json
{
  "access_token": "<署名済みJWT>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "access_as_user",
  "fault": null
}
```

入力不正は400（`invalid_token_request`）、クライアント未登録は404（`client_not_found`）、ユーザー未登録は404（`user_not_found`）で、日本語の`message`を返します。

- `aud`・`scp`・バージョン・issuerは発行時のクライアント設定に従います。署名鍵は通常のOIDCフローと共通で、同じDiscovery・JWKSで検証できます。
- ユーザー情報・groupsを含め、emailは`emailOptionalClaim: true`のときだけ含めます。ブラウザセッションと`sid`、ID Token、Refresh Token、アプリ権限のトークンは生成しません。
- 有効期間は通常3,600秒です。`expires_in`は通常のToken endpointと同じく障害適用前の値で、期限切れ障害などではJWTの実際の期限と異なります。
- JWTはファイル・ブラウザストレージに保存せず、管理APIの要求は[アクセスログ](#アクセスログ)の対象外です。

### 適用する障害シナリオ

有効なシナリオが次のいずれかなら、設定済みパラメーターで自動適用します。

- `NO_GROUPS`、`WRONG_AUDIENCE`、`WRONG_ISSUER`、`WRONG_TENANT`、`MISSING_CLAIM`
- `EXPIRED_TOKEN`、`FUTURE_NBF`、`INVALID_SIGNATURE`、`UNKNOWN_KID`、`SIGNING_KEY_ROLLOVER`、`ALG_NONE`

適用時は`fault`にシナリオ名・モード・パラメーター・残り回数などの`FaultDecision`を返します。Admin UIにも障害を表示し、発行後にシナリオ状態を更新します。

LIMITEDは[共通ルール](#シナリオの適用ルール)に従い、1要求で最大1回消費します。入力不正・対象未登録では消費しません。ID Token専用（`NONCE_MISMATCH`・`NONCE_MISSING`・`TOKEN_NO_ID_TOKEN`）、HTTP・認可・Discovery・JWKS障害は直接発行に適用せず、回数も消費しません。Discovery・JWKS障害は、それぞれのURL取得時に作用します。

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

| 保存先                | 内容                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `.data/`（Git対象外） | 署名鍵（`keys`）、TLS証明書・秘密鍵（`tls`・`tls-private`）、クライアント・ユーザー設定（`clients.json`・`users.json`、0600）        |
| 単一プロセスのメモリ  | OIDC artifact（認可コード・Session・Grant・Access Token・Refresh Tokenの内部状態）、シナリオストア・履歴、アクセスログ。再起動で消失 |

## 開発コマンド

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build:check
```

整形の適用は`npm run format`です。
