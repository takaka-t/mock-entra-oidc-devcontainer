import { accessLogCapacity } from "../access-log/store.js";
import { scenarioUiDefaults, scenarioUiMetadata } from "../scenario/registry.js";
import { escapeHtml } from "./html.js";
import { maxIdentifierLength } from "../validation/common.js";

// Match the normalized length while allowing leading/trailing ASCII spaces.
const identifierInputPattern = ` *(?!\\.{1,2} *$)[!-~](?:[ -~]{0,${maxIdentifierLength - 2}}[!-~])? *`;
const identifierHint = `前後の空白を除いて1〜${maxIdentifierLength}文字の印字可能ASCIIで入力してください。「.」「..」は使用できません。`;

const options = Object.keys(scenarioUiMetadata)
  .map((name) => `<option value="${name}">${name}</option>`)
  .join("");
const uiMetadata = JSON.stringify(scenarioUiMetadata).replaceAll("<", "\\u003c");
const uiDefaults = JSON.stringify(scenarioUiDefaults);

export function renderAdminHtml(tenantId: string, issuer: string, logoutUrl: string): string {
  const connectionValues = JSON.stringify({
    authorityUrl: issuer,
    tenantId,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock OIDC Provider 管理画面</title><style>
:root{font-family:ui-sans-serif,system-ui;color:#16202a;background:#eef2f6}body{margin:0;padding:.75rem}.wrap{max-width:1040px;margin:auto}
h1{margin:0 0 .5rem;font-size:1.25rem}.card{background:white;border-radius:10px;padding:.75rem;margin:.5rem 0;box-shadow:0 2px 12px #18324b18}.card h2{margin:0 0 .5rem;font-size:1.05rem}
.state{border-left:8px solid #159957}.state.fault{border-color:#d33b32}.state-header{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.5rem}.state-header h2{margin:0}.state-tools{display:flex;align-items:center;gap:.5rem;flex-shrink:0}.scenario-form{margin-top:.5rem;padding-top:.5rem;border-top:1px solid #d9e0e7}.state-current{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.25rem;min-width:0;padding:.5rem .75rem;background:#f8fafc;border-radius:8px}.state-now{flex:1 1 12rem;min-width:0}.state-current .state-now .value{font-size:1.1rem}.state-grid{flex:3 1 28rem}.state-details-title{margin:0 0 .35rem;font-size:.8rem;color:#475569}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.5rem .75rem}.state-grid{grid-template-columns:repeat(auto-fit,minmax(105px,1fr))}.state-grid>div{min-width:0}.state .value,.history-value{min-width:0;overflow-wrap:anywhere;word-break:break-word}.history{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .5rem;margin-top:.5rem;padding-top:.5rem;border-top:1px solid #d9e0e7}.history .value{margin-top:0}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:0 .75rem;align-items:start}.contents{display:contents}
.label{font-size:.7rem;color:#64748b}.value{font-size:1rem;font-weight:700;margin-top:.1rem}label{display:block;margin:.4rem 0 .15rem}label.required::after{content:" *";color:#b42318;font-weight:700}
select,input,textarea,button{font:inherit;padding:.4rem .5rem;border:1px solid #bdc7d3;border-radius:6px}select,input,textarea{width:100%;box-sizing:border-box}input[type=checkbox]{width:auto;padding:0}textarea{min-height:4rem}button{cursor:pointer;font-weight:650}.primary{background:#1261a0;color:white}.danger{background:#b42318;color:white}.actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start;margin-top:.5rem}.action{display:grid;gap:.15rem}.action-hint{margin:0;max-width:15rem;color:#64748b;font-size:.7rem}.action-hint.danger-hint{color:#b42318}.icon-button{display:grid;place-items:center;width:2.1rem;height:2.1rem;padding:0}.icon-button svg{width:1.1rem;height:1.1rem}.connection-value{display:flex;align-items:center;gap:.4rem;min-width:0}.connection-value code{min-width:0;overflow-wrap:anywhere}.token-label{display:flex;align-items:center;justify-content:space-between;gap:.5rem}.token-label label{margin:0}.hidden{display:none}.error,.warning{color:#b42318;white-space:pre-wrap}.error{margin:.5rem 0 0}.error:empty{margin:0}.field-error{color:#b42318;font-size:.85rem;margin:.25rem 0}.error-summary:not(:empty){border:1px solid #b42318;background:#fff1f0;padding:.75rem;border-radius:6px;margin:.75rem 0}.error-summary ul{margin:.35rem 0 0;padding-left:1.25rem}.error-link{padding:0;border:0;background:none;color:inherit;text-align:left;text-decoration:underline;font-weight:400}[aria-invalid="true"]{border-color:#b42318;outline:1px solid #b42318}.warning{margin:.5rem 0}.hint{margin:.2rem 0 0;color:#64748b;font-size:.8rem}#testLogout{display:inline-block;padding:.4rem .5rem;border:1px solid #bdc7d3;border-radius:6px;text-decoration:none;color:inherit;font-weight:650}
dialog.editor{box-sizing:border-box;width:min(42rem,calc(100% - 2rem));max-height:calc(100dvh - 2rem);margin:auto;padding:1.25rem;border:0;border-radius:12px;color:inherit;background:white;overflow:auto;box-shadow:0 12px 40px #18324b40}dialog.editor::backdrop{background:#16202a80}.editor-header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.editor-header h2{margin:0;font-size:1.2rem}.editor-header button{flex-shrink:0}.editor form>.actions{position:sticky;bottom:-1.25rem;background:white;padding:.75rem 0}.editor .error,.notice{overflow-wrap:anywhere}.notice-stack{position:fixed;top:1rem;right:1rem;z-index:1000;display:flex;flex-direction:column;gap:.5rem;width:min(26rem,calc(100% - 2rem));max-height:calc(100dvh - 2rem);overflow:auto;pointer-events:none}.notice{display:flex;flex-shrink:0;box-sizing:border-box;pointer-events:auto;align-items:flex-start;justify-content:space-between;gap:.75rem;width:100%;padding:.75rem;border:1px solid #159957;border-radius:8px;background:#edf9f1;color:#14532d;box-shadow:0 8px 24px #18324b40}.notice.error-notice{border-color:#b42318;background:#fff1f0;color:#b42318}.notice.hidden{display:none}.notice p{margin:0;min-width:0}.notice button{flex-shrink:0}button:disabled{cursor:wait;opacity:.65}
details.card>summary{display:flex;align-items:center;gap:.5rem;cursor:pointer;list-style:none}details.card>summary::-webkit-details-marker{display:none}details.card>summary::before{content:"";flex-shrink:0;width:.5rem;height:.5rem;margin:0 .2rem 0 .1rem;border-right:2px solid #475569;border-bottom:2px solid #475569;transform:rotate(-45deg);transition:transform .15s}details.card[open]>summary::before{transform:rotate(45deg)}details.card>summary h2{margin:0}details.card[open]>summary{margin-bottom:.5rem}.count{font-weight:400;font-size:.85rem;color:#64748b}
.table-wrap{max-width:100%;overflow-x:auto}.list-table{min-width:36rem}.log-wrap{max-height:min(28rem,55vh);overflow:auto;margin-top:.5rem}.data-table{width:100%;border-collapse:collapse;font-size:.85rem}.data-table th,.data-table td{padding:.3rem .5rem;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}.data-table th{position:sticky;top:0;z-index:1;background:white;font-size:.7rem;font-weight:600;color:#64748b}.data-table td{min-width:0;overflow-wrap:anywhere}.data-table code{overflow-wrap:anywhere}.list-table td.ops{width:1%;white-space:nowrap}.list-table .actions{margin-top:0;flex-wrap:nowrap}.log-table th,.log-table td{white-space:nowrap}.log-table td.path{min-width:12rem;white-space:normal;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.log-table td.scenario{min-width:14rem;white-space:normal;overflow-wrap:anywhere}.log-table tr.injected{background:#fff1f0}.status-ok{color:#159957;font-weight:700}.status-error{color:#b42318;font-weight:700}.muted{color:#64748b}
.permission-fields{margin:1rem 0;padding:.75rem;border:1px solid #bdc7d3;border-radius:8px;min-width:0}.permission-fields>legend{padding:0 .25rem;font-weight:650}.permission-picker{margin-top:.75rem;padding:.75rem;border:1px solid #d9e0e7;border-radius:6px;background:#f8fafc}.permission-fields .data-table{margin:.5rem 0}.permission-fields code{font-size:.75rem}.permission-api-id{font-size:.75rem;color:#64748b}.permission-fields button:disabled{cursor:not-allowed}.claim-fields{margin:1rem 0;padding:.75rem;border:1px solid #bdc7d3;border-radius:8px;min-width:0}.claim-fields>legend{padding:0 .25rem;font-weight:650}.claim-fields label+.hint{margin-left:1.5rem}.redirect-fields{margin:1rem 0;padding:.75rem;border:1px solid #bdc7d3;border-radius:8px;min-width:0}.redirect-fields>legend{padding:0 .25rem;font-weight:650}.redirect-fields>legend::after{content:" *";color:#b42318}#clientForm:not([aria-busy="true"]) .redirect-fields button:disabled{cursor:not-allowed}.redirect-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem;align-items:end;margin-bottom:.5rem}.redirect-row>div{min-width:0}.redirect-row label{font-size:.8rem}.platform-summary+.platform-summary{margin-top:.5rem}
</style></head><body><main class="wrap"><h1>Mock OIDC Provider 管理画面</h1>
<div id="notices" class="notice-stack"><div id="copyNotice" class="notice hidden"><p id="copyMessage" role="status" aria-atomic="true"></p><button id="dismissCopyNotice" type="button" aria-label="コピーの通知を閉じる">閉じる</button></div><div id="scenarioNotice" class="notice hidden"><p id="scenarioMessage" role="status" aria-atomic="true"></p><button id="dismissScenarioNotice" type="button" aria-label="シナリオの通知を閉じる">閉じる</button></div>
<div id="accessLogNotice" class="notice hidden"><p id="accessLogMessage" role="status" aria-atomic="true"></p><button id="dismissAccessLogNotice" type="button" aria-label="アクセスログの通知を閉じる">閉じる</button></div>
<div id="userNotice" class="notice hidden"><p id="userMessage" role="status" aria-atomic="true"></p><button id="dismissUserNotice" type="button" aria-label="テストユーザーの通知を閉じる">閉じる</button></div>
<div id="clientNotice" class="notice hidden"><p id="clientMessage" role="status" aria-atomic="true"></p><button id="dismissClientNotice" type="button" aria-label="OIDC クライアントの通知を閉じる">閉じる</button></div>
<div id="resourceNotice" class="notice hidden"><p id="resourceMessage" role="status" aria-atomic="true"></p><button id="dismissResourceNotice" type="button" aria-label="APIの通知を閉じる">閉じる</button></div></div>
<details class="card" id="connectionPanel"><summary><h2>アプリ接続情報</h2></summary><div class="grid"><div><div class="label">認可サーバー URL（Authority URL）</div><div class="connection-value"><code id="authorityUrl">${escapeHtml(issuer)}</code><button id="copyAuthority" class="icon-button" type="button" aria-label="認可サーバー URL（Authority URL）をコピー" title="認可サーバー URL（Authority URL）をコピー"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button></div></div><div><div class="label">テナント ID（tid）</div><div class="connection-value"><code id="tenantId">${escapeHtml(tenantId)}</code><button id="copyTenantId" class="icon-button" type="button" aria-label="テナント ID（tid）をコピー" title="テナント ID（tid）をコピー"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button></div></div></div></details>
<section id="state" class="card state"><div class="state-header"><h2>シナリオ</h2><div class="state-tools"><a id="testLogout" href="${escapeHtml(logoutUrl)}" target="_blank" rel="noopener noreferrer" title="ブラウザに保持された Mock IdP のセッションでログアウト（RP-Initiated Logout）画面の動作を確認できます。">ログアウトをテスト</a><button id="refresh" class="icon-button" type="button" aria-label="状態を再読み込み" title="状態を再読み込み"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 16.24 7.76L13 11h7V4z"/></svg></button></div></div><div class="state-current"><div class="state-now"><div class="label">現在のシナリオ</div><div id="current" class="value">読み込み中…</div></div><div class="grid state-grid" role="group" aria-label="実行状況">
<div><div class="label">状態</div><div id="status" class="value">—</div></div><div><div class="label">実行モード</div><div id="currentMode" class="value">—</div></div>
<div><div class="label">設定した失敗回数</div><div id="initial" class="value">—</div></div><div><div class="label">残り失敗回数</div><div id="remaining" class="value">—</div></div>
<div><div class="label">発生回数</div><div id="triggered" class="value">0</div></div></div></div><div class="history"><div class="label">直近で完了したシナリオ</div><div id="history" class="value history-value">なし</div></div>
<form id="form" class="scenario-form"><h3 class="state-details-title">シナリオの設定</h3><div class="fields"><div id="scenarioField"><label for="scenario">シナリオ</label><select id="scenario">${options}</select><p class="hint">各シナリオの詳細は README の「シナリオ API」を参照してください。＊は必須項目です</p></div>
<div id="modeFields" class="contents"><div id="modeField"><label for="mode">実行モード</label><select id="mode"><option>CONTINUOUS</option><option>LIMITED</option></select></div>
<div id="countField" class="hidden"><label for="failureCount" class="required">失敗回数</label><input id="failureCount" type="number" min="1" step="1" value="1" required></div>
<div id="delayField" class="hidden"><label for="delayMs">遅延時間（ms）</label><input id="delayMs" type="number" min="1" max="${scenarioUiDefaults.maxDelayMs}" step="1" value="${scenarioUiDefaults.delayMs}"></div>
<div id="retryAfterField" class="hidden"><label for="retryAfter">Retry-After（秒、任意）</label><input id="retryAfter" type="number" min="1" step="1" placeholder="Retry-Afterヘッダーを付与しない"></div>
<div id="expiredAgoField" class="hidden"><label for="expiredAgoSeconds">期限切れからの経過時間（秒）</label><input id="expiredAgoSeconds" type="number" min="1" max="${scenarioUiDefaults.maxExpiredAgoSeconds}" step="1" value="${scenarioUiDefaults.expiredAgoSeconds}"></div>
<div id="nbfAheadField" class="hidden"><label for="nbfAheadSeconds">nbfを未来にずらす時間（秒）</label><input id="nbfAheadSeconds" type="number" min="1" max="${scenarioUiDefaults.maxNbfAheadSeconds}" step="1" value="${scenarioUiDefaults.nbfAheadSeconds}"></div>
<div id="claimField" class="hidden"><label for="claim">削除するclaim（claim）</label><select id="claim">${scenarioUiDefaults.missingClaims.map((claim) => `<option${claim === scenarioUiDefaults.missingClaim ? " selected" : ""}>${claim}</option>`).join("")}</select></div>
<div id="errorFields" class="hidden"><label for="errorCode">OAuth エラー（error）</label><input id="errorCode" value="${scenarioUiDefaults.tokenError}"><label for="errorDescription">エラーの説明（errorDescription）</label><input id="errorDescription"></div></div></div>
<p id="rolloverNote" class="warning">SIGNING_KEY_ROLLOVERを有効にすると、シナリオの完了後、NORMALに戻した後、または別のシナリオを選択した後も、新しい署名鍵はJWKSで公開され続けます。シナリオを初期状態に戻すと、初期の鍵セットに戻ります。</p>
<div class="actions"><button class="primary" type="submit">適用</button><div class="action"><button id="normal" type="button">NORMALに戻す</button><p class="action-hint">シナリオを停止します（履歴は残ります）</p></div><div class="action"><button id="reset" class="danger" type="button">シナリオを初期状態に戻す</button><p class="action-hint danger-hint">履歴と鍵の状態を初期化します</p></div></div><p id="error" class="error" aria-live="polite"></p></form></section>
<details class="card" id="tokenPanel"><summary><h2>アクセストークン発行</h2></summary>
<p class="hint">バックエンド API の動作確認用に、登録済みユーザーのアクセストークンを発行します。API 登録の対象API・バージョンと、クライアントに許可したスコープを使用します。有効期間は通常 3,600 秒です。</p>
<p class="hint">有効な JWT・claim 障害シナリオを適用します。ID Token 専用・HTTP・認可・Discovery・JWKS 障害は直接発行に適用しません。</p>
<form id="tokenForm"><div class="grid"><div><label for="tokenClient" class="required">クライアント</label><select id="tokenClient" required disabled><option value="">読み込み中…</option></select></div><div><label for="tokenUser" class="required">テストユーザー</label><select id="tokenUser" required disabled><option value="">読み込み中…</option></select></div></div>
<label for="tokenResource" class="required">対象 API</label><select id="tokenResource" required></select><label for="tokenScopes" class="required">スコープ（空白区切り）</label><input id="tokenScopes" required>
<div class="actions"><button id="issueToken" class="primary" type="submit" disabled>発行</button></div></form>
<p id="tokenChoicesError" class="error" role="alert"></p><p id="tokenError" class="error" role="alert"></p>
<div id="tokenResult" class="hidden"><p id="tokenSubject"></p><div class="token-label"><label for="issuedToken">アクセストークン</label><button id="copyToken" class="icon-button" type="button" disabled aria-label="アクセストークンをコピー" title="アクセストークンをコピー"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button></div><textarea id="issuedToken" rows="5" readonly spellcheck="false"></textarea><p id="tokenFault" aria-live="polite"></p></div>
</details>
<details class="card" id="accessLogPanel"><summary><h2>アクセスログ <span id="accessLogCount" class="count"></span></h2></summary>

<div class="actions"><button id="refreshAccessLog" type="button">アクセスログを再読み込み</button><div class="action"><button id="clearAccessLog" class="danger" type="button">アクセスログをクリア</button><p class="action-hint danger-hint">記録済みのアクセスログをすべて削除します（シナリオの状態は変わりません）</p></div></div>
<p class="hint">Mock IdP が受け付けた OIDC 関連リクエストの履歴です（新しい順。最新 ${accessLogCapacity} 件をメモリ上に保持し、再起動で消えます）。管理画面・管理 API へのアクセスと、query・本文・ヘッダーは記録しません。「シナリオ」列は受付時に有効だったシナリオで、実際に障害が注入された行は「適用」と赤い背景で示します。自動更新はしないため、再読み込みボタンで最新の状態を取得してください。</p>
<p id="accessLogError" class="error" role="alert"></p>
<div class="log-wrap"><table id="accessLog" class="data-table log-table"><thead><tr><th scope="col">時刻</th><th scope="col">メソッド</th><th scope="col">エンドポイント</th><th scope="col">パス</th><th scope="col">ステータス</th><th scope="col">所要時間</th><th scope="col">シナリオ</th></tr></thead><tbody id="accessLogRows"><tr><td colspan="7">読み込み中…</td></tr></tbody></table></div>
</details>
<details class="card" id="userPanel"><summary><h2>テストユーザー一覧 <span id="userCount" class="count"></span></h2></summary><p class="hint">サインイン画面に表示されるユーザーです。テナント ID（tid）は常にこの Mock の値になります。</p>
<p id="userError" class="error" role="alert"></p><button id="retryUsers" class="hidden" type="button">一覧を再読み込み</button>
<div id="users">読み込み中…</div><div class="actions"><button id="newUser" class="primary" type="button">テストユーザーを登録</button><button id="resetUsers" class="danger" type="button">テストユーザーを初期状態に戻す</button></div></details>
<dialog id="userEditor" class="editor" aria-labelledby="userEditorTitle"><div class="editor-header"><h2 id="userEditorTitle">テストユーザーを登録</h2><button id="closeUser" type="button" aria-label="テストユーザーのダイアログを閉じる">閉じる</button></div><form id="userForm" novalidate><div id="userEditorError" class="error error-summary" role="alert" tabindex="-1"></div>
<p class="hint">＊は必須項目です</p>
<label for="userSub">ユーザー内部 ID</label><input id="userSub" pattern="${escapeHtml(identifierInputPattern)}" title="${identifierHint}"><p class="hint">${identifierHint} 保存後は変更できません。未入力の場合はランダムな UUID を自動生成します。</p>
<label for="userOid" class="required">オブジェクト ID（oid）</label><input id="userOid" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" required><p class="hint">GUID形式で入力してください。</p>
<label for="userName" class="required">表示名（name）</label><input id="userName" required>
<label for="userPreferredUsername" class="required">優先ユーザー名（preferred_username）</label><input id="userPreferredUsername" required>
<label for="userMail">メールアドレス（mail）</label><input id="userMail" type="email"><p class="hint">email claim（email）として返されます。</p>
<label for="userGroups">グループ（groups）</label><textarea id="userGroups"></textarea><p class="hint">セキュリティグループのオブジェクト ID（GUID）を1行に1件入力してください。</p>
<div class="actions"><button id="saveUser" class="primary" type="submit">登録</button><button id="cancelUser" type="button">キャンセル</button></div></form></dialog>
<details class="card" id="clientPanel"><summary><h2>OIDC クライアント一覧 <span id="clientCount" class="count"></span></h2></summary><p class="warning">クライアントシークレットは平文で保存・表示されます。このAdmin APIには認証がないため、インターネットに公開しないでください。</p>
<p id="clientError" class="error" role="alert"></p><button id="retryClients" class="hidden" type="button">一覧を再読み込み</button>
<div id="clients">読み込み中…</div><div class="actions"><button id="newClient" class="primary" type="button">OIDC クライアントを登録</button><button id="resetClients" class="danger" type="button">OIDC クライアントを初期状態に戻す</button></div></details>
<dialog id="clientEditor" class="editor" aria-labelledby="clientEditorTitle"><div class="editor-header"><h2 id="clientEditorTitle">OIDC クライアントを登録</h2><button id="closeClient" type="button" aria-label="OIDC クライアントのダイアログを閉じる">閉じる</button></div><form id="clientForm" novalidate><div id="editorError" class="error error-summary" role="alert" tabindex="-1"></div>
<p class="hint">＊は必須項目です</p>
<label for="clientId" class="required">クライアント ID（client_id）</label><input id="clientId" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" required><p class="hint">アプリケーション ID（GUID）。新規登録時に自動生成します。</p>
<label for="clientType">クライアントの認証区分（clientType）</label><select id="clientType"><option value="PUBLIC">PUBLIC（シークレットなし）</option><option value="CONFIDENTIAL">CONFIDENTIAL（シークレットあり）</option></select><p class="hint">認証区分とプラットフォームは別の設定です。このモックではSPAはPUBLIC、WebはCONFIDENTIALを使います。</p>
<div id="secretFields"><label for="clientSecret" class="required">クライアントシークレット（client_secret）</label><input id="clientSecret"><label for="authMethod">トークンエンドポイント認証方式（tokenEndpointAuthMethod）</label><select id="authMethod"><option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option></select></div>
<label for="platform" class="required">プラットフォーム</label><select id="platform" required aria-describedby="platformDescription"><option value="">選択してください</option><option value="spa">シングルページアプリケーション（SPA）</option><option value="web">Web</option><option value="native">モバイル／デスクトップ</option></select><p id="platformDescription" class="hint">1クライアントにつき1種類を選び、下のすべてのURIに適用します。</p><p id="platformMixedHint" class="warning hidden" role="status">この設定は複数の種類で登録されています。プラットフォームを選択すると、保存時にすべてのURIを選択した1種類へ統一します。</p>
<fieldset class="redirect-fields" aria-describedby="redirectUrisHint"><legend>リダイレクト URI</legend><div id="redirectUris"></div><button id="addRedirectUri" type="button">URIを追加</button><p id="redirectUrisHint" class="hint">ログアウト先もここに登録してください。1〜256件、URIは各256文字まで。前後の空白は保存時に除去します。</p></fieldset>
<fieldset class="permission-fields"><legend>API権限（自API）</legend><p class="hint">登録済みAPIの委任権限を選択します。ログインだけの試験では追加不要です。</p><div id="permissions"></div><button id="addPermission" type="button" aria-controls="permissionPicker" aria-expanded="false">権限を追加</button><section id="permissionPicker" class="permission-picker hidden" aria-label="API権限を追加"><label for="permissionApi">対象API</label><select id="permissionApi" data-editor-transient="true"><option value="">APIを選択してください</option></select><p id="permissionCatalogMessage" class="hint" role="status"></p><p class="hint">委任されたアクセス許可（公開スコープ）</p><div id="permissionScopes"></div><p id="permissionPickerError" class="error" role="alert"></p><div class="actions"><button id="applyPermission" class="primary" type="button">選択した権限を追加</button><button id="cancelPermission" type="button">キャンセル</button></div></section></fieldset>
<fieldset class="claim-fields"><legend>IDトークンの属性</legend>
<label for="clientGroups"><input id="clientGroups" type="checkbox" checked aria-describedby="clientGroupsHint"> groupsを含める</label><p id="clientGroupsHint" class="hint">テストユーザーに登録した所属グループのIDを含めます。所属がない場合は省略します。</p>
<label for="emailOptionalClaim"><input id="emailOptionalClaim" type="checkbox" checked aria-describedby="clientEmailHint"> emailを常に含める</label><p id="clientEmailHint" class="hint">未チェックでも、アプリがemailスコープを要求すれば含めます。メールアドレスが未設定の場合は省略します。</p>
</fieldset>
<div class="actions"><button id="saveClient" class="primary" type="submit">登録</button><button id="cancelClient" type="button">キャンセル</button></div></form></dialog>
<details class="card" id="resourcePanel"><summary><h2>API 登録一覧 <span id="resourceCount" class="count"></span></h2></summary>
<p id="resourceError" class="error" role="alert"></p><button id="retryResources" class="hidden" type="button">一覧を再読み込み</button>
<div id="resources">読み込み中…</div><div class="actions"><button id="newResource" class="primary" type="button">API を登録</button><button id="resetResources" class="danger" type="button">API を初期状態に戻す</button></div></details>
<dialog id="resourceEditor" class="editor" aria-labelledby="resourceEditorTitle"><div class="editor-header"><h2 id="resourceEditorTitle">API を登録</h2><button id="closeResource" type="button" aria-label="APIのダイアログを閉じる">閉じる</button></div><form id="resourceForm" novalidate><div id="resourceEditorError" class="error error-summary" role="alert" tabindex="-1"></div>
<p class="hint">＊は必須項目です</p>
<label for="resourceAppId" class="required">API アプリケーション ID（GUID）</label><input id="resourceAppId" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" required><p class="hint">アプリケーション ID（GUID）。新規登録時に自動生成します。</p>
<label for="resourceUri" class="required">Application ID URI</label><input id="resourceUri" required>
<label for="resourceScopes" class="required">公開スコープ（1行に1件）</label><textarea id="resourceScopes" required aria-describedby="resourceScopesHint"></textarea><p id="resourceScopesHint" class="hint">例: access_as_user、api.read、api.write を1行に1件入力します。</p>
<label for="resourceVersion">アクセストークンのバージョン</label><select id="resourceVersion" aria-describedby="resourceVersionHint"><option value="2">2（v2.0）</option><option value="1">1（v1.0）</option><option value="">null（v1.0）</option></select><p id="resourceVersionHint" class="hint">このAPI向けのトークン形式です。nullはv1.0として扱います。</p>
<fieldset class="claim-fields" aria-describedby="resourceClaimsHint"><legend>アクセストークンの属性</legend><p id="resourceClaimsHint" class="hint">このAPI向けのアクセストークンに適用します。IDトークンの属性はOIDCクライアント登録で設定します。</p>
<label for="resourceGroups"><input id="resourceGroups" type="checkbox" checked aria-describedby="resourceGroupsHint"> groupsを含める</label><p id="resourceGroupsHint" class="hint">テストユーザーに登録した所属グループのIDを含めます。所属がない場合は省略します。</p>
<label for="resourceEmail"><input id="resourceEmail" type="checkbox" checked aria-describedby="resourceEmailHint"> emailを含める</label><p id="resourceEmailHint" class="hint">テストユーザーのメールアドレスを含めます。未チェックの場合は含めません。メールアドレスが未設定の場合は省略します。</p>
</fieldset>
<div class="actions"><button id="saveResource" class="primary" type="submit">登録</button><button id="cancelResource" type="button">キャンセル</button></div></form></dialog>
</main><script>
const $=id=>document.getElementById(id),metadata=${uiMetadata},defaults=${uiDefaults},connection=${connectionValues};
let sequence=0,lastSettled=0,pendingUpdates=0;
let copySequence = 0, copySource = null;
const copyNotice = createNotice('copy', () => copySource ?? $('copyAuthority'));
function copyFallback(value) {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  try { textarea.select(); if (!document.execCommand('copy')) throw new Error('copy failed'); }
  finally { textarea.remove(); }
}
async function copyValue(value, label, source, current = () => true, selectValue = null) {
  if (!value) return;
  const sequence = ++copySequence;
  copySource = source;
  copyNotice.clear();
  try {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); }
      catch { if (!current() || sequence !== copySequence) return; copyFallback(value); }
    } else copyFallback(value);
    if (current() && sequence === copySequence) copyNotice.show(label + 'をコピーしました');
  } catch {
    if (!current() || sequence !== copySequence) return;
    copyNotice.show(label + 'をコピーできませんでした。値を選択して手動でコピーしてください。',true);
    selectValue?.();
  }
}
$('copyAuthority').onclick = () => copyValue(connection.authorityUrl,'認可サーバー URL（Authority URL）',$('copyAuthority'));
$('copyTenantId').onclick = () => copyValue(connection.tenantId,'テナント ID（tid）',$('copyTenantId'));
function fields(){const info=metadata[$('scenario').value],m=$('mode').value,limited=m==='LIMITED'&&info.supportsMode,retryAfter=info.parameterKind==='retryAfter';$('modeFields').classList.toggle('hidden',!info.supportsMode);$('countField').classList.toggle('hidden',!limited);$('failureCount').disabled=!limited;$('failureCount').required=limited;$('delayField').classList.toggle('hidden',info.parameterKind!=='timeout');$('delayMs').disabled=info.parameterKind!=='timeout';$('retryAfterField').classList.toggle('hidden',!retryAfter);$('retryAfter').disabled=!retryAfter;$('errorFields').classList.toggle('hidden',info.parameterKind!=='token400');$('claimField').classList.toggle('hidden',info.parameterKind!=='claim');$('expiredAgoField').classList.toggle('hidden',info.parameterKind!=='expiredToken');$('expiredAgoSeconds').disabled=info.parameterKind!=='expiredToken';$('nbfAheadField').classList.toggle('hidden',info.parameterKind!=='futureNbf');$('nbfAheadSeconds').disabled=info.parameterKind!=='futureNbf'}
async function request(url,opts){const r=await fetch(url,opts),raw=await r.text(),data=raw?JSON.parse(raw):null;if(!r.ok){const error=new Error(data?.message||raw||r.statusText);error.issues=data?.issues;throw error;}return data}
function render(s){$('current').textContent=s.scenario;$('currentMode').textContent=s.mode??'—';$('initial').textContent=s.initialFailureCount??'—';$('remaining').textContent=s.remainingFailures??'—';$('triggered').textContent=s.triggeredCount;$('status').textContent=s.status;$('state').classList.toggle('fault',s.status==='ACTIVE');$('history').textContent=s.lastCompleted?(s.lastCompleted.scenario+' — '+s.lastCompleted.triggeredCount+'回 — '+s.lastCompleted.completedAt):'なし'}
function renderLatest(id,state){if(id<lastSettled)return false;lastSettled=id;render(state);return true}
function showLatestError(id,error,visible=true){if(id<lastSettled)return;lastSettled=id;if(visible)$('error').textContent=message(error)}
function message(error){return error instanceof Error?error.message:String(error)}
async function refresh(showError=true){if(pendingUpdates)return;const id=++sequence;try{if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error,showError)}}
let tokenClients = [],
  tokenUsers = [],
  tokenBusy = false,
  tokenResultSequence = 0;
const tokenChoiceState = {
  client: { loading: true, error: '' },
  user: { loading: true, error: '' },
};
function clearTokenResult() {
  tokenResultSequence++;
  $("issuedToken").value = "";
  $("tokenSubject").textContent = "";
  $("tokenFault").textContent = "";
  if (copySource === $('copyToken')) copyNotice.clear();
  $("copyToken").disabled = true;
  $("tokenResult").classList.add("hidden");
}
function updateTokenControls() {
  const disabled = tokenBusy || Object.values(tokenChoiceState).some(state => state.loading);
  $("tokenClient").disabled = disabled || !tokenClients.length;
  $("tokenUser").disabled = disabled || !tokenUsers.length;
  $("tokenResource").disabled = disabled;
  $("tokenScopes").disabled = disabled;
  $("issueToken").disabled =
    disabled ||
    !tokenClients.length ||
    !tokenUsers.length ||
    !$("tokenClient").value ||
    !$("tokenUser").value || !$("tokenResource").value || !$("tokenScopes").value.trim();
  $("issueToken").textContent = tokenBusy ? "発行中…" : "発行";
  $("tokenForm").setAttribute("aria-busy", String(disabled));
}
function setTokenChoiceStatus(kind, loading, error = '') {
  if (kind !== "client" && kind !== "user") return;
  tokenChoiceState[kind] = { loading, error };
  $('tokenChoicesError').textContent = Object.values(tokenChoiceState)
    .map(state => state.error).filter(Boolean).join(' ');
  if ($('tokenChoicesError').textContent) $('tokenChoicesError').textContent += ' 該当する一覧の「一覧を再読み込み」から再試行してください。';
  updateTokenControls();
}
function setTokenChoices(kind, items) {
  if (kind !== "client" && kind !== "user") return;
  const select = $(kind === "client" ? "tokenClient" : "tokenUser"),
    previous = select.value;
  select.replaceChildren();
  if (kind === "client") tokenClients = items;
  else tokenUsers = items;
  for (const item of items) {
    const option = document.createElement("option");
    option.value = kind === "client" ? item.clientId : item.sub;
    option.textContent =
      kind === "client" ? item.clientId : item.name + "（" + item.sub + "）";
    select.append(option);
  }
  if (!items.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent =
      "登録済みの" +
      (kind === "client" ? "クライアント" : "テストユーザー") +
      "がありません";
    select.append(option);
  } else if (
    items.some(
      (item) => (kind === "client" ? item.clientId : item.sub) === previous,
    )
  )
    select.value = previous;
  setTokenChoiceStatus(kind, false);
  if (kind === "client") updateTokenResources(previous === select.value);
}
$("tokenClient").onchange = () => {
  updateTokenResources();
  clearTokenResult();
  updateTokenControls();
};
$("tokenUser").onchange = () => {
  clearTokenResult();
  updateTokenControls();
};
$("tokenForm").onsubmit = async (event) => {
  event.preventDefault();
  if ($("issueToken").disabled) return;
  clearTokenResult();
  $("tokenError").textContent = "";
  const id = ++tokenResultSequence;
  const subject = { clientId: $('tokenClient').value, userId: $('tokenUser').value, resourceAppId: $('tokenResource').value, scopes: $('tokenScopes').value.trim().split(/\\s+/).filter(Boolean) };
  tokenBusy = true;
  updateTokenControls();
  try {
    const data = await request("/__mock/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subject),
    });
    if (id !== tokenResultSequence) return;
    $("issuedToken").value = data.access_token;
    $('tokenSubject').textContent = '発行対象: クライアント ' + subject.clientId + ' / ユーザー ' + subject.userId + ' / API ' + subject.resourceAppId + ' / スコープ ' + subject.scopes.join(' ');
    $("tokenFault").textContent = data.fault
      ? "適用した障害: " +
        data.fault.scenario +
        (data.fault.mode === "LIMITED"
          ? "（残り " +
            data.fault.remainingBefore +
            " → " +
            data.fault.remainingAfter +
            "）"
          : "")
      : "適用した障害: なし";
    $("tokenResult").classList.remove("hidden");
    $("copyToken").disabled = false;
  } catch (error) {
    if (id === tokenResultSequence) {
      clearTokenResult();
      $("tokenError").textContent = message(error);
    }
  } finally {
    tokenBusy = false;
    updateTokenControls();
    await refresh();
  }
};
$('copyToken').onclick = () => {
  const value = $('issuedToken').value, sequence = tokenResultSequence;
  return copyValue(value,'アクセストークン',$('copyToken'),
    () => sequence === tokenResultSequence && $('issuedToken').value === value,
    () => { $('issuedToken').focus(); $('issuedToken').select(); });
};
function createNotice(kind,focusTarget){const cap=kind[0].toUpperCase()+kind.slice(1),notice=$(kind+'Notice'),message=$(kind+'Message'),dismiss=$('dismiss'+cap+'Notice');let timer=null;function clear(){if(timer){clearTimeout(timer);timer=null}notice.classList.add('hidden');message.textContent=''}function schedule(){if(timer)clearTimeout(timer);timer=setTimeout(clear,10000)}function show(text,error=false){notice.classList.toggle('error-notice',error);message.setAttribute('role',error?'alert':'status');notice.classList.remove('hidden');message.textContent=text;schedule()}notice.addEventListener('mouseenter',()=>{if(timer){clearTimeout(timer);timer=null}});notice.addEventListener('mouseleave',()=>{if(!notice.classList.contains('hidden'))schedule()});notice.addEventListener('focusin',()=>{if(timer){clearTimeout(timer);timer=null}});notice.addEventListener('focusout',()=>{if(!notice.classList.contains('hidden'))schedule()});dismiss.onclick=()=>{clear();const target=focusTarget(),panel=target.closest('details.card');if(panel)revealPanel(panel.id);target.focus({preventScroll:true})};return{clear,show}}
const scenarioNotice=createNotice('scenario',()=>$('scenario'));
async function update(url,options,successMessage){pendingUpdates++;let id=++sequence;scenarioNotice.clear();try{await request(url,options);id=++sequence;if(renderLatest(id,await request('/__mock/api/scenario'))){$('error').textContent='';if(successMessage)scenarioNotice.show(successMessage)}}catch(error){showLatestError(id,error)}finally{pendingUpdates--}}
$('scenario').onchange=fields;$('mode').onchange=fields;$('form').onsubmit=e=>{e.preventDefault();const scenario=$('scenario').value,info=metadata[scenario];let body={scenario};if(info.supportsMode){body.mode=$('mode').value;if(body.mode==='LIMITED')body.failureCount=Number($('failureCount').value);if(info.parameterKind==='timeout')body.parameters={delayMs:Number($('delayMs').value||defaults.delayMs)};if(info.parameterKind==='retryAfter'&&$('retryAfter').value)body.parameters={retryAfterSeconds:Number($('retryAfter').value)};if(info.parameterKind==='claim')body.parameters={claim:$('claim').value};if(info.parameterKind==='expiredToken')body.parameters={expiredAgoSeconds:Number($('expiredAgoSeconds').value||defaults.expiredAgoSeconds)};if(info.parameterKind==='futureNbf')body.parameters={nbfAheadSeconds:Number($('nbfAheadSeconds').value||defaults.nbfAheadSeconds)};if(info.parameterKind==='token400')body.parameters={error:$('errorCode').value||defaults.tokenError,...($('errorDescription').value?{errorDescription:$('errorDescription').value}:{})}}void update('/__mock/api/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)},'シナリオ「'+scenario+'」を適用しました。')};
$('normal').onclick=()=>void update('/__mock/api/scenario',{method:'DELETE'},'シナリオをNORMALに戻しました。');$('reset').onclick=()=>void update('/__mock/api/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'},'シナリオを初期状態に戻しました。');$('refresh').onclick=()=>void refresh();fields();void refresh();
const endpointLabels={discovery:'Discovery',authorization:'認可',interaction:'サインイン画面',token:'トークン',jwks:'JWKS',logout:'ログアウト','connectivity-probe':'接続性プローブ',other:'その他'};
const effectLabels={'authorization-denied':'OAuth エラーを redirect で返却','authorization-error':'OAuth エラーを redirect で返却','authorization-response-mutation':'認可応答を改変','claims-mutation':'claim を改変','token-mutation':'トークンを改変','token-response-mutation':'トークン応答を改変','signing-key-rollover':'新しい署名鍵で署名','http-400':'HTTP 400 を返却','http-429':'HTTP 429 を返却','http-500':'HTTP 500 を返却','jwks-invalid':'不正な JWKS を返却','http-timeout':'応答を遅延'};
let accessLogSequence=0;
function formatTime(iso){const date=new Date(iso);if(Number.isNaN(date.getTime()))return iso;return date.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+'.'+String(date.getMilliseconds()).padStart(3,'0')}
function describeScenario(entry){if(entry.fault){const fault=entry.fault,effect=effectLabels[metadata[fault.scenario]?.effect]??'障害を注入',remaining=fault.mode==='LIMITED'?'、残り '+fault.remainingBefore+'→'+fault.remainingAfter:'',params=Object.entries(fault.parameters??{}).map(([key,value])=>key+'='+value).join(', ');return fault.scenario+' 適用 — '+effect+'（'+fault.mode+remaining+(params?'、'+params:'')+'）'}return entry.scenario==='NORMAL'?'—':entry.scenario+' 未適用'}
function cell(text,className,title){const td=document.createElement('td');td.textContent=text;if(className)td.className=className;if(title)td.title=title;return td}
function renderAccessLog(entries){const root=$('accessLogRows');root.replaceChildren();$('accessLogCount').textContent='（'+entries.length+' 件）';if(!entries.length){const row=document.createElement('tr'),empty=document.createElement('td');empty.colSpan=7;empty.textContent='アクセスログはありません。';row.append(empty);root.append(row);return}for(const entry of entries){const row=document.createElement('tr');if(entry.fault)row.className='injected';const aborted=entry.statusCode===null;row.append(cell(formatTime(entry.receivedAt),'',entry.receivedAt),cell(entry.method),cell(endpointLabels[entry.endpoint]??entry.endpoint),cell(entry.path,'path'),cell(aborted?'中断':String(entry.statusCode),aborted||entry.statusCode>=400?'status-error':'status-ok',aborted?'応答を返す前にクライアントが切断しました':''),cell(entry.durationMs+' ms'),cell(describeScenario(entry),entry.fault?'scenario':'scenario muted'));root.append(row)}}
async function loadAccessLog(){const id=++accessLogSequence;try{const entries=await request('/__mock/api/access-log');if(id!==accessLogSequence)return;renderAccessLog(entries);$('accessLogError').textContent=''}catch(error){if(id!==accessLogSequence)return;$('accessLogError').textContent='アクセスログを読み込めませんでした。 '+message(error);revealPanel('accessLogPanel')}}
const accessLogNotice=createNotice('accessLog',()=>$('refreshAccessLog'));
$('refreshAccessLog').onclick=()=>void loadAccessLog();
$('clearAccessLog').onclick=async()=>{if(!confirm('アクセスログをクリアしますか？'))return;try{await request('/__mock/api/access-log',{method:'DELETE'})}catch(error){$('accessLogError').textContent='アクセスログをクリアできませんでした。 '+message(error);revealPanel('accessLogPanel');return}await loadAccessLog();accessLogNotice.show('アクセスログをクリアしました。')};
void loadAccessLog();
// Collapsed panels are a per-browser convenience; storage may be unavailable, so every access is best effort.
const panelStorageKey='mock-idp-admin-panels';
function savedPanels(){try{const saved=JSON.parse(localStorage.getItem(panelStorageKey)??'{}');return saved&&typeof saved==='object'?saved:{}}catch{return{}}}
// Panels the page opens itself (to surface an error) are not a user preference, so that toggle is not saved.
function revealPanel(id){const panel=$(id);if(panel.open)return;panel.dataset.autoOpen='';panel.open=true}
for(const panel of document.querySelectorAll('details.card')){const saved=savedPanels()[panel.id];if(typeof saved==='boolean')panel.open=saved;panel.addEventListener('toggle',()=>{if('autoOpen' in panel.dataset){delete panel.dataset.autoOpen;return}try{localStorage.setItem(panelStorageKey,JSON.stringify({...savedPanels(),[panel.id]:panel.open}))}catch{}})}
function lines(value){return [...new Set(value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean))]}
const registrationFields = {
  client: {clientId:['clientId','クライアント ID'],clientType:['clientType','認証区分'],clientSecret:['clientSecret','クライアントシークレット'],tokenEndpointAuthMethod:['authMethod','認証方式'],platform:['platform','プラットフォーム'],redirectUris:['redirectUris','リダイレクト URI'],requiredResourceAccess:['permissions','API権限'],groupMembershipClaims:['clientGroups','groups'],emailOptionalClaim:['emailOptionalClaim','email']},
  user: {sub:['userSub','ユーザー内部 ID'],oid:['userOid','オブジェクト ID'],name:['userName','表示名'],preferred_username:['userPreferredUsername','優先ユーザー名'],mail:['userMail','メールアドレス'],groups:['userGroups','グループ']},
  resource: {resourceAppId:['resourceAppId','API ID'],identifierUri:['resourceUri','Application ID URI'],scopes:['resourceScopes','公開スコープ'],requestedAccessTokenVersion:['resourceVersion','アクセストークンのバージョン'],emailOptionalClaim:['resourceEmail','email'],groupMembershipClaims:['resourceGroups','groups']},
};
function createFormValidation(kind, form, summary) {
  const fields = registrationFields[kind], entries = new Map();
  let general = [], errorSequence = 0;
  function locate(issue) {
    if (issue.element) return issue;
    const path = Array.isArray(issue.path) ? issue.path : [], field = fields[path[0]];
    if (!field) return {message:issue.message};
    let element = $(field[0]), label = field[1], message = issue.message;
    if (kind === 'client' && path[0] === 'redirectUris' && Number.isInteger(path[1])) {
      element = redirectRows()[path[1]]?.querySelector('input') ?? element;
      label += ' ' + (path[1] + 1);
    } else if (Number.isInteger(path[1]) && (path[0] === 'groups' || path[0] === 'scopes')) message = (path[1] + 1) + '件目：' + message;
    return {element,label,root:path[0],message};
  }
  function focus(element) {
    const target = element === $('permissions') ? $('addPermission') : element.querySelector('input,select,textarea') ?? element;
    if (!target.disabled) { target.focus(); target.scrollIntoView({block:'center',behavior:'smooth'}); }
  }
  function render() {
    summary.replaceChildren();
    if (!entries.size && !general.length) return;
    const heading = document.createElement('p'); heading.textContent = '入力内容を確認してください。'; summary.append(heading);
    const list = document.createElement('ul');
    for (const [element,entry] of entries) {
      const item = document.createElement('li'), link = document.createElement('button');
      link.type = 'button'; link.className = 'error-link';
      link.textContent = entry.label + '：' + entry.messages.join(' / ');
      link.onclick = () => focus(element); item.append(link); list.append(item);
    }
    for (const text of general) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
    summary.append(list);
  }
  function remove(element) {
    const entry = entries.get(element); if (!entry) return;
    entry.node.remove();
    if (entry.described) element.setAttribute('aria-describedby',entry.described); else element.removeAttribute('aria-describedby');
    if (entry.invalid !== null) element.setAttribute('aria-invalid',entry.invalid); else element.removeAttribute('aria-invalid');
    entries.delete(element);
  }
  function clear() { for (const element of [...entries.keys()]) remove(element); general = []; summary.replaceChildren(); }
  function show(issues) {
    clear();
    for (const issue of issues) {
      if (typeof issue?.message !== 'string') continue;
      const found = locate(issue), element = found.element;
      if (!element) { general.push(found.message); continue; }
      let entry = entries.get(element);
      if (!entry) {
        const node = document.createElement('p'); node.className = 'field-error'; node.id = kind + 'FieldError' + (++errorSequence);
        entry = {node,label:found.label,root:found.root,messages:[],keys:new Set(),described:element.getAttribute('aria-describedby'),invalid:element.getAttribute('aria-invalid')};
        entries.set(element,entry); element.after(node);
        element.setAttribute('aria-invalid','true');
        element.setAttribute('aria-describedby',[entry.described,node.id].filter(Boolean).join(' '));
      }
      const key = JSON.stringify([issue.path ?? [], issue.message]);
      if (!entry.keys.has(key)) { entry.keys.add(key); entry.messages.push(found.message); }
      entry.node.textContent = entry.messages.join(' / ');
    }
    render();
    const first = entries.keys().next().value;
    if (first) focus(first); else { summary.focus(); summary.scrollIntoView({block:'center'}); }
  }
  function check() {
    const issues = [];
    for (const input of form.querySelectorAll('input,select,textarea')) {
      if (input.disabled || !input.willValidate || input.validity.valid) continue;
      const field = Object.entries(fields).find(([,value]) => value[0] === input.id),
        label = field?.[1][1] ?? input.labels?.[0]?.textContent ?? '入力項目', validity = input.validity;
      const message = validity.valueMissing ? (input === $('platform') ? 'プラットフォームを1つ選択してください。' : '値を入力してください。')
        : validity.typeMismatch ? '有効なメールアドレスを入力してください。'
        : validity.patternMismatch ? input.title || 'GUID形式で入力してください。'
        : input.validationMessage || '入力値を確認してください。';
      issues.push({element:input,label,root:field?.[0] ?? 'redirectUris',message});
    }
    clear();
    if (issues.length) { show(issues); return false; }
    return true;
  }
  function edited(event) {
    for (const element of [...entries.keys()]) if (element === event.target || element.contains(event.target)) remove(element);
    render();
  }
  form.addEventListener('input',edited); form.addEventListener('change',edited);
  function clearFields(roots) { for (const [element,entry] of [...entries]) if (roots.includes(entry.root)) remove(element); render(); }
  return {clear,show,check,clearFields,clearField:root => clearFields([root])};
}
// Shared lifecycle keeps all editors consistent, including partial save success.
function createEditor(kind, label, idKey, errorId, renderItems, describeItem, hooks = {}) {
  const cap = kind[0].toUpperCase() + kind.slice(1),
    dialog = $(kind + 'Editor'),
    form = $(kind + 'Form'),
    submit = $('save' + cap),
    editorError = $(errorId),
    list = $(kind + 's'),
    listError = $(kind + 'Error'),
    retry = $('retry' + cap + 's'),
    newButton = $('new' + cap),
    url = '/__mock/api/' + kind + 's',
    notice = createNotice(kind, () => newButton);
  const validation = createFormValidation(kind,form,editorError);
  let editingId = null,
    initialValues = '',
    opener = null,
    busy = false,
    disabledBeforeSave = [],
    loadSequence = 0,
    savedRefreshPending = false,
    activeLoad = null;
  const inputs = () => [...form.querySelectorAll('input,select,textarea')];
  const snapshot = () =>
    JSON.stringify([
      inputs().filter(input => input.dataset.editorTransient !== 'true').map((input) =>
        input.type === 'checkbox' ? input.checked : input.value,
      ),
      hooks.snapshot?.() ?? null,
    ]);
  const editButton = (id) =>
    [...list.querySelectorAll('button[data-edit-id]')].find(
      (button) => button.dataset.editId === id,
    );
  function beginChange() {
    notice.clear();
    listError.textContent = '';
    retry.classList.add('hidden');
    savedRefreshPending = false;
    loadSequence++;
    activeLoad = null;
    hooks.onLoadEnd?.();
    retry.disabled = false;
    setTokenChoiceStatus(kind, false);
  }
  function replaceItems(items) {
    // A mutation response supersedes every GET started before it completed.
    loadSequence++;
    activeLoad = null;
    renderItems(items);
    hooks.onItems?.(items);
    listError.textContent = '';
    retry.classList.add('hidden');
    retry.disabled = false;
    savedRefreshPending = false;
  }
  function setBusy(value) {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    if (value) {
      disabledBeforeSave = [
        ...dialog.querySelectorAll('input,select,textarea,button'),
      ].map((control) => [control, control.disabled]);
      for (const [control] of disabledBeforeSave) control.disabled = true;
    } else {
      for (const [control, disabled] of disabledBeforeSave)
        control.disabled = disabled;
      disabledBeforeSave = [];
    }
    submit.textContent = value ? '保存中…' : editingId === null ? '登録' : '更新';
    hooks.onBusy?.(value);
  }
  function close() {
    const target = opener?.isConnected
      ? opener
      : (editButton(editingId) ?? newButton);
    dialog.close();
    validation.clear();
    form.reset();
    hooks.onClose?.();
    editorError.textContent = '';
    editingId = null;
    initialValues = '';
    opener = null;
    target.focus({ preventScroll: true });
  }
  function cancel() {
    if (busy) return;
    if (snapshot() !== initialValues && !confirm('未保存の変更を破棄しますか？'))
      return;
    close();
  }
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  $('cancel' + cap).onclick = cancel;
  $('close' + cap).onclick = cancel;
  function open(id) {
    validation.clear();
    notice.clear();
    editingId = id;
    opener = document.activeElement;
    editorError.textContent = '';
    $(kind + 'EditorTitle').textContent =
      label + (id === null ? 'を登録' : 'を編集');
    submit.textContent = id === null ? '登録' : '更新';
    initialValues = snapshot();
    dialog.showModal();
    inputs()
      .find((input) => !input.disabled && !input.closest('.hidden'))
      ?.focus();
    dialog.scrollTop = 0;
  }
  async function performLoad(saved = false) {
    savedRefreshPending = savedRefreshPending || saved;
    const sequence = ++loadSequence;
    retry.disabled = true;
    setTokenChoiceStatus(kind, true);
    hooks.onLoadStart?.();
    try {
      const items = await request(url);
      if (sequence !== loadSequence) return;
      const focused = document.activeElement,
        focusedId = list.contains(focused) ? focused.dataset.editId : undefined;
      renderItems(items);
      hooks.onItems?.(items);
      listError.textContent = '';
      retry.classList.add('hidden');
      savedRefreshPending = false;
      if (focusedId !== undefined)
        (editButton(focusedId) ?? newButton).focus({ preventScroll: true });
      else if (focused === retry) newButton.focus({ preventScroll: true });
    } catch (error) {
      if (sequence !== loadSequence) return;
      hooks.onLoadError?.(error);
      setTokenChoices(kind, []);
      setTokenChoiceStatus(kind, false, label + 'の候補を読み込めませんでした。 ' + message(error));
      listError.textContent =
        (savedRefreshPending
          ? '保存は完了しましたが、一覧を更新できませんでした。'
          : '一覧を読み込めませんでした。') +
        ' ' +
        message(error);
      retry.classList.remove('hidden');
      revealPanel(kind + 'Panel');
    } finally {
      if (sequence === loadSequence) { retry.disabled = false; hooks.onLoadEnd?.(); }
    }
  }
  function load(saved = false, reuse = false) {
    if (reuse && activeLoad) return activeLoad;
    const pending = performLoad(saved);
    activeLoad = pending;
    const settled = () => { if (activeLoad === pending) activeLoad = null; };
    pending.then(settled, settled);
    return pending;
  }
  retry.onclick = () => void load();
  async function save(payload) {
    if (busy || !dialog.open || !validation.check()) return;
    const id = editingId,
      isUpdate = id !== null;
    if (isUpdate) delete payload[idKey];
    editorError.textContent = '';
    setBusy(true);
    let item;
    try {
      item = await request(isUpdate ? url + '/' + encodeURIComponent(id) : url, {
        method: isUpdate ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      setBusy(false);
      if (Array.isArray(error?.issues) && error.issues.length) validation.show(error.issues);
      else { editorError.textContent = message(error); editorError.focus(); editorError.scrollIntoView({block:'center'}); }
      return;
    }
    setBusy(false);
    close();
    notice.show(
      label + '「' + describeItem(item) + '」を' + (isUpdate ? '更新' : '登録') + 'しました。',
    );
    await load(true);
  }
  return { open, save, load, replaceItems, beginChange, notice: notice.show, clearField:validation.clearField, clearFields:validation.clearFields };
}
let permissionDraft = [], permissionPending = new Map(), permissionPickerOpen = false, permissionClientBusy = false, permissionPickerSequence = 0;
let permissionCatalog = [], permissionCatalogState = {loading:false, loaded:false, error:''};
function permissionSnapshot() {
  const canonical = items => items.map(item => [item.resourceAppId, [...item.scopes].sort()]).sort((a,b) => a[0].localeCompare(b[0]));
  return [canonical(permissionDraft), canonical([...permissionPending].map(([resourceAppId,scopes]) => ({resourceAppId,scopes:[...scopes]})))];
}
function permissionCatalogReady() {
  return permissionCatalogState.loaded && !permissionCatalogState.loading && !permissionCatalogState.error;
}
function pendingPermissionCount() {
  return [...permissionPending.values()].reduce((sum,scopes) => sum + scopes.size, 0);
}
function pendingPermissionsValid() {
  return [...permissionPending].every(([id,scopes]) => {
    const resource = permissionCatalog.find(item => item.resourceAppId === id);
    return resource && [...scopes].every(scope => resource.scopes.includes(scope));
  });
}
function updatePermissionControls() {
  const ready = permissionCatalogReady();
  $('addPermission').disabled = permissionClientBusy;
  $('permissionApi').disabled = permissionClientBusy || !ready;
  $('cancelPermission').disabled = permissionClientBusy;
  $('applyPermission').disabled = permissionClientBusy || !ready || !pendingPermissionCount() || !pendingPermissionsValid();
  $('applyPermission').textContent = '選択した権限を追加（' + pendingPermissionCount() + '件）';
  $('saveClient').disabled = permissionClientBusy || permissionPickerOpen;
  for (const input of $('permissionScopes').querySelectorAll('input'))
    input.disabled = permissionClientBusy || !ready || input.dataset.existing === 'true';
  for (const button of $('permissions').querySelectorAll('button')) button.disabled = permissionClientBusy;
  $('permissionCatalogMessage').textContent = permissionCatalogState.loading ? 'API候補を読み込み中…'
    : permissionCatalogState.error ? 'API候補を読み込めませんでした。「キャンセル」で閉じてから、もう一度「権限を追加」を開いてください。 ' + permissionCatalogState.error
    : !permissionCatalogState.loaded ? '「権限を追加」を開くとAPI候補を取得します。'
    : !permissionCatalog.length ? 'API登録一覧で、先に自APIと公開スコープを登録してください。' : '';
  $('permissionCatalogMessage').className = permissionCatalogState.error ? 'error' : 'hint';
  $('permissionPickerError').textContent = ready && pendingPermissionCount() && !pendingPermissionsValid()
    ? '選択したAPIまたはスコープの登録が変更されています。未登録の選択を解除してから追加してください。' : '';
}
function setPermissionBusy(value) {
  permissionClientBusy = value;
  updatePermissionControls();
}
function renderPermissions() {
  const root = $('permissions');
  if (!permissionDraft.length) {
    root.replaceChildren();
    root.textContent = 'API権限は未設定です。ログインだけの試験では追加不要です。';
    updatePermissionControls();
    return;
  }
  const body = listTable(root, ['対象API / API ID','スコープ','種類','操作']);
  for (const permission of permissionDraft) {
    const resource = permissionCatalog.find(item => item.resourceAppId === permission.resourceAppId);
    for (const scope of permission.scopes) {
      const row = document.createElement('tr'), api = document.createElement('td'),
        name = document.createElement('div'), id = document.createElement('code'),
        scopeCell = cell(scope), actions = document.createElement('td'), remove = document.createElement('button');
      name.textContent = resource?.identifierUri ?? 'API情報未取得';
      id.textContent = permission.resourceAppId;
      id.className = 'permission-api-id';
      api.append(name,id);
      if (permissionCatalogState.loaded && (!resource || !resource.scopes.includes(scope))) {
        scopeCell.textContent = scope + '（未登録）';
        scopeCell.className = 'warning';
      }
      remove.type = 'button';
      remove.textContent = '削除';
      remove.dataset.resource = permission.resourceAppId;
      remove.dataset.scope = scope;
      remove.setAttribute('aria-label', (resource?.identifierUri ?? permission.resourceAppId) + 'の' + scope + 'を削除');
      remove.onclick = () => {
        if (remove.disabled) return;
        const index = [...root.querySelectorAll('button')].indexOf(remove);
        clientEditor.clearField('requiredResourceAccess');
        permission.scopes = permission.scopes.filter(item => item !== scope);
        if (!permission.scopes.length) permissionDraft = permissionDraft.filter(item => item !== permission);
        renderPermissions();
        renderPermissionPicker();
        const buttons = [...root.querySelectorAll('button')];
        (buttons[Math.min(index, buttons.length - 1)] ?? $('addPermission')).focus();
      };
      actions.append(remove);
      row.append(api,scopeCell,cell('委任'),actions);
      body.append(row);
    }
  }
  updatePermissionControls();
}
function renderPermissionScopes() {
  const root = $('permissionScopes'), id = $('permissionApi').value;
  root.replaceChildren();
  if (!id) { root.textContent = '対象APIを選択してください。'; updatePermissionControls(); return; }
  const resource = permissionCatalog.find(item => item.resourceAppId === id),
    existing = permissionDraft.find(item => item.resourceAppId === id)?.scopes ?? [],
    pending = permissionPending.get(id) ?? new Set();
  const scopes = [...new Set([...(resource?.scopes ?? []), ...existing, ...pending])];
  for (const scope of scopes) {
    const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
    input.type = 'checkbox';
    input.value = scope;
    input.dataset.editorTransient = 'true';
    input.dataset.existing = String(existing.includes(scope));
    input.checked = existing.includes(scope) || pending.has(scope);
    text.textContent = scope + (existing.includes(scope) ? '（追加済み）' : '') + (!resource?.scopes.includes(scope) ? '（未登録）' : '');
    input.onchange = () => {
      if (input.disabled) return;
      const selected = permissionPending.get(id) ?? new Set();
      if (input.checked) selected.add(scope); else selected.delete(scope);
      if (selected.size) permissionPending.set(id, selected); else permissionPending.delete(id);
      updatePermissionControls();
    };
    label.append(input,text);
    root.append(label);
  }
  updatePermissionControls();
}
function renderPermissionPicker() {
  const select = $('permissionApi'), previous = select.value;
  const ids = [...new Set([...permissionCatalog.map(item => item.resourceAppId), ...permissionPending.keys(), ...(previous ? [previous] : [])])];
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'APIを選択してください';
  select.append(placeholder);
  for (const id of ids) {
    const resource = permissionCatalog.find(item => item.resourceAppId === id), option = document.createElement('option');
    option.value = id;
    option.textContent = resource?.identifierUri ?? id + '（未登録）';
    select.append(option);
  }
  select.value = ids.includes(previous) ? previous : '';
  renderPermissionScopes();
}
function setPermissionCatalog(items) {
  permissionCatalog = items;
  permissionCatalogState = {loading:false,loaded:true,error:''};
  renderPermissions();
  renderPermissionPicker();
}
function permissionCatalogLoading() {
  permissionCatalogState.loading = true;
  permissionCatalogState.error = '';
  updatePermissionControls();
}
function permissionCatalogSettled() {
  permissionCatalogState.loading = false;
  updatePermissionControls();
}
function permissionCatalogFailed(error) {
  permissionCatalogState.loaded = false;
  permissionCatalogState.error = message(error);
  updatePermissionControls();
}
function closePermissionPicker(focus = false) {
  permissionPickerSequence++;
  permissionPickerOpen = false;
  permissionPending = new Map();
  $('permissionPicker').classList.add('hidden');
  $('addPermission').setAttribute('aria-expanded','false');
  updatePermissionControls();
  if (focus) $('addPermission').focus();
}
function setPermissions(items) {
  permissionDraft = items.map(item => ({resourceAppId:item.resourceAppId, scopes:[...item.scopes]}));
  closePermissionPicker();
  $('permissionApi').value = '';
  renderPermissions();
  renderPermissionPicker();
}
$('addPermission').onclick = async () => {
  if ($('addPermission').disabled) return;
  if (permissionPickerOpen) {
    ($('permissionApi').disabled ? $('cancelPermission') : $('permissionApi')).focus();
    return;
  }
  const sequence = ++permissionPickerSequence;
  permissionPickerOpen = true;
  permissionPending = new Map();
  $('permissionApi').value = '';
  $('permissionPicker').classList.remove('hidden');
  $('addPermission').setAttribute('aria-expanded','true');
  renderPermissionPicker();
  const loading = resourceEditor.load(false,true);
  $('cancelPermission').focus();
  await loading;
  if (sequence === permissionPickerSequence && permissionPickerOpen && !permissionClientBusy &&
      document.activeElement === $('cancelPermission') && permissionCatalogReady() && permissionCatalog.length) {
    $('permissionApi').focus();
  }
};
$('permissionApi').onchange = renderPermissionScopes;
$('cancelPermission').onclick = () => {
  if (permissionClientBusy) return;
  closePermissionPicker(true);
};
$('applyPermission').onclick = () => {
  if ($('applyPermission').disabled) return;
  clientEditor.clearField('requiredResourceAccess');
  for (const [resourceAppId,scopes] of permissionPending) {
    let permission = permissionDraft.find(item => item.resourceAppId === resourceAppId);
    if (!permission) { permission = {resourceAppId,scopes:[]}; permissionDraft.push(permission); }
    permission.scopes = [...new Set([...permission.scopes,...scopes])];
  }
  closePermissionPicker(true);
  renderPermissions();
};
const clientEditor = createEditor(
  'client',
  'OIDC クライアント',
  'clientId',
  'editorError',
  renderClients,
  (client) => client.clientId,
  { snapshot: permissionSnapshot, onBusy: setPermissionBusy, onClose: closePermissionPicker },
);
const userEditor = createEditor(
  'user',
  'テストユーザー',
  'sub',
  'userEditorError',
  renderUsers,
  (user) => user.name + '（' + user.sub + '）',
);
function clientTypeFields(){const confidential=$('clientType').value==='CONFIDENTIAL';$('secretFields').classList.toggle('hidden',!confidential);$('clientSecret').required=confidential;$('clientSecret').disabled=!confidential;$('authMethod').disabled=!confidential;updatePlatformChoices()}
const platformTypes = {
  spa: { label: 'シングルページアプリケーション（SPA）', description: 'ブラウザで動作するアプリ。PUBLICで登録し、PKCEを使用します。' },
  web: { label: 'Web', description: 'サーバー側で認証処理を行うアプリ。CONFIDENTIALで登録します。' },
  native: { label: 'モバイル／デスクトップ', description: '端末上で動作するアプリ。カスタムスキームのURIも登録できます。' },
};
let redirectRowSequence = 0;
function redirectRows() {
  return [...$('redirectUris').children];
}
function updatePlatformChoices() {
  const select = $('platform'), previous = select.value,
    allowed = $('clientType').value === 'CONFIDENTIAL' ? ['web','native'] : ['spa','native'];
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = '選択してください'; select.append(placeholder);
  for (const type of allowed) {
    const option = document.createElement('option'); option.value = type; option.textContent = platformTypes[type].label; select.append(option);
  }
  select.value = allowed.includes(previous) ? previous : '';
  updatePlatformDescription();
  if (previous && !select.value) $('platformDescription').textContent = '認証区分を変更したため、プラットフォームを選び直してください。URIの入力値は保持しています。';
}
function updatePlatformDescription() {
  const info = platformTypes[$('platform').value];
  $('platformDescription').textContent = info
    ? info.description + ' 選択した種類をすべてのリダイレクト URI に適用します。'
    : '1クライアントにつき1種類を選び、下のすべてのURIに適用します。';
}
function updateRedirectControls() {
  const rows = redirectRows();
  $('addRedirectUri').disabled = rows.length >= 256;
  rows.forEach((row, index) => {
    row.setAttribute('aria-label', 'リダイレクト URI ' + (index + 1));
    row.querySelector('label').textContent = 'リダイレクト URI ' + (index + 1);
    const remove = row.querySelector('button');
    remove.disabled = rows.length <= 1;
    remove.setAttribute('aria-label', 'リダイレクト URI ' + (index + 1) + 'を削除');
  });
}
function appendRedirectUri(value, originalType = '') {
  const row = document.createElement('div'),
    field = document.createElement('div'),
    label = document.createElement('label'),
    uri = document.createElement('input'),
    remove = document.createElement('button');
  row.className = 'redirect-row';
  row.setAttribute('role', 'group');
  // Preserve legacy mixed configurations until a platform is explicitly selected.
  row.dataset.platform = originalType;
  uri.id = 'redirectUri' + (++redirectRowSequence);
  uri.type = 'text';
  uri.value = value;
  uri.required = true;
  uri.spellcheck = false;
  uri.placeholder = 'http://localhost:3000/callback';
  label.htmlFor = uri.id;
  label.className = 'required';
  field.append(label, uri);
  remove.type = 'button';
  remove.textContent = '削除';
  remove.onclick = () => {
    if (remove.disabled) return;
    const index = redirectRows().indexOf(row);
    clientEditor.clearField('redirectUris');
    row.remove();
    updateRedirectControls();
    const rows = redirectRows();
    rows[Math.min(index, rows.length - 1)].querySelector('input').focus();
  };
  row.append(field, remove);
  $('redirectUris').append(row);
  return uri;
}
function setRedirectUris(items) {
  $('redirectUris').replaceChildren();
  const types = [...new Set(items.map(item => item.type))];
  updatePlatformChoices();
  $('platform').value = types.length === 1 ? types[0] : '';
  $('platformMixedHint').classList.toggle('hidden', types.length <= 1);
  for (const item of items.length ? items : [{uri:'',type:''}]) appendRedirectUri(item.uri, item.type);
  updatePlatformDescription();
  updateRedirectControls();
}
function readRedirectUris() {
  return redirectRows().map(row => ({
    type: $('platform').value || row.dataset.platform,
    uri: row.querySelector('input').value.trim(),
  }));
}
$('platform').onchange = () => { updatePlatformDescription(); clientEditor.clearFields(['platform','redirectUris']); };
$('addRedirectUri').onclick = () => {
  if ($('addRedirectUri').disabled) return;
  const uri = appendRedirectUri('');
  updateRedirectControls();
  uri.focus();
};
function openClient(client){$('clientId').value=client?.clientId??newUuid();$('clientId').disabled=!!client;$('clientType').value=client?.clientType??'PUBLIC';$('clientSecret').value=client?.clientSecret??'';$('authMethod').value=client?.tokenEndpointAuthMethod==='client_secret_post'?'client_secret_post':'client_secret_basic';setRedirectUris(client?.redirectUris??[]);setPermissions(client?.requiredResourceAccess??[]);$('clientGroups').checked=(client?.groupMembershipClaims??'SecurityGroup')==='SecurityGroup';$('emailOptionalClaim').checked=client?.emailOptionalClaim??true;clientTypeFields();clientEditor.open(client?.clientId??null)}
// Lists show only what identifies an item; every field stays editable in the dialog.
function listTable(root,headers){const table=document.createElement('table');table.className='data-table list-table';const head=document.createElement('thead'),headRow=document.createElement('tr');for(const text of headers){const th=document.createElement('th');th.scope='col';th.textContent=text;headRow.append(th)}head.append(headRow);const body=document.createElement('tbody');table.append(head,body);const wrap=document.createElement('div');wrap.className='table-wrap';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','一覧（横方向にスクロールできます）');wrap.append(table);root.replaceChildren(wrap);return body}
function rowActions(editId,onEdit,onDelete){const actions=document.createElement('div');actions.className='actions';const edit=document.createElement('button');edit.type='button';edit.textContent='編集';edit.dataset.editId=editId;edit.onclick=onEdit;const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='削除';del.onclick=onDelete;actions.append(edit,del);const td=document.createElement('td');td.className='ops';td.append(actions);return td}
function renderClients(items){setTokenChoices('client',items);const root=$('clients');$('clientCount').textContent='（'+items.length+' 件）';if(!items.length){root.textContent='登録済みの OIDC クライアントはありません。';return}const body=listTable(root,['クライアント ID（client_id）','認証区分（clientType）','プラットフォーム / リダイレクト URI','操作']);for(const client of items){const row=document.createElement('tr'),id=document.createElement('td'),code=document.createElement('code');code.textContent=client.clientId;id.append(code);const uris=document.createElement('td');for(const type of new Set(client.redirectUris.map(uri=>uri.type))){const group=document.createElement('div'),heading=document.createElement('strong');group.className='platform-summary';heading.textContent=platformTypes[type].label;group.append(heading);for(const uri of client.redirectUris.filter(uri=>uri.type===type)){const line=document.createElement('div');line.textContent=uri.uri;group.append(line)}uris.append(group)}row.append(id,cell(client.clientType),uris,rowActions(client.clientId,()=>openClient(client),async()=>{if(!confirm('OIDC クライアント（クライアント ID（client_id）：'+client.clientId+'）を削除しますか？'))return;clientEditor.beginChange();try{await request('/__mock/api/clients/'+encodeURIComponent(client.clientId),{method:'DELETE'});await loadClients();clientEditor.notice('OIDC クライアント「'+client.clientId+'」を削除しました。')}catch(error){$('clientError').textContent=message(error)}}));body.append(row)}}
async function loadClients(){await clientEditor.load()}
$('newClient').onclick=()=>openClient(null);$('clientType').onchange=()=>{clientTypeFields();clientEditor.clearFields(['clientType','clientSecret','tokenEndpointAuthMethod','platform','redirectUris'])};
$('clientForm').onsubmit=async event=>{event.preventDefault();if(permissionPickerOpen)return;try{const type=$('clientType').value,payload={clientType:type,...(type==='CONFIDENTIAL'?{clientSecret:$('clientSecret').value,tokenEndpointAuthMethod:$('authMethod').value}:{tokenEndpointAuthMethod:'none'}),redirectUris:readRedirectUris(),requiredResourceAccess:permissionDraft.map(item=>({resourceAppId:item.resourceAppId,scopes:[...item.scopes]})),emailOptionalClaim:$('emailOptionalClaim').checked,groupMembershipClaims:$('clientGroups').checked?'SecurityGroup':'None'};await clientEditor.save({clientId:$('clientId').value,...payload})}catch(error){$('editorError').textContent=message(error)}};
$('resetClients').onclick=async()=>{if(!confirm('すべての OIDC クライアントを初期状態に戻しますか？'))return;clientEditor.beginChange();try{clientEditor.replaceItems(await request('/__mock/api/clients/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));$('clientError').textContent='';clientEditor.notice('OIDC クライアントを初期状態に戻しました。')}catch(error){$('clientError').textContent=message(error)}};clientTypeFields();void loadClients();
function newUuid(){if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)}
function openUser(user){$('userSub').value=user?.sub??newUuid();$('userSub').disabled=!!user;$('userOid').value=user?.oid??newUuid();$('userName').value=user?.name??'';$('userPreferredUsername').value=user?.preferred_username??'';$('userMail').value=user?.mail??'';$('userGroups').value=(user?.groups??[]).join('\\n');userEditor.open(user?.sub??null)}
function renderUsers(items){setTokenChoices('user',items);const root=$('users');$('userCount').textContent='（'+items.length+' 件）';if(!items.length){root.textContent='登録済みのテストユーザーはありません。';return}const body=listTable(root,['表示名（name）','優先ユーザー名（preferred_username）','グループ（groups）','操作']);for(const user of items){const row=document.createElement('tr');row.append(cell(user.name),cell(user.preferred_username),cell(user.groups.join(', ')||'なし',user.groups.length?'':'muted'),rowActions(user.sub,()=>openUser(user),async()=>{if(!confirm('テストユーザー（ユーザー ID（sub）：'+user.sub+'）を削除しますか？'))return;userEditor.beginChange();try{await request('/__mock/api/users/'+encodeURIComponent(user.sub),{method:'DELETE'});await loadUsers();userEditor.notice('テストユーザー「'+user.name+'（'+user.sub+'）」を削除しました。')}catch(error){$('userError').textContent=message(error)}}));body.append(row)}}
async function loadUsers(){await userEditor.load()}
$('newUser').onclick=()=>openUser(null);
$('userForm').onsubmit=async event=>{event.preventDefault();const payload={oid:$('userOid').value.trim(),name:$('userName').value,preferred_username:$('userPreferredUsername').value,mail:$('userMail').value.trim(),groups:lines($('userGroups').value)},sub=$('userSub').value.trim();await userEditor.save({...(sub?{sub}:{}),...payload})};
$('resetUsers').onclick=async()=>{if(!confirm('すべてのテストユーザーを初期状態に戻しますか？'))return;userEditor.beginChange();try{userEditor.replaceItems(await request('/__mock/api/users/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));$('userError').textContent='';userEditor.notice('テストユーザーを初期状態に戻しました。')}catch(error){$('userError').textContent=message(error)}};void loadUsers();

function updateTokenResources(preserveScopes=false){const client=tokenClients.find(item=>item.clientId===$('tokenClient').value),select=$('tokenResource'),previous=select.value;select.replaceChildren();for(const permission of client?.requiredResourceAccess??[]){const option=document.createElement('option');option.value=permission.resourceAppId;option.textContent=permission.resourceAppId;select.append(option)}if(client?.requiredResourceAccess?.some(item=>item.resourceAppId===previous))select.value=previous;if(!preserveScopes||select.value!==previous)updateTokenScopes();updateTokenControls()}
function updateTokenScopes(){const permission=tokenClients.find(item=>item.clientId===$('tokenClient').value)?.requiredResourceAccess?.find(item=>item.resourceAppId===$('tokenResource').value);$('tokenScopes').value=permission?.scopes.join(' ')??''}
$('tokenResource').onchange=()=>{clearTokenResult();updateTokenScopes();updateTokenControls()};$('tokenScopes').oninput=$('tokenScopes').onchange=()=>{clearTokenResult();updateTokenControls()};
const resourceEditor=createEditor('resource','API','resourceAppId','resourceEditorError',renderResources,item=>item.identifierUri,{onItems:setPermissionCatalog,onLoadStart:permissionCatalogLoading,onLoadEnd:permissionCatalogSettled,onLoadError:permissionCatalogFailed});
function openResource(item){$('resourceAppId').value=item?.resourceAppId??newUuid();$('resourceAppId').disabled=!!item;$('resourceUri').value=item?.identifierUri??'api://'+$('resourceAppId').value;$('resourceScopes').value=(item?.scopes??['access_as_user']).join('\\n');$('resourceVersion').value=item?String(item.requestedAccessTokenVersion??''):'2';$('resourceEmail').checked=item?.emailOptionalClaim??true;$('resourceGroups').checked=(item?.groupMembershipClaims??'SecurityGroup')==='SecurityGroup';resourceEditor.open(item?.resourceAppId??null)}
function renderResources(items){$('resourceCount').textContent='（'+items.length+' 件）';const root=$('resources');if(!items.length){root.replaceChildren();root.textContent='登録済みのAPIはありません。';return}const body=listTable(root,['API ID','Application ID URI','バージョン','公開スコープ','操作']);for(const item of items){const row=document.createElement('tr');row.append(cell(item.resourceAppId),cell(item.identifierUri),cell(item.requestedAccessTokenVersion===2?'v2.0':'v1.0'),cell(item.scopes.join(', ')),rowActions(item.resourceAppId,()=>openResource(item),async()=>{if(!confirm('API「'+item.identifierUri+'」を削除しますか？'))return;resourceEditor.beginChange();try{await request('/__mock/api/resources/'+encodeURIComponent(item.resourceAppId),{method:'DELETE'});await resourceEditor.load();resourceEditor.notice('API「'+item.identifierUri+'」を削除しました。')}catch(error){$('resourceError').textContent=message(error)}}));body.append(row)}}
$('newResource').onclick=()=>openResource(null);$('resourceForm').onsubmit=async event=>{event.preventDefault();await resourceEditor.save({resourceAppId:$('resourceAppId').value,identifierUri:$('resourceUri').value,scopes:lines($('resourceScopes').value),requestedAccessTokenVersion:$('resourceVersion').value===''?null:Number($('resourceVersion').value),emailOptionalClaim:$('resourceEmail').checked,groupMembershipClaims:$('resourceGroups').checked?'SecurityGroup':'None'})};
$('resetResources').onclick=async()=>{if(!confirm('API を初期状態に戻しますか？'))return;resourceEditor.beginChange();try{resourceEditor.replaceItems(await request('/__mock/api/resources/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));resourceEditor.notice('APIを初期状態に戻しました。')}catch(error){$('resourceError').textContent=message(error)}};void resourceEditor.load();
</script></body></html>`;
}
