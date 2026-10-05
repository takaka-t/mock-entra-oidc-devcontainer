# Mock Entra ID / OIDC Provider

Microsoft Entra IDをIdPとするアプリケーションのローカル開発・障害試験用OIDC Providerです。OIDCの正常処理は`oidc-provider`に委譲し、HTTP障害、遅延、不正JWT、claim変更を独立したシナリオ層で注入します。Entra ID完全互換ではなく、Microsoft Graph APIも提供しません。

> ローカル試験専用です。インターネットへ公開しないでください。HTTPSでもAdmin APIは認証されず、ユーザー認証も選択式です。Client Secretもローカル試験の利便性を優先し、設定ファイル、Admin API、Admin UIのすべてで平文として扱います。

## 目次

- [起動](#起動)
- [エンドポイント](#エンドポイント)
- [TLS証明書とローカルCA](#tls証明書とローカルca)
- [ホストと別Composeからの接続](#ホストと別composeからの接続)
- [OIDCクライアントとテストユーザー](#oidcクライアントとテストユーザー)
- [シナリオ API](#シナリオ-api)
- [アクセスログ](#アクセスログ)
- [鍵と状態](#鍵と状態)
- [開発コマンド](#開発コマンド)

## 起動

devcontainerとNode.js 24を前提とします。Composeのservice名は`app`で、OIDCで公開するhostnameはservice名から分離したDocker network aliasの`mock-idp.test`です。Tenant ID、issuer、host、portは次の値に固定しており、実行時に変更できません。

```text
Tenant ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
Issuer:    https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0
```

### devcontainer起動前の準備

1. **外部Docker networkの作成**: Composeは外部Docker network `mock-idp-network`を使用するため、初回起動前に`docker network create mock-idp-network`を実行します。
2. **hostsファイルへのエントリ追加**: ホストOS上のブラウザから同じURLへアクセスするため、hostsファイル（macOS / Linux: `/etc/hosts`、Windows: `C:\Windows\System32\drivers\etc\hosts`）へ`127.0.0.1 mock-idp.test`を追加します。管理者権限が必要です。アプリケーションからは自動変更しません。

### devcontainer起動後のセットアップ

1. **依存関係の導入（自動）**: コンテナを起動するたびに`.devcontainer/docker/docker-compose.yml`の`command`が`npm ci`を実行するため、初回起動や`node_modules`用named volumeの再作成時だけでなく、`package-lock.json`の更新も次回起動時に反映されます。VS Codeの接続と並行して進むため、接続直後はまだ導入中のことがあります。進行状況と結果は`docker logs <コンテナ名>`（コンテナ名は`docker ps`で確認）で確認できます。自動実行が失敗した場合（コンテナ自体は利用できます）や、起動し直さずに依存関係を入れ直す場合は、コンテナ内のターミナルで`npm ci`を手動実行します。
2. **TLS証明書の生成**: devcontainerを初めて起動したとき、または`tls-private`用named volumeを作り直したときに`npm run setup:tls`を実行します。ローカルCAと`mock-idp.test`用サーバー証明書を生成します（詳細は[TLS証明書とローカルCA](#tls証明書とローカルca)）。
3. **Mock IdPの起動**: `npm run dev`を実行します。Composeは固定のコンテナport 9000（listen address `0.0.0.0:9000`）をホストの`127.0.0.1:9000`に公開します。`ca.crt`、`server.crt`、`server.key.pem`がない、または内容が不正な場合は起動に失敗します。`ca.key.pem`はサーバー起動では読み込まず、証明書更新時だけ使用します。利用できるURLは[エンドポイント](#エンドポイント)を参照してください。
4. **接続元でローカルCAを信頼する**: ホストOSやブラウザ、別Composeのコンテナなどの接続元でローカルCAを信頼させないと、証明書エラーでHTTPS接続できません。手順は[接続元でローカルCAを信頼する](#接続元でローカルcaを信頼する)を参照してください。

## エンドポイント

Mock IdPは生成済みサーバー証明書を読み込み、直接HTTPSで待ち受けます。HTTP listenerやHTTPからHTTPSへのredirectは提供しません。OIDC endpointのpath構造はMicrosoft Entra ID (v2.0 endpoint)の[公式仕様](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)に準拠しています。

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

- tenant直下からの相対pathで見ると、Discoveryはissuerと同じ`/v2.0`配下（`/v2.0/.well-known/openid-configuration`）ですが、authorize/token/logout（`/oauth2/v2.0/authorize`、`/oauth2/v2.0/token`、`/oauth2/v2.0/logout`）とJWKS（`/discovery/v2.0/keys`）はissuerの`/v2.0`とは別の、tenant直下の兄弟pathです。Admin UI、Admin API、Healthはissuer pathにかかわらずorigin直下です。
- Discoveryが返す各endpointとJWTの正常系`iss`はissuerを基準に生成されます。OIDCクライアントのauthority/issuerにもissuerを設定してください。JWTの`tid`には固定Tenant IDが入ります。OIDC endpointへのrequestのschemeとHostがissuerのoriginに一致しない場合は`400 invalid_request_origin`になります。
- LogoutはRP-Initiated Logoutの確認ページを経由します。確認ページの送信先とサインアウト完了ページはLogout pathのsub pathの`/oauth2/v2.0/logout/confirm`、`/oauth2/v2.0/logout/success`です（クライアントが直接呼ぶpathではありません）。`post_logout_redirect_uri`は、そのクライアントのPost Logout Redirect URIに登録済みの場合だけ受け付けます。
- `common`はEntraのmulti-tenant aliasです。クライアントライブラリはsign-inを始める前に`HEAD https://login.microsoftonline.com/common/oauth2/v2.0/authorize`で到達性を確認するため、このMockはこの接続性プローブだけをtenant直下ではなくorigin直下で提供します。受け付けるのは`HEAD`だけです（CORS preflightの`OPTIONS`は204、他のmethodは404）。tenant aliasとしての`common`は実装していないため、このpathで認証フローは開始できません。
- Microsoft Entra IDのDiscoveryドキュメントには`pushed_authorization_request_endpoint`（PAR）が含まれないため、PAR機能は無効化しています。

### MSAL利用時の注意

HTTPSで提供していても、MSALがcustom authorityを受け入れるとは限りません。`mock-idp.test:9000`はMicrosoftの既知クラウドインスタンスではないため、MSAL側のinstance discovery（既知authority検証）でブロックされます。

- MSAL.js（Browser / Node）では、使用するversionの設定方法に従って`knownAuthorities`へ`mock-idp.test:9000`を追加してください。MSAL Node v5では設定先が`auth`から`system`へ移動しているため、[custom OIDC authorityの説明](https://learn.microsoft.com/en-us/entra/msal/javascript/node/initialize-public-client-application)と[使用versionの設定リファレンス](https://learn.microsoft.com/en-us/entra/msal/javascript/node/configuration)を確認してください。
- endpointのpath構造はEntraに準拠しているため、`protocolMode`を`OIDC`にする必要はない可能性があります。既定の`protocolMode`（AAD）で動作するかは使用するMSAL SDK/バージョンで実際に確認してください。
- MSAL.NETなど他の実装でも、対象versionとflowが提供するcustom OIDC authority APIを使用します。
- authority metadata、Discovery、issuer、署名、audience、証明書の検証は無効化しないでください。

## TLS証明書とローカルCA

### 生成されるファイル

`setup:tls`は公開証明書と秘密鍵を別々のディレクトリへ書き込みます。

| ファイル                           | 用途                                     |
| ---------------------------------- | ---------------------------------------- |
| `.data/tls/ca.crt`                 | 接続元へ登録する公開CA証明書             |
| `.data/tls/server.crt`             | Mock IdPが提示するサーバー証明書         |
| `.data/tls-private/ca.key.pem`     | CA秘密鍵。外部へ配布・コピーしない       |
| `.data/tls-private/server.key.pem` | サーバー秘密鍵。外部へ配布・コピーしない |

- **ディレクトリを分ける理由**: `.data/tls`（公開証明書）はリポジトリのbind mountにそのまま含まれ、ホストからも参照できます。`.data/tls-private`（秘密鍵）は`node_modules`と同様に専用のnamed volume（`tls-private`）としてマウントされ、ホストのファイルシステムからは直接見えません。Windows Docker DesktopのBind Mountは常にPOSIXのpermissionを正しく保持できるとは限らず、秘密鍵の0700/0600チェックが失敗しうるためです。named volumeの実体はLinux VM側の通常のファイルシステムなので、この問題を回避できます。公開証明書（`ca.crt`/`server.crt`）は機密情報ではないため、bind mount側での正確なpermission一致は要求しません。
- `.data/tls-private`は0700、秘密鍵は0600で作成され、常に検証されます。permission検査を回避したり秘密鍵を読みやすくしたりしないでください。
- `--output-dir`と`--private-dir`には、同一でも親子関係でもない独立したディレクトリを指定してください。パスを正規化して重複・包含を検出した場合、セットアップはファイル生成前にエラーで終了します。
- `ca.key.pem`と`server.key.pem`は共有ストレージ、接続元コンテナ（mount・COPYを含む）、ホストOSのtrust storeへコピーしないでください。接続元へ登録・配布するのは公開CAの`ca.crt`だけです。

### 接続元でローカルCAを信頼する

CAの信頼設定が必要なのは、HTTPSクライアントが動作する接続元です。Mock IdPコンテナ自身のOS trust storeへCAを登録する必要はありません（Mock IdPは起動時の証明書検証に`.data/tls/ca.crt`と`.data/tls-private/server.key.pem`等を読み込みます）。

- **ホスト上のブラウザやアプリケーション**: ホストOS、ブラウザ、runtimeの該当するtrust storeへ設定します。
- **別Composeのアプリケーション**: `.data/tls/ca.crt`をread-only mountする、接続元imageへ組み込むなどの方法で公開CAだけを渡し、接続元コンテナのOS、runtime、SDKが提供する方法で信頼を設定します。imageへ組み込む場合はCAローテーション後にimageを再buildし、mountする場合もCAを読み込む接続元プロセスの再起動またはreloadが必要です。
- 登録・解除方法はOS、ブラウザ、runtime、SDK、base image、組織のセキュリティポリシーによって異なるため、それぞれの公式ドキュメントを参照してください。
- このCAは開発端末とテスト用コンテナだけで信頼し、不要になったら解除してください。
- curlの`-k`/`--insecure`やruntime、SDKの設定で証明書検証を無効化せず、CAを正しく登録してください。devcontainer内では次のように疎通を確認できます。

```bash
curl --cacert .data/tls/ca.crt https://mock-idp.test:9000/health
```

### 証明書の更新とCAローテーション

`npm run setup:tls`を再実行すると、状態に応じて次のように動作します。更新された証明書を反映するにはMock IdPを再起動してください。

| 状態                                                                                                                             | 結果                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `.data/tls`と`.data/tls-private`それぞれに有効な2ファイルが揃い、CAの残存期間が397日より長く、サーバー証明書の残存期間が30日以上 | 何も変更しない                                                           |
| サーバー証明書の残存期間が30日未満、または期限切れ（CAはまだ有効）                                                               | まだ有効な同じCAを使ってサーバー証明書だけを更新する（CAの再登録は不要） |
| CAの残存期間が397日以下                                                                                                          | 失敗する（有効期限内のローテーションを案内）                             |
| CAが期限切れ、ファイル一式が不完全・不正、または`.data/tls`と`.data/tls-private`の状態が食い違っている                           | 失敗する（自動上書きしない）                                             |

**CAのローテーション手順**

1. サーバーを停止する。
2. 旧CAをすべての接続元のtrust storeから解除する。
3. `npm run setup:tls -- --rotate-ca`で新規CAを生成する。
4. 新しい`ca.crt`をすべての接続元へ再登録する。
5. Mock IdPと接続元プロセスを再起動する。CAが変わるため、古い証明書を組み込んだコンテナイメージも再buildする。

> CAを期限切れまで放置した場合、`--rotate-ca`も既存の不正なdirectoryを上書きしません。Mock IdPを停止し、`.data/tls`と`.data/tls-private`をそれぞれ明示的に別名へ退避してから手順3を実行してください。

**異常終了時の復旧手順**

セットアップが異常終了すると、同時実行防止用の`.data/tls.setup.lock`、各ディレクトリ内の`<ファイル名>.backup-<pid>-<uuid>`形式のbackupファイル（例: `.data/tls/ca.crt.backup-*`、`.data/tls-private/server.key.pem.backup-*`）、`.tls-setup-*`形式の一時directory（例: `.data/tls/.tls-setup-*`、`.data/tls-private/.tls-setup-*`）が残る場合があります。復旧候補が残っている間、scriptは新しいCAの生成を拒否します。ロックだけを削除して再実行せず、次の手順で復旧してください。

1. 別の`setup:tls`プロセスが動いていないことを確認する。
2. 正規の`.data/tls`・`.data/tls-private`と、上記の復旧用directoryの状態を確認する。
3. 正規directoryがない場合は、確立済みCAを含むbackupをそれぞれ元のパスへ戻し、内容を検証する。

## ホストと別Composeからの接続

```text
ホストのブラウザ:
  https://mock-idp.test:9000 → hosts (mock-idp.test → 127.0.0.1) → localhost:9000 → Docker port forwarding → app (Mock IdP):9000

別Composeのアプリケーションコンテナ:
  https://mock-idp.test:9000 → Docker DNS / network alias → mock-idp-network → app (Mock IdP) Container
```

別Composeで起動するアプリケーションは、同じexternal networkへ参加させます。Composeのproject名に依存するnetwork名は使用しません。別コンテナからはDocker DNSがnetwork aliasを解決するため、コンテナ内のhosts設定や`localhost`への置き換えは不要です。接続元コンテナも公開CAを信頼する必要があります（[接続元でローカルCAを信頼する](#接続元でローカルcaを信頼する)）。

```yaml
services:
  app:
    networks:
      - mock-idp-network

networks:
  mock-idp-network:
    external: true
```

- `localhost`は実行環境自身を指すため、ホストではホストを、アプリケーションコンテナではそのコンテナ自身を指します。接続元によってissuerを切り替えるとDiscoveryやJWTの`iss`検証が不整合になるため、issuerには使用しません。
- `.local`はmDNSで使用され、OSやネットワーク環境によって名前解決と衝突する可能性があるため、テスト用に予約された`.test`を使用します。

## OIDCクライアントとテストユーザー

### 共通の動作

- 初回起動時に初期データ（[初期クライアント](#oidcクライアント)・[初期ユーザー](#テストユーザー)）を作成します。Admin UIの「OIDC クライアント一覧」「テストユーザー一覧」またはAdmin APIで追加・編集・削除でき、変更は再起動なしで反映されます（テストユーザーはサインイン画面とトークンに反映）。設定はそれぞれ`.data/clients.json`、`.data/users.json`へ0600で保存されます。
- Admin UIでの登録・編集はダイアログで行います。保存に成功するとダイアログが閉じて結果の通知が表示され、失敗した場合は入力を保持したままダイアログ内にエラーを表示します。保存後の一覧更新だけが失敗した場合は「一覧を再読み込み」で一覧取得だけを再試行できます。未保存の変更がある状態で閉じるときは確認します。
- Client IDとユーザーの`sub`は、前後の空白を除いて1〜100文字の印字可能ASCIIとし、`.`・`..`は指定できません。作成後は変更できないため、変更する場合は削除して再作成してください。
- Admin APIで必須項目を省略すると400になります。
- `.data/clients.json`と`.data/users.json`にも同じ入力検証を適用します。不適合なIDや改行入りの項目が保存されている場合は自動変換せず起動に失敗するため、設定ファイルを修正してください。
- `POST /__mock/api/clients/reset`はクライアントだけ、`POST /__mock/api/users/reset`はテストユーザーだけを初期状態へ戻します。シナリオや互いのリセットには影響しません。
- 永続化するのは設定だけです。認可コード、Session、Grant、Access Token、Refresh TokenのProvider内部状態はProviderインスタンス単位のメモリだけに保持するため、Client・ユーザーを削除またはresetしても発行済みartifact（発行済みJWTを含む）は完全には失効しません。Providerを含むappの再構築またはプロセス再起動で破棄されます。
- 削除・resetで消えたユーザーのブラウザセッションでは、次の通常の認可要求でユーザー選択をやり直し、`prompt=none`では`login_required`を返します。そのユーザーの発行済み認可コード・Refresh Tokenの交換は`invalid_grant`になります。同じ`sub`を再作成すると、残存するセッションやGrantが再び利用される場合があります。

### OIDCクライアント

初期クライアントは次のとおりです。

| 項目                           | 既定値                             |
| ------------------------------ | ---------------------------------- |
| Public client                  | `mock-public-client`（secretなし） |
| Confidential client            | `mock-confidential-client`         |
| Confidential secret            | `mock-client-secret-change-me`     |
| Redirect URI                   | `http://localhost:3000/callback`   |
| Access token audience/resource | `urn:mock-api`                     |

全clientでAuthorization Code FlowとS256 PKCEが必須です。Discovery、issuer、audience、期限、署名、JWKS、redirect URI、client IDの検証を無効化せず利用してください。

- **設定項目**: Client ID、Public/Confidential種別、secret、Token Endpoint認証方式（Publicは`none`、Confidentialは`client_secret_basic`または`client_secret_post`）、Redirect URI、Post Logout Redirect URI、Access Token Audience、Access Tokenの`scp`（委任scope名）、emailのoptional claim化。
- `accessTokenScope`と`emailOptionalClaim`はAdmin API（`POST`/`PUT /__mock/api/clients`）では必須項目です。Admin UIでは新規作成時に`accessTokenScope`へ`access_as_user`が初期値として入力されています。
- **標準OIDC scope**: `openid`, `profile`, `email`, `offline_access`は全クライアントで利用できます。これらはEntra IDのアプリ登録項目ではなく、アプリケーションが認可リクエストの`scope`パラメーターで要求します。`offline_access`を要求するとRefresh Tokenが発行されます。`email`の扱いは[トークンのclaim](#トークンのclaim)を参照してください。
- **対象外**: Access Tokenの`scp` claimはクライアントごとに設定した単一の委任scope名をそのまま返すだけの簡易モデルです。Microsoft Graphや独自Web APIの複数permissionの管理、admin consent、Expose an APIの管理UIは対象外です。

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
    "emailOptionalClaim":false
  }'

curl --cacert "$CURL_CA" -X POST https://mock-idp.test:9000/__mock/api/clients/reset \
  -H 'content-type: application/json' \
  -d '{}'
```

### テストユーザー

初期ユーザーは次のとおりです。`tid`は常にこのMockのTenant IDです。

| sub                 | 表示名            | username                   | oid                                    | groups                                    |
| ------------------- | ----------------- | -------------------------- | -------------------------------------- | ----------------------------------------- |
| `user-admin`        | Admin User        | `admin@example.com`        | `11111111-1111-1111-1111-111111111111` | `app-admin-group-id`, `app-user-group-id` |
| `user-normal`       | Normal User       | `user@example.com`         | `22222222-2222-2222-2222-222222222222` | `app-user-group-id`                       |
| `user-unauthorized` | Unauthorized User | `unauthorized@example.com` | `33333333-3333-3333-3333-333333333333` | なし                                      |

| 項目                 | 内容                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sub`                | ユーザーの識別子。サインイン画面の選択値とトークンの`sub`になる。Admin UIでは新規作成時にランダムなUUIDが初期値として入力され、保存前は編集できる。空欄で保存した場合やAdmin APIで省略した場合は、サーバー側でランダムなUUIDを一度だけ生成して保存する |
| `oid`                | GUID形式。小文字に正規化して保存する。Admin UIでは新規作成時にランダムなUUIDが初期値として入力され、編集できる                                                                                                                                         |
| `name`               | 表示名                                                                                                                                                                                                                                                 |
| `preferred_username` | UPN相当の値                                                                                                                                                                                                                                            |
| `mail`               | メール形式。`email` claimとして返される                                                                                                                                                                                                                |
| `groups`             | Admin UIでは1行に1件、Admin APIでは文字列配列。重複は除去され、空も指定できる                                                                                                                                                                          |

- `name`・`preferred_username`・各グループ名は前後の空白を除去し、内部の改行（CR/LF）を拒否します。日本語などのUnicodeや内部の空白は保持します。
- `oid`と`preferred_username`はユーザー間で重複できません（`preferred_username`は大文字小文字を区別しません）。
- `tid`は設定項目ではありません。`users.json`に`tid`を含めると起動時に検証エラーになります。
- Admin APIでは作成時（`POST /__mock/api/users`）は`sub`以外の全項目、更新時（`PUT /__mock/api/users/:sub`）は全項目が必須です。
- エラーは`invalid_user`（400）、`user_conflict`（409）、`user_not_found`（404）で返します。

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

- **ID token・Access Token共通**: `sub`, `oid`, `tid`, `name`, `preferred_username`, `groups`, `iss`, `aud`, `iat`, `exp`, `nbf`, `ver`, `sid`
- **Access Tokenのみ**: `azp`（client_id）、`azpacr`（クライアント認証方式。publicクライアントは`0`、client secretで認証するconfidentialクライアントは`1`）、`scp`（クライアント設定の委任scope名）
- **`email`**: ユーザーの`mail`の値です。`email` scopeを要求した場合、またはクライアント設定で「emailをoptional claimとして常に含める」を有効にした場合（Entra IDの[optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims)機能に相当）だけ含まれます。表示・連絡先用途とし、ユーザー識別には`oid`と`tid`の組または`sub`を使用してください。
- `mail` claimは含みません。Microsoft Graphのユーザープロパティ名であり、Entra IDのトークンclaimには存在しないためです。
- Access TokenのJWTヘッダーは`typ:"at+jwt"`です。**既知の制限**として、ID Tokenには実際のEntra IDが付与する`typ:"JWT"`を設定していません（`oidc-provider`にID Token用のヘッダーカスタマイズ機構がなく、OIDC/JWT仕様上も`typ`はOPTIONALでMSAL等の検証対象にもならないため見送っています）。

## シナリオ API

issuerがpath付きの場合も、Admin APIのbase URLにはoriginだけを指定します。

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

- **`CONTINUOUS`**: 解除またはResetまで対象要求すべてへFaultを適用します。
- **`LIMITED`**: 1以上の`failureCount`が必須で、対象endpointへ到達した要求だけを同期的に消費します。最後の対象要求にもFaultを返し、その後の現在状態はNORMALになります。Timeoutも遅延開始時にcountを消費し、クライアントが切断しても戻しません。
- **単一のグローバル状態**: シナリオstoreはプロセス全体で共有され、`client_id`やredirect_uri、セッション単位のスコープを持ちません。シナリオをarmedにしてから対象の要求が到達するまでに、無関係な別の要求（並行実行中の別テスト・別アプリ、同一アプリのsilent SSO用iframeなどによる認可endpointへの`GET`要求）が先に到達するとそちらがFaultを消費し、意図した対象には何も起こらない一方で無関係な相手にerrorが返ることがあります。mockインスタンスは同時に1つの認可フローのみが進行する直列実行を前提とし、並列にテストを実行する場合はmock IdPインスタンスをテストワーカーごとに分離してください。

| シナリオ                                                                                                                 | 対象                                        | 動作                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `NORMAL`                                                                                                                 | なし                                        | Faultを適用しない                                                                                                                        |
| `ACCESS_DENIED`, `AUTH_LOGIN_REQUIRED`, `AUTH_INTERACTION_REQUIRED`, `AUTH_TEMPORARILY_UNAVAILABLE`, `AUTH_SERVER_ERROR` | Authorization OAuth                         | それぞれ`access_denied`, `login_required`, `interaction_required`, `temporarily_unavailable`, `server_error`を検証済みredirect URIへ返す |
| `AUTH_STATE_MISMATCH`                                                                                                    | Authorization response                      | 成功応答の`state`を固定のダミー値`mock-mismatched-state`に置換する                                                                       |
| `AUTH_STATE_MISSING`                                                                                                     | Authorization response                      | 成功応答から`state`を削除する                                                                                                            |
| `AUTH_CODE_INVALID`                                                                                                      | Authorization response                      | 成功応答の`code`を無効なランダム値に置換する。そのcodeでToken交換すると`invalid_grant`になる                                             |
| `AUTH_CODE_MISSING`                                                                                                      | Authorization response                      | 成功応答から`code`を削除する（`error`も付けない）                                                                                        |
| `AUTH_CODE_WITH_ERROR`                                                                                                   | Authorization response                      | 成功応答の`code`を残したまま`error=server_error`と`error_description`を追加する                                                          |
| `AUTH_400`                                                                                                               | `HEAD` Connectivity Probe                   | HTTP 400を本文なしで返す                                                                                                                 |
| `AUTH_429`, `AUTH_500`                                                                                                   | `HEAD` Connectivity Probe                   | HTTP 429/500と任意の`Retry-After`を本文なしで返す                                                                                        |
| `AUTH_TIMEOUT`                                                                                                           | `HEAD` Connectivity Probe                   | 指定時間遅延してからHTTP 200を返す                                                                                                       |
| `NO_GROUPS`                                                                                                              | ID/access token claim生成                   | `groups` claimを（空配列ではなく）完全に削除する。ID Token・Access Tokenの両方が対象                                                     |
| `WRONG_AUDIENCE`                                                                                                         | ID/access token                             | 正常鍵で署名し、`aud`を実際の`client_id`とは無関係な固定のダミー値に変更する                                                             |
| `WRONG_ISSUER`                                                                                                           | ID/access token                             | 正常鍵で署名し、`iss`を実際のissuerとは異なる固定のダミー値に変更する                                                                    |
| `WRONG_TENANT`                                                                                                           | ID/access token                             | 正常鍵で署名し、`tid`と`iss`内のtenant IDを固定の別テナント`ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb`へ変更する                              |
| `EXPIRED_TOKEN`                                                                                                          | ID/access token                             | 正常鍵で署名し、`exp`をparameter `expiredAgoSeconds`秒だけ過去、`iat`/`nbf`をそこからさらに1時間前に設定する（3者の前後関係は維持）      |
| `FUTURE_NBF`                                                                                                             | ID/access token                             | 正常鍵で署名し、`nbf`をparameter `nbfAheadSeconds`秒だけ未来（ただし`exp`の1秒前を超えない）に設定する                                   |
| `MISSING_CLAIM`                                                                                                          | ID/access token                             | 正常鍵で署名し、parameter `claim`で指定したclaimを削除する                                                                               |
| `INVALID_SIGNATURE`                                                                                                      | ID/access token                             | 非公開Key Bで署名し、公開Key Aの`kid`を設定                                                                                              |
| `UNKNOWN_KID`                                                                                                            | ID/access token                             | Key Aで署名し、JWKSにない`kid`を設定                                                                                                     |
| `ALG_NONE`                                                                                                               | ID/access token                             | headerを`alg: none`（`kid`なし）にし、署名部を空にした未署名JWTを返す                                                                    |
| `SIGNING_KEY_ROLLOVER`                                                                                                   | Token/JWKS                                  | 新しい鍵で署名し、旧鍵と新鍵をJWKSへ公開                                                                                                 |
| `NONCE_MISMATCH`                                                                                                         | ID token                                    | 正常鍵で署名し、`nonce`を固定のダミー値`mock-mismatched-nonce`に変更する。Access Tokenは改変しない                                       |
| `NONCE_MISSING`                                                                                                          | ID token                                    | 正常鍵で署名し、`nonce`を削除する。Access Tokenは改変しない                                                                              |
| `TOKEN_NO_ID_TOKEN`                                                                                                      | `POST` Token                                | HTTP 200のToken responseから`id_token`を削除する                                                                                         |
| `TOKEN_400`                                                                                                              | `POST` Token                                | 設定可能なOAuth errorをHTTP 400で返す                                                                                                    |
| `TOKEN_429`, `JWKS_429`, `DISCOVERY_429`                                                                                 | `POST` Token / `GET` JWKS / `GET` Discovery | HTTP 429と任意の`Retry-After`を返す。JSON本文の`error`は`temporarily_unavailable`、`error_description`に注入したScenario名を含む         |
| `TOKEN_500`, `JWKS_500`, `DISCOVERY_500`                                                                                 | `POST` Token / `GET` JWKS / `GET` Discovery | HTTP 500と任意の`Retry-After`を返す。JSON本文の`error`は`server_error`、`error_description`に注入したScenario名を含む                    |
| `TOKEN_TIMEOUT`, `JWKS_TIMEOUT`, `DISCOVERY_TIMEOUT`                                                                     | `POST` Token / `GET` JWKS / `GET` Discovery | 指定時間遅延してから通常処理を続行                                                                                                       |
| `JWKS_INVALID`                                                                                                           | `GET` JWKS                                  | HTTP 200で、`keys`に1件だけ含むがRSA鍵として必須の`n`/`e`を欠いた不完全なkeyオブジェクトを返す（配列自体は空にしない）                   |

### Parameters

| Parameter                   | 対象シナリオ     | 値                                                                                                                                                               |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retryAfterSeconds`         | `*_429`, `*_500` | 1以上のsafe integer。任意で、指定した場合だけ`Retry-After`を返す                                                                                                 |
| `delayMs`                   | `*_TIMEOUT`      | 1〜300,000ms。未指定時は30,000ms                                                                                                                                 |
| `expiredAgoSeconds`         | `EXPIRED_TOKEN`  | 1〜31,536,000（365日）の整数。未指定時は600秒。既定値はSpring Security（60秒）や.NET（300秒）の既定のclock skew許容を超える                                      |
| `nbfAheadSeconds`           | `FUTURE_NBF`     | 1〜3,599の整数（ID/Access TokenのTTL 3,600秒未満）。未指定時は600秒。既定値の理由は`expiredAgoSeconds`と同じ                                                     |
| `claim`                     | `MISSING_CLAIM`  | `sub`、`oid`、`tid`、`iss`、`aud`、`exp`、`iat`のいずれか。未指定時は`sub`                                                                                       |
| `error`, `errorDescription` | `TOKEN_400`      | `error`未指定時は`invalid_grant`。`error_description`は`errorDescription`を指定した場合だけ含める。`AUTH_400`で指定するとAdmin APIが`400 invalid_scenario`を返す |

Connectivity Probe Faultは`HEAD`、Token Faultは`POST`、JWKS/Discovery Faultは`GET`だけが対象です。対象外endpoint、異なるmethod、`OPTIONS`はLIMITED countを消費しません。Authorization endpointはHTTP faultの対象外です。

### OAuth redirect errorとConnectivity ProbeのHTTP fault

両者は別の障害です。前者は通常の認証要求そのもの（アプリケーションのcallbackへ届くOAuth response）に、後者は認証を始める前の到達性確認（クライアントとMicrosoft Entra IDとの間の接続性の問題）に作用します。そのため`AUTH_SERVER_ERROR`と`AUTH_500`、`AUTH_TEMPORARILY_UNAVAILABLE`と`AUTH_429`は統合しません。

- **OAuth redirect error**（`ACCESS_DENIED`, `AUTH_LOGIN_REQUIRED`, `AUTH_INTERACTION_REQUIRED`, `AUTH_TEMPORARILY_UNAVAILABLE`, `AUTH_SERVER_ERROR`）: Authorization requestをProviderが検証した後、OAuth errorと元の`state`を登録済みredirect URIへ返します。`response_mode=query`と`form_post`はProviderの標準処理に従います。`error_description`はシナリオ名ではなく固定の説明文（例: "Login required by mock scenario"）です。
- **Connectivity Probe fault**（`AUTH_400`, `AUTH_429`, `AUTH_500`, `AUTH_TIMEOUT`）: `HEAD .../common/oauth2/v2.0/authorize`だけに作用します。正常時のEntraはこのプローブへHTTP 200を返すので、Mockも既定では200を返し、Scenario適用時だけ400、429、500、遅延を再現します（`AUTH_TIMEOUT`は待機後に通常どおり200）。`HEAD`は本文を持てないためHTTP statusとheaderだけを返し、`content-type`は正常時の200と同じ`text/html; charset=utf-8`です。`AUTH_400`が`TOKEN_400`と違い`error`・`errorDescription`を受け付けないのもこのためです。通常の認証要求には一切影響せず、`AUTH_500`をCONTINUOUSで有効にしていても`GET {tenant}/oauth2/v2.0/authorize`は通常のAuthorization処理を続け、LIMITED countも消費しません。

### 認証応答の不正

`AUTH_STATE_*`, `AUTH_CODE_*`, `NONCE_*`, `ALG_NONE`, `WRONG_TENANT`, `MISSING_CLAIM`, `TOKEN_NO_ID_TOKEN`は、IdPから届いた不正な認証応答をRPが拒否できるかを試験するシナリオです。ブラウザを介したE2Eではテスト側からredirectやトークンを書き換えにくいため、Mock側で注入します。

- `AUTH_STATE_*`と`AUTH_CODE_*`は、Providerが成功応答を組み立てた後、送信する直前のパラメータを書き換えます（oidc-providerの`authorization.success`）。`response_mode=query`と`form_post`のどちらにも作用し、LIMITED countは成功応答を返す要求（ログイン後の`.../authorize/{uid}`）でだけ消費されます。interactionへのredirectやOAuth error応答では消費しません。グローバル状態のため、無関係な認可フローが先に成功応答を受け取るとそちらがFaultを消費します。
- `AUTH_CODE_INVALID`と`AUTH_CODE_MISSING`でも、実際に発行されたcodeは使われないままAuthorization CodeのTTL（600秒）で失効します。
- `AUTH_CODE_WITH_ERROR`を`response_mode=form_post`で使うと、自動送信フォームはHTTP 400で返ります（oidc-providerは`error`を含むform_post応答を400にするため）。`query`では通常どおり303のredirectです。
- `NONCE_*`, `ALG_NONE`, `WRONG_TENANT`, `MISSING_CLAIM`, `TOKEN_NO_ID_TOKEN`は他のToken改変系と同じく、refresh_token grantを含むすべての成功したToken応答に作用します。LIMITEDで使う場合は、silent refreshが先にFaultを消費しないよう注意してください。
- `NONCE_*`はID Tokenに`nonce`がある応答（認可要求で`nonce`を送った場合）だけ、`TOKEN_NO_ID_TOKEN`は`id_token`を含む応答だけに作用します。それ以外の応答は改変せず、LIMITED countも消費しません。
- `WRONG_TENANT`は`iss`と`tid`の整合を保ったまま別テナントのトークンに見せかけるもので、`iss`だけを無関係な値にする`WRONG_ISSUER`とは区別します。

### 回復試験

Mock自身は待機や再試行を行いません。Microsoft Entraの[クライアントアプリケーションの回復性](https://learn.microsoft.com/en-us/entra/architecture/resilience-client-app)と[MSALのthrottling例](https://learn.microsoft.com/en-us/entra/msal/dotnet/advanced/client-and-server-throttling)に合わせ、特定のAADSTS番号には依存せず、次のクライアント動作を試験することを想定しています。

- 429と5xxのどちらも、`Retry-After`があればそれが終わるまで再取得せず、なければ指数バックオフする。Timeoutでも即時再試行を避ける。
- `prompt=none`で`login_required`または`interaction_required`を受けたら、同じsilent requestを繰り返さずinteractive authenticationへ切り替える。[Authorization endpointのエラー](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-codes-for-authorization-endpoint-errors)は検証済みredirect URIだけへ返します。

### Provider標準機能との責務分離

通常の入力で再現できるOAuth protocol validationはScenarioとして重複実装せず、`oidc-provider`自身のAuthorization Code lifecycle、PKCE、client authentication、redirect URI検証を利用します。対象は次のケースです。

- 正常なAuthorization Code FlowとPKCE
- 不正・期限切れ・再利用済みAuthorization Codeによる`invalid_grant`
- 不一致の`code_verifier`による`invalid_grant`
- 不正なconfidential client secretによる`invalid_client`
- Token交換時の`redirect_uri`不一致による`invalid_grant`

このため`AUTH_CODE_EXPIRED`, `AUTH_CODE_REUSED`, `PKCE_MISMATCH`, `INVALID_CLIENT`, `REDIRECT_URI_MISMATCH`という専用Scenarioはありません。PKCE失敗をIdP側から再現したい場合や任意のToken endpoint errorが必要な場合は、`TOKEN_400`（既定の`error`は`invalid_grant`）をescape hatchとして使用してください（`AUTH_400`は本文を持てないためこの用途には使えません）。例えばAADSTS50196のloop検出は次のように再現できます。

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

- `JWKS_INVALID`、`UNKNOWN_KID`、`SIGNING_KEY_ROLLOVER`は、Microsoft Entraの[signing key rollover guidance](https://learn.microsoft.com/en-us/entra/identity-platform/signing-key-rollover#best-practices-for-keys-metadata-caching-and-validation)にある、複数鍵の保持、未知の`kid`でのmetadata再取得、不正なkey metadata受信時のlast-known-good継続を試験するためのシナリオです。
- `SIGNING_KEY_ROLLOVER`で公開した新しい鍵は、シナリオ完了、NORMALへの変更、別Scenarioへの切り替え後もJWKSに残り、Reset時だけ初期鍵へ戻ります。

### シナリオの追加

`src/scenario/types.ts`に名前・入力型を、`src/scenario/registry.ts`に対象endpoint、effect、parameter/UI metadataを追加します。実装は責務ごとに、HTTP Faultは`src/faults/http-fault.ts`、認可応答の改変は`src/faults/authorization-fault.ts`、claim生成は`src/oidc/provider.ts`、意図的なJWT異常は`src/faults/token-generator.ts`へ行い、Store・Integration Testを追加してください。

## アクセスログ

Mock IdPが受け付けたリクエストを、そのとき有効だったシナリオと紐づけて記録します。Admin UIの「アクセスログ」カードで新しい順に一覧でき、障害を注入した行は「適用」の表示と赤い背景で区別されます。アプリケーション側で認証を試した後にこの一覧を再読み込みすると、どの要求が届き、どのシナリオが実際に作用したかを確認できます。

- **記録対象**: `/__mock`配下（Admin UI/Admin API）、`/health`、ブラウザが管理画面やサインイン画面を開いたときに自動的に要求する`/favicon.ico`以外のすべてのリクエストです。Host不一致で`400 invalid_request_origin`になった要求も記録されます。
- **分類**: Discovery、Authorization、サインイン画面（interaction）、Token、JWKS、Logout、Connectivity Probe（`HEAD .../common/oauth2/v2.0/authorize`のみ）に分類し、それ以外のpath（typo、未対応の`common`/`organizations` authorityへの要求など）は`other`として残します。
- **記録内容**: pathnameだけです。`code`、`client_secret`、`code_verifier`などを残さないため、query、リクエスト本文、ヘッダーは記録しません。
- **保持**: 最新200件をプロセスのメモリ上に保持し、超過分は古い順に破棄します。永続化せず、再起動で消えます。
- **Admin UI**: 自動更新しません。「アクセスログを再読み込み」で最新の状態を取得し、「アクセスログをクリア」で全件削除します。シナリオの「初期状態に戻す」（`POST /__mock/api/reset`）ではアクセスログは消えません。シナリオ以外のカードは見出しのクリックで折りたためます。初回表示では折りたたまれており、開閉状態はブラウザに保存されます。

```bash
curl --cacert "$CURL_CA" "$MOCK_ORIGIN/__mock/api/access-log"
curl --cacert "$CURL_CA" -X DELETE "$MOCK_ORIGIN/__mock/api/access-log"
```

`GET`は受付の新しい順の配列を返し、`DELETE`は204を返します。各エントリの項目は次のとおりです。

| 項目         | 内容                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | 受付順にプロセス内で単調増加する番号（応答完了順ではない）。クリアしてもリセットしない                                                             |
| `receivedAt` | 受付時刻（ISO 8601）                                                                                                                               |
| `method`     | HTTP method                                                                                                                                        |
| `path`       | pathname（queryを含まない）                                                                                                                        |
| `endpoint`   | `discovery`, `authorization`, `interaction`, `token`, `jwks`, `logout`, `connectivity-probe`, `other`のいずれか                                    |
| `statusCode` | 返したHTTP status。応答を返す前にクライアントが切断した場合は`null`（Timeout系シナリオでクライアントが先に諦めたケースの確認に使える）             |
| `durationMs` | 受付から応答完了（または切断）までのミリ秒                                                                                                         |
| `scenario`   | 受付時に有効だったシナリオ名。`NORMAL`を含む。対象外endpointへの要求やHost不一致などで作用しなかった場合も、有効だったシナリオ名がそのまま入る     |
| `fault`      | この要求が実際に消費したFault。`scenario`, `endpoint`, `mode`, `parameters`, `remainingBefore`, `remainingAfter`を含む。作用しなかった場合は`null` |

`scenario`と`fault`の違いが「シナリオは有効だったが作用しなかった要求」の切り分けに役立ちます。

- `TOKEN_500`を有効にした状態でJWKSを取得すると`scenario: "TOKEN_500"`かつ`fault: null`になり、Tokenへ`POST`すると`fault.scenario: "TOKEN_500"`が入ります。`LIMITED`では`remainingBefore`と`remainingAfter`で消費されたcountを追えます。
- Authorization系のOAuth redirect errorは、最初の`GET .../authorize`の行にFaultが付き、続くサインイン画面と`.../authorize/{uid}`への再開要求は`fault: null`のまま記録されます。
- `AUTH_STATE_*`や`AUTH_CODE_*`などのAuthorization response系は、成功応答を返した行にFaultが付きます。通常はサインイン後の`.../authorize/{uid}`、既存セッションがある場合は最初の`.../authorize`の行です。

## 鍵と状態

署名鍵は通常鍵、rollover鍵、異常署名鍵の3種を初回起動時に`.data/keys`へ生成し、秘密鍵ファイルは0600で保存します。鍵ディレクトリを削除すると再生成されます。JWKSには既定で通常鍵の公開部分だけを掲載し、`SIGNING_KEY_ROLLOVER`の適用後は通常鍵とrollover鍵の2つを掲載します。

| 保存先                       | 内容                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `.data/`（Git対象外）        | 署名鍵（`keys`）、TLS証明書（`tls`、`tls-private`）、OIDC Client（`clients.json`）、テストユーザー（`users.json`） |
| 単一プロセスのインメモリ実装 | OIDC artifact（認可コード、session等）、シナリオストア（シナリオ履歴）、アクセスログ。再起動で失われる             |

## 開発コマンド

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build:check
```

整形の適用は`npm run format`です。
