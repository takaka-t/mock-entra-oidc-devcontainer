# Mock Entra ID / OIDC Provider

Microsoft Entra IDをIdPとするアプリケーションのローカル開発・障害試験用OIDC Providerです。OIDCの正常処理は`oidc-provider`に委譲し、HTTP障害、遅延、不正JWT、claim変更を独立したシナリオ層で注入します。Entra ID完全互換ではなく、Microsoft Graph APIも提供しません。

> ローカル試験専用です。Admin APIは認証されず、ユーザー認証も選択式です。インターネットへ公開しないでください。

## 起動

既存のdevcontainerとNode.js 24を前提とします。Mock IdPのtenant IDとissuerは次の値に固定しています。

```text
Tenant ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
Issuer: http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0
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

devcontainerを初めて起動したとき、または`node_modules`用named volumeを作り直したときは、依存関係を導入してください。

```bash
npm ci
```

依存関係の導入後、devcontainer内で次を実行してください。Composeでは固定のコンテナport 9000をホストの`127.0.0.1:9000`に公開します。

```bash
npm run dev
```

主なURLは次のとおりです。

- Admin UI: `http://mock-idp.test:9000/__mock`
- Discovery: `http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/.well-known/openid-configuration`
- Authorization Endpoint: `http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/authorize`
- Token Endpoint: `http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/token`
- JWKS: `http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/jwks`
- Health: `http://mock-idp.test:9000/health`

OIDCクライアントにはauthority/issuerとして`http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0`を設定してください。Discoveryが返す各endpointとJWTの正常系`iss`もこの値を基準に生成され、JWTの`tid`には固定tenant IDが入ります。OIDC endpointへのrequestのschemeとHostがissuerのoriginに一致しない場合は`400 invalid_request_origin`になります。

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

issuerは`http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0`です。ブラウザの`/authorize`、サーバーサイドWebアプリの`/token`、Discovery、JWKS、JWTの`iss`、OIDCクライアント設定で同じURLを使用します。tenant、host、portは実行時に変更できません。

OIDC endpointはissuerと同じtenant path配下にあります。

```text
http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/.well-known/openid-configuration
http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/authorize
http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/token
http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0/jwks
```

Admin UI、Admin API、Healthはissuer pathにかかわらずorigin直下の`/__mock`、`/__mock/api/*`、`/health`です。

reverse proxy、HTTPS化、ローカルCA、証明書の構築は今回の標準構成の対象外です。

## OIDC設定

| 項目                           | 既定値                                                                |
| ------------------------------ | --------------------------------------------------------------------- |
| Tenant ID                      | `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`                                |
| Issuer                         | `http://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0` |
| Listen address                 | `0.0.0.0:9000`                                                        |
| Public client                  | `mock-public-client`（secretなし）                                    |
| Confidential client            | `mock-confidential-client`                                            |
| Confidential secret            | `mock-client-secret-change-me`                                        |
| Redirect URI                   | `http://localhost:3000/callback`                                      |
| Access token audience/resource | `urn:mock-api`                                                        |

これらは初回起動時に作成される初期クライアントです。Admin UIの「OIDC Clients」からクライアントを追加・編集・削除でき、変更は再起動なしで反映されます。設定は`.data/clients.json`へ0600で保存されます。

全clientでAuthorization Code FlowとS256 PKCEが必須です。Discovery、issuer、audience、期限、署名、JWKS、redirect URI、client IDの検証を無効化せず利用してください。

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

Client IDは作成後に変更できません。変更する場合は削除して再作成してください。`POST /__mock/api/clients/reset`はクライアントだけを初期状態へ戻し、シナリオのリセットには影響しません。Clientを削除またはresetしても、発行済みの認可コードやRefresh Tokenは完全には失効しません。完全に初期化するにはプロセスを再起動してください。

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
MOCK_ORIGIN=http://mock-idp.test:9000

curl "$MOCK_ORIGIN/__mock/api/scenario"

curl -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_500","mode":"LIMITED","failureCount":2}'

curl -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_TIMEOUT","mode":"CONTINUOUS","parameters":{"delayMs":100}}'

curl -X PUT "$MOCK_ORIGIN/__mock/api/scenario" \
  -H 'content-type: application/json' \
  -d '{"scenario":"TOKEN_429","mode":"LIMITED","failureCount":1,"parameters":{"retryAfterSeconds":60}}'

curl -X DELETE "$MOCK_ORIGIN/__mock/api/scenario"
curl -X POST "$MOCK_ORIGIN/__mock/api/reset" \
  -H 'content-type: application/json' \
  -d '{}'
```

`CONTINUOUS`は解除またはResetまで対象要求すべてへFaultを適用します。`LIMITED`は1以上の`failureCount`が必須で、対象endpointへ到達した要求だけを同期的に消費します。最後の要求にはFaultを返したうえで現在状態がNORMALになります。Timeoutは遅延開始時に消費され、クライアントが切断しても戻しません。

| シナリオ                       | 対象                      | 動作                                                  |
| ------------------------------ | ------------------------- | ----------------------------------------------------- |
| `NORMAL`                       | なし                      | Faultを適用しない                                     |
| `ACCESS_DENIED`                | Authorization             | 標準OIDC `access_denied`をredirect URIへ返す          |
| `AUTH_INTERACTION_REQUIRED`    | Authorization             | `interaction_required`をredirect URIへ返す            |
| `AUTH_TEMPORARILY_UNAVAILABLE` | Authorization             | `temporarily_unavailable`をredirect URIへ返す         |
| `AUTH_SERVER_ERROR`            | Authorization             | `server_error`をredirect URIへ返す                    |
| `NO_GROUPS`                    | ID/access token claim生成 | `groups`だけを除外                                    |
| `UNKNOWN_GROUPS`               | ID/access token claim生成 | `groups`を`unknown-group-id`へ変更                    |
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
| `JWKS_500`                     | `GET` JWKS                | HTTP 500を返す                                        |
| `JWKS_TIMEOUT`                 | `GET` JWKS                | 指定時間遅延してから通常処理を続行                    |
| `DISCOVERY_INVALID`            | `GET` Discovery           | HTTP 200で不正なDiscovery metadataを返す              |
| `DISCOVERY_500`                | `GET` Discovery           | HTTP 500を返す                                        |
| `DISCOVERY_TIMEOUT`            | `GET` Discovery           | 指定時間遅延してから通常処理を続行                    |

### シナリオの使い分け

- Authorization系は、認可リダイレクトで返るOAuthエラーをアプリケーションが適切に表示・再試行・対話認証へ切り替えられるか確認するためのものです。
- claim/JWT系は、トークンのclaim検証、`iss`・`aud`・有効期間・署名の検証が確実に行われるか確認します。`INVALID_SIGNATURE`はJWKS非公開の別鍵、`UNKNOWN_KID`は正常鍵と未公開`kid`を使います。
- Token/JWKS/DiscoveryのHTTP障害・遅延系は、対象endpointに到達した要求だけへ適用されます。クライアントのタイムアウト、バックオフ、再試行、last-known-goodの利用を確認してください。
- `SIGNING_KEY_ROLLOVER`は新しい鍵で署名し、旧鍵と新鍵をJWKSへ公開します。有効化後の新しい鍵は、シナリオ完了、NORMALへ戻した後、別のシナリオへの切り替え後も公開され続けます。シナリオをリセットすると初期鍵だけの状態へ戻ります。

Timeoutの`delayMs`は1〜300,000msで、未指定時は30,000msです。`retryAfterSeconds`は1以上のsafe integerです。`TOKEN_429`では未指定時に60秒を使用し、`TOKEN_500`では指定した場合だけ`Retry-After`を返します。Mock自身は待機や再試行を行いません。Token Faultの対象は`POST`、JWKS/Discovery Faultの対象は`GET`だけです。`OPTIONS`と`HEAD`はLimited Countを消費しません。

Microsoft Entraの[クライアントアプリケーションの回復性](https://learn.microsoft.com/en-us/entra/architecture/resilience-client-app)では、429では`Retry-After`が終わる前にTokenを再取得せず、5xxでは`Retry-After`があれば同様に従い、なければ指数バックオフすることが推奨されています。[MSALのthrottling例](https://learn.microsoft.com/en-us/entra/msal/dotnet/advanced/client-and-server-throttling)に合わせ、`TOKEN_429`の既定値は60秒です。

`TOKEN_429`の本文はMockの安定したOAuth形式として`temporarily_unavailable`を返します。Microsoft公式資料が429で明示する契約はHTTP statusと`Retry-After`であり、本シナリオは特定のAADSTS番号を返しません。

[Authorization endpointのエラー](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-codes-for-authorization-endpoint-errors)は、検証済みredirect URIへ`state`とともに返します。`interaction_required`や`prompt=none`で返る`login_required`を受けたクライアントは、同じsilent requestを繰り返さずinteractive認証へ切り替えてください。`temporarily_unavailable`と`server_error`は即時に繰り返さず、バックオフして再試行します。

AADSTS50196のloop検出は専用シナリオを重複して設けず、既存の`TOKEN_400`で再現できます。

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

`DISCOVERY_INVALID`、`JWKS_INVALID`、`UNKNOWN_KID`、`SIGNING_KEY_ROLLOVER`は、Microsoft Entraの[signing key rollover guidance](https://learn.microsoft.com/en-us/entra/identity-platform/signing-key-rollover#best-practices-for-keys-metadata-caching-and-validation)にある、複数鍵の保持、未知の`kid`でのmetadata再取得、不正metadata受信時のlast-known-good継続を試験するためのシナリオです。Microsoft GraphはこのProviderの対象外なので、Graph APIの429は扱いません。

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
