# Mock Entra ID / OIDC Provider

Microsoft Entra IDをIdPとするアプリケーションのローカル開発・障害試験用OIDC Providerです。OIDCの正常処理は`oidc-provider`に委譲し、HTTP障害、遅延、不正JWT、claim変更を独立したシナリオ層で注入します。Entra ID完全互換ではなく、Microsoft Graph APIも提供しません。

> ローカル試験専用です。Admin APIは認証されず、ユーザー認証も選択式です。インターネットへ公開しないでください。

## 起動

既存のdevcontainerとNode.js 24を前提とします。Mock IdPのtenant IDとissuerは次の値に固定しています。

```text
Tenant ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
Issuer: https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0
```

service名は既存の`app`のままです。OIDCで公開するhostnameはservice名から分離し、Docker network aliasの`mock-idp.test`を使用します。

### 事前セットアップ

Composeは外部Docker network `mock-idp-network`を使用します。初回起動前にnetworkの存在を確認し、存在しなければ作成してください。

```bash
docker network inspect mock-idp-network
docker network create mock-idp-network
```

`inspect`が成功した場合、`create`は不要です。

ホストOS上のブラウザから同じURLへアクセスするため、hostsファイルへ次の行を追加してください。管理者権限が必要です。

```text
127.0.0.1 mock-idp.test
```

- macOS / Linux: `/etc/hosts`
- Windows: `C:\Windows\System32\drivers\etc\hosts`

hostsファイルはアプリケーションから自動変更しません。

## devcontainer起動後のセットアップ

devcontainerを初めて起動したとき、または`node_modules`・`tls-private`用named volumeを作り直したときは、依存関係を導入してください。

```bash
npm ci
npm run setup:tls
```

`setup:tls`はローカルCAと`mock-idp.test`用サーバー証明書を生成します。公開証明書と秘密鍵は別々のディレクトリへ書き込まれ、生成されるファイルは次の4つです。

| ファイル                           | 用途                         |
| ---------------------------------- | ---------------------------- |
| `.data/tls/ca.crt`                 | 接続元へ登録する公開CA証明書 |
| `.data/tls/server.crt`             | Mock IdPが提示するサーバー証明書 |
| `.data/tls-private/ca.key.pem`     | CA秘密鍵。外部へ配布・コピーしない |
| `.data/tls-private/server.key.pem` | サーバー秘密鍵。外部へ配布・コピーしない |

`.data/tls`（公開証明書）はリポジトリのbind mountにそのまま含まれ、ホストからも参照できます。一方`.data/tls-private`（秘密鍵）は`node_modules`と同様に専用のnamed volume（`tls-private`）としてマウントされます。これはWindows Docker DesktopのBind Mountが常にPOSIXのpermissionを正しく保持できるとは限らず、秘密鍵の0700/0600チェックが失敗しうるためです。named volumeであれば実体はLinux VM側の通常のファイルシステムになるため、この問題を回避できます。`.data/tls-private`はホストのファイルシステムからは直接見えません。公開証明書（`ca.crt`/`server.crt`）は機密情報ではないため、bind mount側での正確なpermission一致は要求しません。

`.data/tls-private`は0700、秘密鍵は0600で作成され、これらは常に検証されます。`.data/`はGit対象外ですが、`ca.key.pem`と`server.key.pem`を共有ストレージ、接続元コンテナ、ホストOSのtrust storeへコピーしないでください。接続元に渡すのは`ca.crt`だけです。permission検査を回避したり秘密鍵を読みやすくしたりしないでください。

出力先はそれぞれ独立したオプションで変更できます（`node scripts/setup-tls.mjs --output-dir <公開証明書用directory> --private-dir <秘密鍵用directory>`）。片方だけ指定した場合、もう片方はデフォルト（`.data/tls`または`.data/tls-private`）のままです。

依存関係とTLSファイルの準備後、devcontainer内で次を実行してください。Composeでは固定のコンテナport 9000をホストの`127.0.0.1:9000`に公開します。起動に必要な`ca.crt`、`server.crt`、`server.key.pem`がない、または内容が不正な場合は起動に失敗します。`ca.key.pem`はサーバー起動には読み込まず、証明書更新時だけ使用します。

```bash
npm run dev
```

主なURLは次のとおりです。

- Admin UI: `https://mock-idp.test:9000/__mock`
- Discovery: `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/.well-known/openid-configuration`
- Authorization Endpoint: `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/authorize`
- Token Endpoint: `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/token`
- JWKS: `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/jwks`
- Health: `https://mock-idp.test:9000/health`

OIDCクライアントにはauthority/issuerとして`https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0`を設定してください。Discoveryが返す各endpointとJWTの正常系`iss`もこの値を基準に生成され、JWTの`tid`には固定tenant IDが入ります。OIDC endpointへのrequestのschemeとHostがissuerのoriginに一致しない場合は`400 invalid_request_origin`になります。

HTTPS化はMSALによるcustom authority受け入れの十分条件とは限りません。MSAL.js（Browser / Node）では、使用するversionの設定方法に従って`knownAuthorities`へ`mock-idp.test:9000`を追加し、`protocolMode`を`OIDC`にしてください。MSAL Node v5では`protocolMode`の設定先が`auth`から`system`へ移動しているため、[custom OIDC authorityの説明](https://learn.microsoft.com/en-us/entra/msal/javascript/node/initialize-public-client-application)と[使用versionの設定リファレンス](https://learn.microsoft.com/en-us/entra/msal/javascript/node/configuration)を確認してください。MSAL.NETなど他の実装でも、対象versionとflowが提供するcustom OIDC authority APIを使用します。authority metadata、Discovery、issuer、署名、audience、証明書の検証は無効化しないでください。

### 接続元でローカルCAを信頼する

Mock IdPコンテナ自身のOS trust storeへCAを登録する必要はありません。Mock IdPは起動時の証明書検証に`.data/tls/ca.crt`と`.data/tls-private/server.key.pem`等を読み込みます。CAの信頼設定が必要なのは、HTTPSクライアントが動作する接続元です。

- ホスト上のブラウザやアプリケーションでは、ホストOS、ブラウザ、runtimeの該当するtrust storeへ設定します。
- 別Composeのアプリケーションでは、接続元コンテナのOS、runtime、SDKへ設定します。

登録・解除方法はOS、ブラウザ、runtime、SDK、base image、組織のセキュリティポリシーによって異なるため、それぞれの公式ドキュメントを参照してください。登録または配布するのは公開CAの`.data/tls/ca.crt`だけです。`ca.key.pem`と`server.key.pem`は接続元へ渡さないでください。このCAは開発端末とテスト用コンテナだけで信頼し、不要になったら解除してください。

devcontainer内では次のように疎通を確認できます。`-k`または`--insecure`は使用しません。

```bash
curl --cacert .data/tls/ca.crt https://mock-idp.test:9000/health
```

#### 証明書の更新とCAローテーション

`npm run setup:tls`の通常再実行は、`.data/tls`と`.data/tls-private`それぞれに有効な2ファイルが揃い、CAの残存期間が397日より長く、サーバー証明書の残存期間が30日以上なら何も変更しません。30日未満または期限切れでは、まだ有効な同じCAを使ってサーバー証明書だけを更新するため、CAの再登録は不要です。更新された証明書を反映するにはMock IdPを再起動してください。CAの残存期間が397日以下の場合は、有効期限内のローテーションを案内して失敗します。期限切れCA、不完全または不正なファイル一式、`.data/tls`と`.data/tls-private`の状態が食い違っている場合も自動上書きせず、コマンドが失敗します。

CAを期限切れまで放置した場合、`--rotate-ca`も既存の不正なdirectoryを上書きしません。Mock IdPを停止し、`.data/tls`と`.data/tls-private`をそれぞれ明示的に別名へ退避した後、`npm run setup:tls -- --rotate-ca`で新規CAを生成してください。その後、旧CAの登録解除と新CAの登録をすべての接続元で行います。

セットアップが異常終了すると、同時実行防止用の`.data/tls.setup.lock`や、`.data/tls.backup-*`、`.data/.tls-setup-*`、`.data/tls-private.backup-*`、`.data/.tls-private-setup-*`が残る場合があります。まず別の`setup:tls`プロセスが動いていないことを確認し、正規の`.data/tls`・`.data/tls-private`とこれらの復旧用directoryを確認してください。正規directoryがない場合は、確立済みCAを含むbackupをそれぞれ元のパスへ戻して内容を検証します。ロックだけを削除して再実行しないでください。復旧候補がある間、scriptは新しいCAの生成を拒否します。

CA自体を更新するときは、サーバーを停止し、旧CAをすべての接続元のtrust storeから解除してから次を実行します。

```bash
npm run setup:tls -- --rotate-ca
```

新しい`ca.crt`をすべての接続元へ再登録し、Mock IdPと接続元プロセスを再起動してください。CAが変わるため、古い証明書を組み込んだコンテナイメージも再buildが必要です。

production buildを確認する場合は次を実行します。

```bash
npm run build:check
npm start
```

## ホストと別Composeからの接続

ホストブラウザからの通信経路は次のとおりです。

```text
Host Browser
    |
    | https://mock-idp.test:9000
    v
hosts: mock-idp.test -> 127.0.0.1
    |
    v
localhost:9000
    |
    v
Docker port forwarding
    |
    v
app (Mock IdP):9000
```

別Composeで起動するアプリケーションは、同じexternal networkへ参加させます。Composeのproject名に依存するnetwork名は使用しません。

```yaml
services:
  app:
    networks:
      - mock-idp-network

networks:
  mock-idp-network:
    external: true
```

別コンテナからはDocker DNSがnetwork aliasを解決します。コンテナ内のhosts設定や`localhost`への置き換えは不要です。

接続元コンテナも公開CAを信頼する必要があります。`.data/tls/ca.crt`をread-only mountする、接続元imageへ組み込むなどの方法で公開CAだけを渡し、接続元のOS、runtime、SDKが提供する方法で信頼を設定してください。具体的な方法はbase imageや使用技術の公式ドキュメントを参照します。CA秘密鍵とサーバー秘密鍵は接続元へmountまたはCOPYしません。CAをimageへ組み込む場合は、CAローテーション後にimageを再buildします。mountする場合も、CAを読み込む接続元プロセスの再起動またはreloadが必要です。

```text
Application Container
    |
    | https://mock-idp.test:9000
    v
Docker DNS / network alias
    |
    v
mock-idp-network
    |
    v
app (Mock IdP) Container
```

`localhost`は実行環境自身を指すため、ホストではホストを、アプリケーションコンテナではそのコンテナ自身を指します。接続元によってissuerを切り替えるとDiscoveryやJWTの`iss`検証が不整合になるため、issuerには使用しません。

`.local`はmDNSで使用され、OSやネットワーク環境によって名前解決と衝突する可能性があります。この用途ではテスト用に予約された`.test`を使用します。

HTTPSでもAdmin APIは未認証です。このMock IdPをインターネットへ公開しないでください。curlの`-k`やruntime、SDKの設定で証明書検証を無効化せず、接続元へCAを正しく登録してください。

## Issuer URL

issuerは`https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0`です。ブラウザの`/authorize`、サーバーサイドWebアプリの`/token`、Discovery、JWKS、JWTの`iss`、OIDCクライアント設定で同じURLを使用します。tenant、host、portは実行時に変更できません。

OIDC endpointはissuerと同じtenant path配下にあります。

```text
https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/.well-known/openid-configuration
https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/authorize
https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/token
https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/jwks
```

Admin UI、Admin API、Healthはissuer pathにかかわらずorigin直下の`/__mock`、`/__mock/api/*`、`/health`です。

Mock IdPは生成済みサーバー証明書を読み込み、直接HTTPSで待ち受けます。HTTP listenerやHTTPからHTTPSへのredirectは提供しません。

## OIDC設定

| 項目                           | 既定値                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| Tenant ID                      | `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`                                 |
| Issuer                         | `https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0` |
| Listen address                 | `0.0.0.0:9000`                                                         |
| Public client                  | `mock-public-client`（secretなし）                                     |
| Confidential client            | `mock-confidential-client`                                             |
| Confidential secret            | `mock-client-secret-change-me`                                         |
| Redirect URI                   | `http://localhost:3000/callback`                                       |
| Access token audience/resource | `urn:mock-api`                                                         |

これらは初回起動時に作成される初期クライアントです。Admin UIの「OIDC Clients」からクライアントを追加・編集・削除でき、変更は再起動なしで反映されます。設定は`.data/clients.json`へ0600で保存されます。

全clientでAuthorization Code FlowとS256 PKCEが必須です。Discovery、issuer、audience、期限、署名、JWKS、redirect URI、client IDの検証を無効化せず利用してください。

### OIDCクライアント管理

Admin UIではClient ID、Public/Confidential種別、secret、Token Endpoint認証方式、Redirect URI、Post Logout Redirect URI、Access Token Audienceを設定できます。Public clientは`none`、Confidential clientは`client_secret_basic`または`client_secret_post`を使用します。

標準OIDC scopeの`openid`, `profile`, `email`, `offline_access`は全クライアントで利用できます。これらはEntra IDのアプリ登録項目ではなく、アプリケーションが認可リクエストの`scope`パラメーターで要求します。`email` claimは`email` scopeを要求した場合だけ返され、`offline_access`を要求するとRefresh Tokenが発行されます。`email`は表示・連絡先用途とし、ユーザー識別には`oid`と`tid`の組または`sub`を使用してください。

Microsoft Graphや独自Web APIのAPI permissions、Expose an API、Optional claimsはこのMock Providerの対象外です。

Client Secretはローカル試験の利便性を優先し、設定ファイル、Admin API、Admin UIのすべてで平文として扱います。未認証のAdmin APIと合わせて、インターネットへ絶対に公開しないでください。

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
    "accessTokenAudience":"urn:my-api"
  }'

curl --cacert "$CURL_CA" -X POST https://mock-idp.test:9000/__mock/api/clients/reset \
  -H 'content-type: application/json' \
  -d '{}'
```

Client IDは作成後に変更できません。変更する場合は削除して再作成してください。`POST /__mock/api/clients/reset`はクライアントだけを初期状態へ戻し、シナリオのリセットには影響しません。Client設定は`.data/clients.json`へ永続化しますが、認可コード、Session、Grant、Access Token、Refresh TokenのProvider内部状態はProviderインスタンス単位のメモリだけに保持します。Clientを削除またはresetしても発行済みartifactは完全には失効せず、Providerを含むappの再構築またはプロセス再起動で破棄されます。

## テストユーザー

| 表示名            | username                   | groups                                    |
| ----------------- | -------------------------- | ----------------------------------------- |
| Admin User        | `admin@example.com`        | `app-admin-group-id`, `app-user-group-id` |
| Normal User       | `user@example.com`         | `app-user-group-id`                       |
| Unauthorized User | `unauthorized@example.com` | なし                                      |

ID tokenとJWT access tokenには`sub`, `oid`, `tid`, `name`, `preferred_username`, `mail`, `groups`, `iss`, `aud`, `iat`, `exp`, `nbf`が含まれます。

## シナリオ API

以下では、issuerがpath付きの場合もAdmin APIのbase URLにはoriginだけを指定します。

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

`CONTINUOUS`は解除またはResetまで対象要求すべてへFaultを適用します。`LIMITED`は1以上の`failureCount`が必須で、対象endpointへ到達した要求だけを同期的に消費します。最後の対象要求にもFaultを返し、その後の現在状態はNORMALになります。Timeoutも遅延開始時にcountを消費し、クライアントが切断しても戻しません。

| シナリオ                       | 対象                      | 動作                                                  |
| ------------------------------ | ------------------------- | ----------------------------------------------------- |
| `NORMAL`                       | なし                      | Faultを適用しない                                     |
| `ACCESS_DENIED`                | Authorization OAuth       | `access_denied`を検証済みredirect URIへ返す           |
| `AUTH_LOGIN_REQUIRED`          | Authorization OAuth       | `login_required`を検証済みredirect URIへ返す          |
| `AUTH_INTERACTION_REQUIRED`    | Authorization OAuth       | `interaction_required`を検証済みredirect URIへ返す    |
| `AUTH_TEMPORARILY_UNAVAILABLE` | Authorization OAuth       | `temporarily_unavailable`をredirect URIへ返す         |
| `AUTH_SERVER_ERROR`            | Authorization OAuth       | `server_error`をredirect URIへ返す                    |
| `AUTH_429`                     | `GET` Authorization       | HTTP 429と`Retry-After`を直接返す                     |
| `AUTH_500`                     | `GET` Authorization       | HTTP 500と任意の`Retry-After`を直接返す               |
| `AUTH_TIMEOUT`                 | `GET` Authorization       | 指定時間遅延してから通常処理を続行                    |
| `NO_GROUPS`                    | ID/access token claim生成 | `groups`だけを除外                                    |
| `WRONG_AUDIENCE`               | ID/access token           | 正常鍵で署名し、`aud`だけを変更                       |
| `WRONG_ISSUER`                 | ID/access token           | 正常鍵で署名し、`iss`だけを変更                       |
| `EXPIRED_TOKEN`                | ID/access token           | 正常鍵で署名し、整合した過去の`iat`/`nbf`/`exp`を設定 |
| `FUTURE_NBF`                   | ID/access token           | 正常鍵で署名し、`now < nbf < exp`にする               |
| `INVALID_SIGNATURE`            | ID/access token           | 非公開Key Bで署名し、公開Key Aの`kid`を設定           |
| `UNKNOWN_KID`                  | ID/access token           | Key Aで署名し、JWKSにない`kid`を設定                  |
| `SIGNING_KEY_ROLLOVER`         | Token/JWKS                | 新しい鍵で署名し、旧鍵と新鍵をJWKSへ公開              |
| `TOKEN_400`                    | `POST` Token              | 設定可能なOAuth errorをHTTP 400で返す                 |
| `TOKEN_429`                    | `POST` Token              | HTTP 429と`Retry-After`を返す                         |
| `TOKEN_500`                    | `POST` Token              | HTTP 500と任意の`Retry-After`を返す                   |
| `TOKEN_TIMEOUT`                | `POST` Token              | 指定時間遅延してから通常処理を続行                    |
| `JWKS_INVALID`                 | `GET` JWKS                | HTTP 200で不正なJWKSを返す                            |
| `JWKS_429`                     | `GET` JWKS                | HTTP 429と`Retry-After`を返す                         |
| `JWKS_500`                     | `GET` JWKS                | HTTP 500と任意の`Retry-After`を返す                   |
| `JWKS_TIMEOUT`                 | `GET` JWKS                | 指定時間遅延してから通常処理を続行                    |
| `DISCOVERY_429`                | `GET` Discovery           | HTTP 429と`Retry-After`を返す                         |
| `DISCOVERY_500`                | `GET` Discovery           | HTTP 500と任意の`Retry-After`を返す                   |
| `DISCOVERY_TIMEOUT`            | `GET` Discovery           | 指定時間遅延してから通常処理を続行                    |

### OAuth redirect errorとHTTP fault

AuthorizationのOAuth errorとHTTP faultは別の障害です。

- `ACCESS_DENIED`, `AUTH_LOGIN_REQUIRED`, `AUTH_INTERACTION_REQUIRED`, `AUTH_TEMPORARILY_UNAVAILABLE`, `AUTH_SERVER_ERROR`はAuthorization requestをProviderが検証した後、OAuth errorと元の`state`を登録済みredirect URIへ返します。`response_mode=query`と`form_post`はProviderの標準処理に従います。
- `AUTH_429`, `AUTH_500`はAuthorization endpoint自体のHTTP障害です。redirectせず、`GET /authorize`からHTTP statusとJSON本文を直接返します。`AUTH_TIMEOUT`はendpointで待機した後、通常のAuthorization処理を続けます。
- したがって、`AUTH_SERVER_ERROR`と`AUTH_500`、`AUTH_TEMPORARILY_UNAVAILABLE`と`AUTH_429`は統合しません。前者はアプリケーションのcallbackへ届くOAuth response、後者はブラウザとAuthorization endpoint間のHTTP失敗です。

HTTP 429の本文は`temporarily_unavailable`、HTTP 500の本文は`server_error`を使用します。どちらも`error_description`に注入したScenario名を含む安定したOAuth形式JSONですが、Authorization HTTP faultはOAuth redirect responseではありません。

### Parametersと回復試験

- `AUTH_429`, `TOKEN_429`, `JWKS_429`, `DISCOVERY_429`の`retryAfterSeconds`は1以上のsafe integerで、未指定時は60秒です。
- `AUTH_500`, `TOKEN_500`, `JWKS_500`, `DISCOVERY_500`でも`retryAfterSeconds`を任意指定できます。指定した場合だけ`Retry-After`を返します。
- `AUTH_TIMEOUT`, `TOKEN_TIMEOUT`, `JWKS_TIMEOUT`, `DISCOVERY_TIMEOUT`の`delayMs`は1〜300,000msで、未指定時は30,000msです。
- Authorization/JWKS/Discovery Faultは`GET`、Token Faultは`POST`だけが対象です。対象外endpoint、異なるmethod、`OPTIONS`、`HEAD`はLIMITED countを消費しません。
- Mock自身は待機や再試行を行いません。429では`Retry-After`が終わるまで再取得せず、5xxではheaderがあれば従い、なければ指数バックオフするクライアント動作を試験してください。Timeoutでも即時再試行を避けてください。

Microsoft Entraの[クライアントアプリケーションの回復性](https://learn.microsoft.com/en-us/entra/architecture/resilience-client-app)と[MSALのthrottling例](https://learn.microsoft.com/en-us/entra/msal/dotnet/advanced/client-and-server-throttling)に合わせ、429の既定値は60秒です。特定のAADSTS番号には依存しません。

`prompt=none`で`login_required`または`interaction_required`を受けたクライアントは、同じsilent requestを繰り返さずinteractive authenticationへ切り替えてください。[Authorization endpointのエラー](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-codes-for-authorization-endpoint-errors)は検証済みredirect URIだけへ返します。

### Provider標準機能との責務分離

通常の入力で再現できるOAuth protocol validationはScenarioとして重複実装しません。次のケースは`oidc-provider`自身のAuthorization Code lifecycle、PKCE、client authentication、redirect URI検証を利用します。

- 正常なAuthorization Code FlowとPKCE
- 不正・期限切れ・再利用済みAuthorization Codeによる`invalid_grant`
- 不一致の`code_verifier`による`invalid_grant`
- 不正なconfidential client secretによる`invalid_client`
- Token交換時の`redirect_uri`不一致による`invalid_grant`

このため、`AUTH_CODE_INVALID`, `AUTH_CODE_EXPIRED`, `AUTH_CODE_REUSED`, `PKCE_MISMATCH`, `INVALID_CLIENT`, `REDIRECT_URI_MISMATCH`という専用Scenarioはありません。`state`と`nonce`もクライアント側検証を上書きするScenarioにはしません。任意のToken endpoint errorが必要な場合は`TOKEN_400`をescape hatchとして使用できます。AADSTS50196のloop検出も、例えば次のように再現できます。

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

`JWKS_INVALID`、`UNKNOWN_KID`、`SIGNING_KEY_ROLLOVER`は、Microsoft Entraの[signing key rollover guidance](https://learn.microsoft.com/en-us/entra/identity-platform/signing-key-rollover#best-practices-for-keys-metadata-caching-and-validation)にある、複数鍵の保持、未知の`kid`でのmetadata再取得、不正なkey metadata受信時のlast-known-good継続を試験するためのシナリオです。`SIGNING_KEY_ROLLOVER`で公開した新しい鍵は、シナリオ完了、NORMALへの変更、別Scenarioへの切り替え後もJWKSに残り、Reset時だけ初期鍵へ戻ります。

`UNKNOWN_GROUPS`は認可データのケースでありOIDC障害ではないため削除しました。必要なgroupsはテストユーザーで表現してください。`DISCOVERY_INVALID`も削除し、Discoveryの障害は429、500、Timeoutで表現します。`JWKS_INVALID`はkey metadata検証用として維持します。Microsoft GraphはProviderの対象外なのでGraph APIの429は扱いません。

新しいシナリオを追加するときは、`src/scenario/types.ts`の名前・入力型と`src/scenario/registry.ts`の対象endpoint、effect、parameter/UI metadataを追加します。HTTP Faultは`src/faults/http-fault.ts`、claim生成は`src/oidc/provider.ts`、意図的なJWT異常は`src/faults/token-generator.ts`へ責務ごとに実装し、Store・Integration Testを追加してください。

## 鍵と状態

通常鍵と異常署名鍵は初回起動時に`.data/keys`へ生成し、秘密鍵ファイルは0600で保存します。`.data/`はGit対象外です。JWKSには通常鍵の公開部分だけを掲載します。鍵ディレクトリを削除すると再生成されます。

OIDC artifactとシナリオストアは単一プロセスのインメモリ実装です。再起動で認可コード、session、シナリオ履歴は失われます。

## 開発コマンド

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build:check
```
