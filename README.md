# Mock Entra ID / OIDC Provider

Microsoft Entra IDをIdPとするアプリケーションのローカル開発・障害試験用OIDC Providerです。OIDCの正常処理は`oidc-provider`に委譲し、HTTP障害、遅延、不正JWT、claim変更を独立したシナリオ層で注入します。Entra ID完全互換ではなく、Microsoft Graph APIも提供しません。

> ローカル試験専用です。Admin APIは認証されず、ユーザー認証も選択式です。インターネットへ公開しないでください。

## 起動

既存のdevcontainerとNode.js 24を前提とします。Compose標準構成では、Mock IdPのURLとissuerを次の値に固定しています。

```text
http://mock-idp.test:9000
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

devcontainerを初めて作成したときやvolumeを作り直したときは、`node_modules`用named volumeへ依存関係を導入してください。

```bash
npm ci
```

Composeでは`OIDC_ISSUER=http://mock-idp.test:9000`と`PORT=9000`を設定し、コンテナport 9000をホストの`127.0.0.1:9000`に公開します。devcontainer内で次を実行してください。

```bash
npm run dev
```

主なURLは次のとおりです。

- Admin UI: `http://mock-idp.test:9000/__mock`
- Discovery: `http://mock-idp.test:9000/.well-known/openid-configuration`
- Authorization Endpoint: `http://mock-idp.test:9000/authorize`
- Token Endpoint: `http://mock-idp.test:9000/token`
- JWKS: `http://mock-idp.test:9000/jwks`
- Health: `http://mock-idp.test:9000/health`

OIDCクライアントにもissuerとして`http://mock-idp.test:9000`を設定してください。Discoveryが返す各endpointとJWTの正常系`iss`もこの値を基準に生成されます。OIDC endpointへのrequestのschemeとHostがissuerのoriginに一致しない場合は`400 invalid_request_origin`になります。

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
    | http://mock-idp.test:9000
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

```text
Application Container
    |
    | http://mock-idp.test:9000
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

HTTPはローカル開発専用です。このMock IdPと未認証のAdmin APIをインターネットへ公開しないでください。

## Issuer URL

Compose標準構成のissuerは`http://mock-idp.test:9000`です。ブラウザの`/authorize`、サーバーサイドWebアプリの`/token`、Discovery、JWKS、JWTの`iss`、OIDCクライアント設定で同じURLを使用します。

アプリ本体の既存互換性として、Composeを使わない直接起動では`OIDC_ISSUER`に別の絶対HTTP(S) URLやpath付きURLを指定できます。末尾の`/`は正規化され、credentials、query、fragmentを含むURLは指定できません。通常のローカル開発ではComposeの固定値を使用してください。

```bash
# direct npm起動で既存のpath付きissuer機能を利用する例
OIDC_ISSUER=http://login.microsoftonline.test:9000/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/v2.0 npm run dev
```

path付きissuerではOIDC endpointも同じpath配下になります。

```text
http://login.microsoftonline.test:9000/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/v2.0/.well-known/openid-configuration
http://login.microsoftonline.test:9000/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/v2.0/authorize
http://login.microsoftonline.test:9000/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/v2.0/token
http://login.microsoftonline.test:9000/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/v2.0/jwks
```

Admin UI、Admin API、Healthはissuer pathにかかわらずorigin直下の`/__mock`、`/__mock/api/*`、`/health`です。

reverse proxyを使用するときだけ`TRUST_PROXY=true`を設定し、信頼できるproxyから正しい`X-Forwarded-Proto`と`X-Forwarded-Host`を渡してください。HTTPS化、ローカルCA、証明書の構築は今回の標準構成の対象外です。

## OIDC設定

| 項目                           | 既定値                             |
| ------------------------------ | ---------------------------------- |
| Issuer                         | `http://mock-idp.test:9000`        |
| Listen address                 | `0.0.0.0:9000`                     |
| Public client                  | `mock-public-client`（secretなし） |
| Confidential client            | `mock-confidential-client`         |
| Confidential secret            | `mock-client-secret-change-me`     |
| Redirect URI                   | `http://localhost:3000/callback`   |
| Access token audience/resource | `urn:mock-api`                     |

これらは初回起動時に作成される初期クライアントです。Admin UIの「OIDC Clients」からクライアントを追加・編集・削除でき、変更は再起動なしで反映されます。設定は`.data/clients.json`へ0600で保存されます。

全clientでAuthorization Code FlowとS256 PKCEが必須です。Discovery、issuer、audience、期限、署名、JWKS、redirect URI、client IDの検証を無効化せず利用してください。

環境変数:

| 変数                 | 説明                                             |
| -------------------- | ------------------------------------------------ |
| `OIDC_ISSUER`        | Composeでは`http://mock-idp.test:9000`に固定     |
| `PORT`               | Composeではコンテナ内listen portを`9000`に固定   |
| `HOST`               | listen address                                   |
| `TRUST_PROXY`        | 信頼できるreverse proxy配下だけで`true`にする    |
| `KEY_DIRECTORY`      | 署名鍵の保存先                                   |
| `CLIENT_CONFIG_FILE` | Client設定ファイル。既定値は`.data/clients.json` |

従来の`PUBLIC_CLIENT_ID`、`CONFIDENTIAL_CLIENT_ID`、`CONFIDENTIAL_CLIENT_SECRET`、`REDIRECT_URIS`、`ACCESS_TOKEN_AUDIENCE`は廃止されました。既定値以外を利用していた場合は、起動後にAdmin UIまたはClient Admin APIからクライアントを登録してください。

### OIDCクライアント管理

Admin UIではClient ID、Public/Confidential種別、secret、Token Endpoint認証方式、Redirect URI、Post Logout Redirect URI、Access Token Audienceを設定できます。Public clientは`none`、Confidential clientは`client_secret_basic`または`client_secret_post`を使用します。

標準OIDC scopeの`openid`, `profile`, `email`, `offline_access`は全クライアントで利用できます。これらはEntra IDのアプリ登録項目ではなく、アプリケーションが認可リクエストの`scope`パラメーターで要求します。`email` claimは`email` scopeを要求した場合だけ返され、`offline_access`を要求するとRefresh Tokenが発行されます。`email`は表示・連絡先用途とし、ユーザー識別には`oid`と`tid`の組または`sub`を使用してください。

Microsoft Graphや独自Web APIのAPI permissions、Expose an API、Optional claimsはこのMock Providerの対象外です。

Client Secretはローカル試験の利便性を優先し、設定ファイル、Admin API、Admin UIのすべてで平文として扱います。未認証のAdmin APIと合わせて、インターネットへ絶対に公開しないでください。

```bash
curl http://mock-idp.test:9000/__mock/api/clients

curl -X POST http://mock-idp.test:9000/__mock/api/clients \
  -H 'content-type: application/json' \
  -d '{
    "clientId":"my-app",
    "clientType":"PUBLIC",
    "tokenEndpointAuthMethod":"none",
    "redirectUris":["http://localhost:8080/callback"],
    "postLogoutRedirectUris":[],
    "accessTokenAudience":"urn:my-api"
  }'

curl -X POST http://mock-idp.test:9000/__mock/api/clients/reset \
  -H 'content-type: application/json' \
  -d '{}'
```

Client IDは作成後に変更できません。変更する場合は削除して再作成してください。`POST /__mock/api/clients/reset`はクライアントだけを初期状態へ戻し、Scenario Resetには影響しません。Clientを削除またはresetしても、発行済みの認可コードやRefresh Tokenは完全には失効しません。完全に初期化するにはプロセスを再起動してください。

## テストユーザー

| 表示名            | username                   | groups                                    |
| ----------------- | -------------------------- | ----------------------------------------- |
| Admin User        | `admin@example.com`        | `app-admin-group-id`, `app-user-group-id` |
| Normal User       | `user@example.com`         | `app-user-group-id`                       |
| Unauthorized User | `unauthorized@example.com` | なし                                      |

ID tokenとJWT access tokenには`sub`, `oid`, `tid`, `name`, `preferred_username`, `mail`, `groups`, `iss`, `aud`, `iat`, `exp`, `nbf`が含まれます。

## Scenario API

以下では、issuerがpath付きの場合もAdmin APIのbase URLにはoriginだけを指定します。

```bash
MOCK_ORIGIN=http://mock-idp.test:9000

curl "$MOCK_ORIGIN/__mock/api/scenario"

curl -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_500","mode":"LIMITED","failureCount":2}'

curl -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_TIMEOUT","mode":"CONTINUOUS","parameters":{"delayMs":100}}'

curl -X DELETE "$MOCK_ORIGIN/__mock/api/scenario"
curl -X POST "$MOCK_ORIGIN/__mock/api/reset" \
  -H 'content-type: application/json' \
  -d '{}'
```

`CONTINUOUS`は解除またはResetまで対象要求すべてへFaultを適用します。`LIMITED`は1以上の`failureCount`が必須で、対象endpointへ到達した要求だけを同期的に消費します。最後の要求にはFaultを返したうえで現在状態がNORMALになります。Timeoutは遅延開始時に消費され、クライアントが切断しても戻しません。

| Scenario            | 対象                      | 動作                                                  |
| ------------------- | ------------------------- | ----------------------------------------------------- |
| `NORMAL`            | なし                      | Faultを適用しない                                     |
| `ACCESS_DENIED`     | Authorization             | 標準OIDC `access_denied`をredirect URIへ返す          |
| `NO_GROUPS`         | ID/access token claim生成 | `groups`だけを除外                                    |
| `UNKNOWN_GROUPS`    | ID/access token claim生成 | `groups`を`unknown-group-id`へ変更                    |
| `WRONG_AUDIENCE`    | ID/access token           | 正常鍵で署名し、`aud`だけを変更                       |
| `WRONG_ISSUER`      | ID/access token           | 正常鍵で署名し、`iss`だけを変更                       |
| `EXPIRED_TOKEN`     | ID/access token           | 正常鍵で署名し、整合した過去の`iat`/`nbf`/`exp`を設定 |
| `FUTURE_NBF`        | ID/access token           | 正常鍵で署名し、`now < nbf < exp`にする               |
| `INVALID_SIGNATURE` | ID/access token           | 非公開Key Bで署名し、公開Key Aの`kid`を設定           |
| `UNKNOWN_KID`       | ID/access token           | Key Aで署名し、JWKSにない`kid`を設定                  |
| `TOKEN_400`         | `POST` Token              | 設定可能なOAuth errorをHTTP 400で返す                 |
| `TOKEN_500`         | `POST` Token              | HTTP 500を返す                                        |
| `TOKEN_TIMEOUT`     | `POST` Token              | 指定時間遅延してから通常処理を続行                    |
| `JWKS_500`          | `GET` JWKS                | HTTP 500を返す                                        |
| `JWKS_TIMEOUT`      | `GET` JWKS                | 指定時間遅延してから通常処理を続行                    |
| `DISCOVERY_500`     | `GET` Discovery           | HTTP 500を返す                                        |
| `DISCOVERY_TIMEOUT` | `GET` Discovery           | 指定時間遅延してから通常処理を続行                    |

JWTシナリオはID tokenとJWT access tokenの双方へ適用されます。`INVALID_SIGNATURE`はJWKS非公開の別鍵、`UNKNOWN_KID`は正常鍵と未公開kidを使います。

Timeoutの`delayMs`は1〜300,000msで、未指定時は30,000msです。Token Faultの対象は`POST`、JWKS/Discovery Faultの対象は`GET`だけです。`OPTIONS`と`HEAD`はLimited Countを消費しません。

新しいScenarioを追加するときは、`src/scenario/types.ts`の名前・入力型と`src/scenario/registry.ts`の対象endpoint、effect、parameter/UI metadataを追加します。HTTP Faultは`src/faults/http-fault.ts`、claim生成は`src/oidc/provider.ts`、意図的なJWT異常は`src/faults/token-generator.ts`へ責務ごとに実装し、Store・Integration Testを追加してください。

## 鍵と状態

通常鍵と異常署名鍵は初回起動時に`KEY_DIRECTORY`へ生成し、秘密鍵ファイルは0600で保存します。既定の`.data/`はGit対象外です。JWKSには通常鍵の公開部分だけを掲載します。鍵ディレクトリを削除すると再生成されます。

OIDC artifactとScenario Storeは単一プロセスのインメモリ実装です。再起動で認可コード、session、scenario履歴は失われます。

## 開発コマンド

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build:check
```
