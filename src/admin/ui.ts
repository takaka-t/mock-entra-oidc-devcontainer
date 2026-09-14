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
select,input,textarea,button{font:inherit;padding:.4rem .5rem;border:1px solid #bdc7d3;border-radius:6px}select,input,textarea{width:100%;box-sizing:border-box}input[type=checkbox]{width:auto;padding:0}textarea{min-height:4rem}button{cursor:pointer;font-weight:650}.primary{background:#1261a0;color:white}.danger{background:#b42318;color:white}.actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start;margin-top:.5rem}.action{display:grid;gap:.15rem}.action-hint{margin:0;max-width:15rem;color:#64748b;font-size:.7rem}.action-hint.danger-hint{color:#b42318}.icon-button{display:grid;place-items:center;width:2.1rem;height:2.1rem;padding:0}.icon-button svg{width:1.1rem;height:1.1rem}.connection-value{display:flex;align-items:center;gap:.4rem;min-width:0}.connection-value code{min-width:0;overflow-wrap:anywhere}.connection-message{margin:.35rem 0 0;color:#64748b;font-size:.85rem}.connection-message:empty{margin:0}.hidden{display:none}.error,.warning{color:#b42318;white-space:pre-wrap}.error{margin:.5rem 0 0}.error:empty{margin:0}.warning{margin:.5rem 0}.hint{margin:.2rem 0 0;color:#64748b;font-size:.8rem}#testLogout{display:inline-block;padding:.4rem .5rem;border:1px solid #bdc7d3;border-radius:6px;text-decoration:none;color:inherit;font-weight:650}
dialog.editor{box-sizing:border-box;width:min(42rem,calc(100% - 2rem));max-height:calc(100dvh - 2rem);margin:auto;padding:1.25rem;border:0;border-radius:12px;color:inherit;background:white;overflow:auto;box-shadow:0 12px 40px #18324b40}dialog.editor::backdrop{background:#16202a80}.editor-header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.editor-header h2{margin:0;font-size:1.2rem}.editor-header button{flex-shrink:0}.editor .actions{position:sticky;bottom:-1.25rem;background:white;padding:.75rem 0}.editor .error,.notice{overflow-wrap:anywhere}.notice{position:fixed;top:1rem;right:1rem;z-index:1000;display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;width:min(24rem,calc(100% - 2rem));padding:.75rem;border:1px solid #159957;border-radius:8px;background:#edf9f1;color:#14532d;box-shadow:0 8px 24px #18324b40}#userNotice{top:5rem}.notice.hidden{display:none}.notice p{margin:0}.notice button{flex-shrink:0}button:disabled{cursor:wait;opacity:.65}
details.card>summary{display:flex;align-items:center;gap:.5rem;cursor:pointer;list-style:none}details.card>summary::-webkit-details-marker{display:none}details.card>summary::before{content:"";flex-shrink:0;width:.5rem;height:.5rem;margin:0 .2rem 0 .1rem;border-right:2px solid #475569;border-bottom:2px solid #475569;transform:rotate(-45deg);transition:transform .15s}details.card[open]>summary::before{transform:rotate(45deg)}details.card>summary h2{margin:0}details.card[open]>summary{margin-bottom:.5rem}.count{font-weight:400;font-size:.85rem;color:#64748b}
.log-wrap{max-height:min(28rem,55vh);overflow:auto;margin-top:.5rem}.data-table{width:100%;border-collapse:collapse;font-size:.85rem}.data-table th,.data-table td{padding:.3rem .5rem;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}.data-table th{position:sticky;top:0;z-index:1;background:white;font-size:.7rem;font-weight:600;color:#64748b}.data-table td{min-width:0;overflow-wrap:anywhere}.data-table code{overflow-wrap:anywhere}.list-table td.ops{width:1%;white-space:nowrap}.list-table .actions{margin-top:0;flex-wrap:nowrap}.log-table th,.log-table td{white-space:nowrap}.log-table td.path{min-width:12rem;white-space:normal;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.log-table td.scenario{min-width:14rem;white-space:normal;overflow-wrap:anywhere}.log-table tr.injected{background:#fff1f0}.status-ok{color:#159957;font-weight:700}.status-error{color:#b42318;font-weight:700}.muted{color:#64748b}
</style></head><body><main class="wrap"><h1>Mock OIDC Provider 管理画面</h1>
<details class="card" id="connectionPanel"><summary><h2>アプリ接続情報</h2></summary><div class="grid"><div><div class="label">認可サーバー URL（Authority URL）</div><div class="connection-value"><code id="authorityUrl">${escapeHtml(issuer)}</code><button id="copyAuthority" class="icon-button" type="button" aria-label="認可サーバー URL（Authority URL）をコピー" title="認可サーバー URL（Authority URL）をコピー"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button></div></div><div><div class="label">テナント ID（tid）</div><div class="connection-value"><code id="tenantId">${escapeHtml(tenantId)}</code><button id="copyTenantId" class="icon-button" type="button" aria-label="テナント ID（tid）をコピー" title="テナント ID（tid）をコピー"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button></div></div></div><p id="connectionMessage" class="connection-message" aria-live="polite"></p></details>
<section id="state" class="card state"><div class="state-header"><h2>シナリオ</h2><div class="state-tools"><a id="testLogout" href="${escapeHtml(logoutUrl)}" target="_blank" rel="noopener noreferrer" title="ブラウザに保持された Mock IdP のセッションでログアウト（RP-Initiated Logout）画面の動作を確認できます。">ログアウトをテスト</a><button id="refresh" class="icon-button" type="button" aria-label="状態を再読み込み" title="状態を再読み込み"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 16.24 7.76L13 11h7V4z"/></svg></button></div></div><div class="state-current"><div class="state-now"><div class="label">現在のシナリオ</div><div id="current" class="value">読み込み中…</div></div><div class="grid state-grid" role="group" aria-label="実行状況">
<div><div class="label">状態</div><div id="status" class="value">—</div></div><div><div class="label">実行モード</div><div id="currentMode" class="value">—</div></div>
<div><div class="label">設定した失敗回数</div><div id="initial" class="value">—</div></div><div><div class="label">残り失敗回数</div><div id="remaining" class="value">—</div></div>
<div><div class="label">発生回数</div><div id="triggered" class="value">0</div></div></div></div><div class="history"><div class="label">直近で完了したシナリオ</div><div id="history" class="value history-value">なし</div></div>
<form id="form" class="scenario-form"><h3 class="state-details-title">シナリオの設定</h3><div class="fields"><div id="scenarioField"><label for="scenario">シナリオ</label><select id="scenario">${options}</select><p class="hint">各シナリオの詳細は README の「シナリオ API」を参照してください。＊は必須項目です</p></div>
<div id="modeFields" class="contents"><div id="modeField"><label for="mode">実行モード</label><select id="mode"><option>CONTINUOUS</option><option>LIMITED</option></select></div>
<div id="countField" class="hidden"><label for="failureCount" class="required">失敗回数</label><input id="failureCount" type="number" min="1" step="1" value="1" required></div>
<div id="delayField" class="hidden"><label for="delayMs">遅延時間（ms）</label><input id="delayMs" type="number" min="1" max="${scenarioUiDefaults.maxDelayMs}" step="1" value="${scenarioUiDefaults.delayMs}"></div>
<div id="retryAfterRequiredField" class="hidden"><label for="retryAfterRequired" class="required">Retry-After（秒）</label><input id="retryAfterRequired" type="number" min="1" step="1" value="${scenarioUiDefaults.retryAfterSeconds}" required></div>
<div id="retryAfterOptionalField" class="hidden"><label for="retryAfterOptional">Retry-After（秒、任意）</label><input id="retryAfterOptional" type="number" min="1" step="1" placeholder="Retry-Afterヘッダーを付与しない"></div>
<div id="errorFields" class="hidden"><label for="errorCode">OAuth エラー（error）</label><input id="errorCode" value="${scenarioUiDefaults.tokenError}"><label for="errorDescription">エラーの説明（errorDescription）</label><input id="errorDescription"></div></div></div>
<p id="rolloverNote" class="warning">SIGNING_KEY_ROLLOVERを有効にすると、シナリオの完了後、NORMALに戻した後、または別のシナリオを選択した後も、新しい署名鍵はJWKSで公開され続けます。シナリオを初期状態に戻すと、初期の鍵セットに戻ります。</p>
<div class="actions"><button class="primary" type="submit">適用</button><div class="action"><button id="normal" type="button">NORMALに戻す</button><p class="action-hint">シナリオを停止します（履歴は残ります）</p></div><div class="action"><button id="reset" class="danger" type="button">シナリオを初期状態に戻す</button><p class="action-hint danger-hint">履歴と鍵の状態を初期化します</p></div></div><p id="error" class="error" aria-live="polite"></p></form></section>
<details class="card" id="accessLogPanel"><summary><h2>アクセスログ <span id="accessLogCount" class="count"></span></h2></summary>
<div class="actions"><button id="refreshAccessLog" type="button">アクセスログを再読み込み</button><div class="action"><button id="clearAccessLog" class="danger" type="button">アクセスログをクリア</button><p class="action-hint danger-hint">記録済みのアクセスログをすべて削除します（シナリオの状態は変わりません）</p></div></div>
<p class="hint">Mock IdP が受け付けた OIDC 関連リクエストの履歴です（新しい順。最新 ${accessLogCapacity} 件をメモリ上に保持し、再起動で消えます）。管理画面・管理 API へのアクセス（ブラウザが自動的に要求する /favicon.ico を含む）と、query・本文・ヘッダーは記録しません。「シナリオ」列は受付時に有効だったシナリオで、実際に障害が注入された行は「適用」と赤い背景で示します。自動更新はしないため、再読み込みボタンで最新の状態を取得してください。</p>
<p id="accessLogError" class="error" role="alert"></p>
<div class="log-wrap"><table id="accessLog" class="data-table log-table"><thead><tr><th scope="col">時刻</th><th scope="col">メソッド</th><th scope="col">エンドポイント</th><th scope="col">パス</th><th scope="col">ステータス</th><th scope="col">所要時間</th><th scope="col">シナリオ</th></tr></thead><tbody id="accessLogRows"><tr><td colspan="7">読み込み中…</td></tr></tbody></table></div>
</details>
<details class="card" id="clientPanel"><summary><h2>OIDC クライアント一覧 <span id="clientCount" class="count"></span></h2></summary><p class="warning">クライアントシークレットは平文で保存・表示されます。このAdmin APIには認証がないため、インターネットに公開しないでください。</p>
<div id="clientNotice" class="notice hidden"><p id="clientMessage" role="status" aria-atomic="true"></p><button id="dismissClientNotice" type="button" aria-label="OIDC クライアントの通知を閉じる">閉じる</button></div><p id="clientError" class="error" role="alert"></p><button id="retryClients" class="hidden" type="button">一覧を再読み込み</button>
<div id="clients">読み込み中…</div><div class="actions"><button id="newClient" class="primary" type="button">OIDC クライアントを登録</button><button id="resetClients" class="danger" type="button">OIDC クライアントを初期状態に戻す</button></div></details>
<dialog id="clientEditor" class="editor" aria-labelledby="clientEditorTitle"><div class="editor-header"><h2 id="clientEditorTitle">OIDC クライアントを登録</h2><button id="closeClient" type="button" aria-label="OIDC クライアントのダイアログを閉じる">閉じる</button></div><form id="clientForm">
<p class="hint">＊は必須項目です</p>
<label for="clientId" class="required">クライアント ID（client_id）</label><input id="clientId" pattern="${escapeHtml(identifierInputPattern)}" title="${identifierHint}" required><p class="hint">${identifierHint}</p>
<label for="clientType">クライアント種別（clientType）</label><select id="clientType"><option>PUBLIC</option><option>CONFIDENTIAL</option></select>
<div id="secretFields"><label for="clientSecret" class="required">クライアントシークレット（client_secret）</label><input id="clientSecret"><label for="authMethod">トークンエンドポイント認証方式（tokenEndpointAuthMethod）</label><select id="authMethod"><option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option></select></div>
<label for="redirectUris" class="required">リダイレクト URI（redirectUris、1行に1件）</label><textarea id="redirectUris" required></textarea>
<label for="logoutUris">ログアウト後のリダイレクト URI（postLogoutRedirectUris、1行に1件）</label><textarea id="logoutUris"></textarea>
<label for="audience" class="required">アクセストークンの対象者（accessTokenAudience / aud）</label><input id="audience" value="urn:mock-api" required>
<label for="scope" class="required">アクセストークンのスコープ（accessTokenScope / scp）</label><input id="scope" value="access_as_user" required>
<label><input id="emailOptionalClaim" type="checkbox"> email claim（email）をオプションの claim として常に含める（email スコープの要求有無にかかわらず付与）</label>
<p id="editorError" class="error" role="alert" tabindex="-1"></p><div class="actions"><button id="saveClient" class="primary" type="submit">登録</button><button id="cancelClient" type="button">キャンセル</button></div></form></dialog>
<details class="card" id="userPanel"><summary><h2>テストユーザー一覧 <span id="userCount" class="count"></span></h2></summary><p class="hint">サインイン画面に表示されるユーザーです。テナント ID（tid）は常にこの Mock の値になります。</p>
<div id="userNotice" class="notice hidden"><p id="userMessage" role="status" aria-atomic="true"></p><button id="dismissUserNotice" type="button" aria-label="テストユーザーの通知を閉じる">閉じる</button></div><p id="userError" class="error" role="alert"></p><button id="retryUsers" class="hidden" type="button">一覧を再読み込み</button>
<div id="users">読み込み中…</div><div class="actions"><button id="newUser" class="primary" type="button">テストユーザーを登録</button><button id="resetUsers" class="danger" type="button">テストユーザーを初期状態に戻す</button></div></details>
<dialog id="userEditor" class="editor" aria-labelledby="userEditorTitle"><div class="editor-header"><h2 id="userEditorTitle">テストユーザーを登録</h2><button id="closeUser" type="button" aria-label="テストユーザーのダイアログを閉じる">閉じる</button></div><form id="userForm">
<p class="hint">＊は必須項目です</p>
<label for="userSub">ユーザー ID（sub）</label><input id="userSub" pattern="${escapeHtml(identifierInputPattern)}" title="${identifierHint}"><p class="hint">${identifierHint} 保存後は変更できません。未入力の場合はランダムな UUID を自動生成します。</p>
<label for="userOid" class="required">オブジェクト ID（oid）</label><input id="userOid" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" required><p class="hint">GUID形式で入力してください。</p>
<label for="userName" class="required">表示名（name）</label><input id="userName" required>
<label for="userPreferredUsername" class="required">優先ユーザー名（preferred_username）</label><input id="userPreferredUsername" required>
<label for="userMail" class="required">メールアドレス（mail）</label><input id="userMail" type="email" required><p class="hint">email claim（email）として返されます。</p>
<label for="userGroups">グループ（groups）</label><textarea id="userGroups"></textarea><p class="hint">1行に1件入力してください。</p>
<p id="userEditorError" class="error" role="alert" tabindex="-1"></p><div class="actions"><button id="saveUser" class="primary" type="submit">登録</button><button id="cancelUser" type="button">キャンセル</button></div></form></dialog>
</main><script>
const $=id=>document.getElementById(id),metadata=${uiMetadata},defaults=${uiDefaults},connection=${connectionValues};
let sequence=0,lastSettled=0,pendingUpdates=0;
function copyFallback(value){const textarea=document.createElement('textarea');textarea.value=value;textarea.style.position='fixed';textarea.style.opacity='0';document.body.append(textarea);textarea.select();const copied=document.execCommand('copy');textarea.remove();if(!copied)throw new Error('copy failed')}
async function copyConnectionValue(key,label){try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(connection[key]);else copyFallback(connection[key]);$('connectionMessage').textContent=label+'をコピーしました'}catch{try{copyFallback(connection[key]);$('connectionMessage').textContent=label+'をコピーしました'}catch{$('connectionMessage').textContent=label+'をコピーできませんでした。値を選択してコピーしてください。'}}}
$('copyAuthority').onclick=()=>void copyConnectionValue('authorityUrl','認可サーバー URL（Authority URL）');$('copyTenantId').onclick=()=>void copyConnectionValue('tenantId','テナント ID（tid）');
function fields(){const info=metadata[$('scenario').value],m=$('mode').value,limited=m==='LIMITED'&&info.supportsMode,retryRequired=info.parameterKind==='retryAfterRequired',retryOptional=info.parameterKind==='retryAfterOptional';$('modeFields').classList.toggle('hidden',!info.supportsMode);$('countField').classList.toggle('hidden',!limited);$('failureCount').disabled=!limited;$('failureCount').required=limited;$('delayField').classList.toggle('hidden',info.parameterKind!=='timeout');$('retryAfterRequiredField').classList.toggle('hidden',!retryRequired);$('retryAfterRequired').disabled=!retryRequired;$('retryAfterRequired').required=retryRequired;$('retryAfterOptionalField').classList.toggle('hidden',!retryOptional);$('retryAfterOptional').disabled=!retryOptional;$('errorFields').classList.toggle('hidden',info.parameterKind!=='token400')}
async function request(url,opts){const r=await fetch(url,opts),raw=await r.text(),data=raw?JSON.parse(raw):null;if(!r.ok)throw new Error(data?.message||raw||r.statusText);return data}
function render(s){$('current').textContent=s.scenario;$('currentMode').textContent=s.mode??'—';$('initial').textContent=s.initialFailureCount??'—';$('remaining').textContent=s.remainingFailures??'—';$('triggered').textContent=s.triggeredCount;$('status').textContent=s.status;$('state').classList.toggle('fault',s.status==='ACTIVE');$('history').textContent=s.lastCompleted?(s.lastCompleted.scenario+' — '+s.lastCompleted.triggeredCount+'回 — '+s.lastCompleted.completedAt):'なし'}
function renderLatest(id,state){if(id<lastSettled)return false;lastSettled=id;render(state);return true}
function showLatestError(id,error,visible=true){if(id<lastSettled)return;lastSettled=id;if(visible)$('error').textContent=message(error)}
function message(error){return error instanceof Error?error.message:String(error)}
async function refresh(showError=true){if(pendingUpdates)return;const id=++sequence;try{if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error,showError)}}
async function update(url,options){pendingUpdates++;let id=++sequence;try{await request(url,options);id=++sequence;if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error)}finally{pendingUpdates--}}
$('scenario').onchange=fields;$('mode').onchange=fields;$('form').onsubmit=e=>{e.preventDefault();const scenario=$('scenario').value,info=metadata[scenario];let body={scenario};if(info.supportsMode){body.mode=$('mode').value;if(body.mode==='LIMITED')body.failureCount=Number($('failureCount').value);if(info.parameterKind==='timeout')body.parameters={delayMs:Number($('delayMs').value||defaults.delayMs)};if(info.parameterKind==='retryAfterRequired')body.parameters={retryAfterSeconds:Number($('retryAfterRequired').value||defaults.retryAfterSeconds)};if(info.parameterKind==='retryAfterOptional'&&$('retryAfterOptional').value)body.parameters={retryAfterSeconds:Number($('retryAfterOptional').value)};if(info.parameterKind==='token400')body.parameters={error:$('errorCode').value||defaults.tokenError,...($('errorDescription').value?{errorDescription:$('errorDescription').value}:{})}}void update('/__mock/api/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)})};
$('normal').onclick=()=>void update('/__mock/api/scenario',{method:'DELETE'});$('reset').onclick=()=>void update('/__mock/api/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});$('refresh').onclick=()=>void refresh();fields();void refresh();
const endpointLabels={discovery:'Discovery',authorization:'認可',interaction:'サインイン画面',token:'トークン',jwks:'JWKS',logout:'ログアウト','connectivity-probe':'接続性プローブ',other:'その他'};
const effectLabels={'authorization-denied':'OAuth エラーを redirect で返却','authorization-error':'OAuth エラーを redirect で返却','claims-mutation':'claim を改変','token-mutation':'トークンを改変','signing-key-rollover':'新しい署名鍵で署名','http-400':'HTTP 400 を返却','http-429':'HTTP 429 を返却','http-500':'HTTP 500 を返却','jwks-invalid':'不正な JWKS を返却','http-timeout':'応答を遅延'};
let accessLogSequence=0;
function formatTime(iso){const date=new Date(iso);if(Number.isNaN(date.getTime()))return iso;return date.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+'.'+String(date.getMilliseconds()).padStart(3,'0')}
function describeScenario(entry){if(entry.fault){const fault=entry.fault,effect=effectLabels[metadata[fault.scenario]?.effect]??'障害を注入',remaining=fault.mode==='LIMITED'?'、残り '+fault.remainingBefore+'→'+fault.remainingAfter:'',params=Object.entries(fault.parameters??{}).map(([key,value])=>key+'='+value).join(', ');return fault.scenario+' 適用 — '+effect+'（'+fault.mode+remaining+(params?'、'+params:'')+'）'}return entry.scenario==='NORMAL'?'—':entry.scenario+' 未適用'}
function cell(text,className,title){const td=document.createElement('td');td.textContent=text;if(className)td.className=className;if(title)td.title=title;return td}
function renderAccessLog(entries){const root=$('accessLogRows');root.replaceChildren();$('accessLogCount').textContent='（'+entries.length+' 件）';if(!entries.length){const row=document.createElement('tr'),empty=document.createElement('td');empty.colSpan=7;empty.textContent='アクセスログはありません。';row.append(empty);root.append(row);return}for(const entry of entries){const row=document.createElement('tr');if(entry.fault)row.className='injected';const aborted=entry.statusCode===null;row.append(cell(formatTime(entry.receivedAt),'',entry.receivedAt),cell(entry.method),cell(endpointLabels[entry.endpoint]??entry.endpoint),cell(entry.path,'path'),cell(aborted?'中断':String(entry.statusCode),aborted||entry.statusCode>=400?'status-error':'status-ok',aborted?'応答を返す前にクライアントが切断しました':''),cell(entry.durationMs+' ms'),cell(describeScenario(entry),entry.fault?'scenario':'scenario muted'));root.append(row)}}
async function loadAccessLog(){const id=++accessLogSequence;try{const entries=await request('/__mock/api/access-log');if(id!==accessLogSequence)return;renderAccessLog(entries);$('accessLogError').textContent=''}catch(error){if(id!==accessLogSequence)return;$('accessLogError').textContent='アクセスログを読み込めませんでした。 '+message(error);revealPanel('accessLogPanel')}}
$('refreshAccessLog').onclick=()=>void loadAccessLog();
$('clearAccessLog').onclick=async()=>{if(!confirm('アクセスログをクリアしますか？'))return;try{await request('/__mock/api/access-log',{method:'DELETE'})}catch(error){$('accessLogError').textContent='アクセスログをクリアできませんでした。 '+message(error);revealPanel('accessLogPanel');return}await loadAccessLog()};
void loadAccessLog();
// Collapsed panels are a per-browser convenience; storage may be unavailable, so every access is best effort.
const panelStorageKey='mock-idp-admin-panels';
function savedPanels(){try{const saved=JSON.parse(localStorage.getItem(panelStorageKey)??'{}');return saved&&typeof saved==='object'?saved:{}}catch{return{}}}
// Panels the page opens itself (to surface an error) are not a user preference, so that toggle is not saved.
function revealPanel(id){const panel=$(id);if(panel.open)return;panel.dataset.autoOpen='';panel.open=true}
for(const panel of document.querySelectorAll('details.card')){const saved=savedPanels()[panel.id];if(typeof saved==='boolean')panel.open=saved;panel.addEventListener('toggle',()=>{if('autoOpen' in panel.dataset){delete panel.dataset.autoOpen;return}try{localStorage.setItem(panelStorageKey,JSON.stringify({...savedPanels(),[panel.id]:panel.open}))}catch{}})}
function lines(value){return [...new Set(value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean))]}
// Shared lifecycle keeps both editors consistent, including partial save success.
function createEditor(kind, label, idKey, errorId, renderItems, describeItem) {
  const cap = kind[0].toUpperCase() + kind.slice(1),
    dialog = $(kind + 'Editor'),
    form = $(kind + 'Form'),
    submit = $('save' + cap),
    editorError = $(errorId),
    list = $(kind + 's'),
    listError = $(kind + 'Error'),
    notice = $(kind + 'Notice'),
    noticeMessage = $(kind + 'Message'),
    retry = $('retry' + cap + 's'),
    newButton = $('new' + cap),
    url = '/__mock/api/' + kind + 's';
  let editingId = null,
    initialValues = '',
    opener = null,
    busy = false,
    disabledBeforeSave = [],
    loadSequence = 0,
    savedRefreshPending = false,
    noticeTimer = null;
  const inputs = () => [...form.querySelectorAll('input,select,textarea')];
  const snapshot = () =>
    JSON.stringify(
      inputs().map((input) =>
        input.type === 'checkbox' ? input.checked : input.value,
      ),
    );
  const editButton = (id) =>
    [...list.querySelectorAll('button[data-edit-id]')].find(
      (button) => button.dataset.editId === id,
    );
  function clearNotice() {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    notice.classList.add('hidden');
    noticeMessage.textContent = '';
  }
  function scheduleNoticeHide() {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(clearNotice, 10000);
  }
  notice.addEventListener('mouseenter', () => {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
  });
  notice.addEventListener('mouseleave', () => {
    if (!notice.classList.contains('hidden')) scheduleNoticeHide();
  });
  notice.addEventListener('focusin', () => {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
  });
  notice.addEventListener('focusout', () => {
    if (!notice.classList.contains('hidden')) scheduleNoticeHide();
  });
  function beginChange() {
    clearNotice();
    listError.textContent = '';
    retry.classList.add('hidden');
    savedRefreshPending = false;
    loadSequence++;
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
  }
  function close() {
    const target = opener?.isConnected
      ? opener
      : (editButton(editingId) ?? newButton);
    dialog.close();
    form.reset();
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
  $('dismiss' + cap + 'Notice').onclick = () => {
    clearNotice();
    newButton.focus({ preventScroll: true });
  };
  function open(id) {
    clearNotice();
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
  async function load(saved = false) {
    savedRefreshPending = savedRefreshPending || saved;
    const sequence = ++loadSequence;
    retry.disabled = true;
    try {
      const items = await request(url);
      if (sequence !== loadSequence) return;
      const focused = document.activeElement,
        focusedId = list.contains(focused) ? focused.dataset.editId : undefined;
      renderItems(items);
      listError.textContent = '';
      retry.classList.add('hidden');
      savedRefreshPending = false;
      if (focusedId !== undefined)
        (editButton(focusedId) ?? newButton).focus({ preventScroll: true });
      else if (focused === retry) newButton.focus({ preventScroll: true });
    } catch (error) {
      if (sequence !== loadSequence) return;
      listError.textContent =
        (savedRefreshPending
          ? '保存は完了しましたが、一覧を更新できませんでした。'
          : '一覧を読み込めませんでした。') +
        ' ' +
        message(error);
      retry.classList.remove('hidden');
      revealPanel(kind + 'Panel');
    } finally {
      if (sequence === loadSequence) retry.disabled = false;
    }
  }
  retry.onclick = () => void load();
  async function save(payload) {
    if (busy || !dialog.open) return;
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
      editorError.textContent = message(error);
      editorError.focus();
      return;
    }
    setBusy(false);
    close();
    notice.classList.remove('hidden');
    noticeMessage.textContent =
      label +
      '「' +
      describeItem(item) +
      '」を' +
      (isUpdate ? '更新' : '登録') +
      'しました。';
    scheduleNoticeHide();
    await load(true);
  }
  return { open, save, load, beginChange };
}
const clientEditor = createEditor(
  'client',
  'OIDC クライアント',
  'clientId',
  'editorError',
  renderClients,
  (client) => client.clientId,
);
const userEditor = createEditor(
  'user',
  'テストユーザー',
  'sub',
  'userEditorError',
  renderUsers,
  (user) => user.name + '（' + user.sub + '）',
);
function clientTypeFields(){$('secretFields').classList.toggle('hidden',$('clientType').value==='PUBLIC')}
function openClient(client){$('clientId').value=client?.clientId??'';$('clientId').disabled=!!client;$('clientType').value=client?.clientType??'PUBLIC';$('clientSecret').value=client?.clientSecret??'';$('authMethod').value=client?.tokenEndpointAuthMethod==='client_secret_post'?'client_secret_post':'client_secret_basic';$('redirectUris').value=(client?.redirectUris??['http://localhost:3000/callback']).join('\\n');$('logoutUris').value=(client?.postLogoutRedirectUris??[]).join('\\n');$('audience').value=client?.accessTokenAudience??'urn:mock-api';$('scope').value=client?.accessTokenScope??'access_as_user';$('emailOptionalClaim').checked=client?.emailOptionalClaim??false;clientTypeFields();clientEditor.open(client?.clientId??null)}
// Lists show only what identifies an item; every field stays editable in the dialog.
function listTable(root,headers){const table=document.createElement('table');table.className='data-table list-table';const head=document.createElement('thead'),headRow=document.createElement('tr');for(const text of headers){const th=document.createElement('th');th.scope='col';th.textContent=text;headRow.append(th)}head.append(headRow);const body=document.createElement('tbody');table.append(head,body);root.replaceChildren(table);return body}
function rowActions(editId,onEdit,onDelete){const actions=document.createElement('div');actions.className='actions';const edit=document.createElement('button');edit.type='button';edit.textContent='編集';edit.dataset.editId=editId;edit.onclick=onEdit;const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='削除';del.onclick=onDelete;actions.append(edit,del);const td=document.createElement('td');td.className='ops';td.append(actions);return td}
function renderClients(items){const root=$('clients');$('clientCount').textContent='（'+items.length+' 件）';if(!items.length){root.textContent='登録済みの OIDC クライアントはありません。';return}const body=listTable(root,['クライアント ID（client_id）','種別（clientType）','リダイレクト URI（redirectUris）','操作']);for(const client of items){const row=document.createElement('tr'),id=document.createElement('td'),code=document.createElement('code');code.textContent=client.clientId;id.append(code);const uris=document.createElement('td');for(const uri of client.redirectUris){const line=document.createElement('div');line.textContent=uri;uris.append(line)}row.append(id,cell(client.clientType),uris,rowActions(client.clientId,()=>openClient(client),async()=>{if(!confirm('OIDC クライアント（クライアント ID（client_id）：'+client.clientId+'）を削除しますか？'))return;clientEditor.beginChange();try{await request('/__mock/api/clients/'+encodeURIComponent(client.clientId),{method:'DELETE'});await loadClients()}catch(error){$('clientError').textContent=message(error)}}));body.append(row)}}
async function loadClients(){await clientEditor.load()}
$('newClient').onclick=()=>openClient(null);$('clientType').onchange=clientTypeFields;
$('clientForm').onsubmit=async event=>{event.preventDefault();const type=$('clientType').value,payload={clientType:type,...(type==='CONFIDENTIAL'?{clientSecret:$('clientSecret').value,tokenEndpointAuthMethod:$('authMethod').value}:{tokenEndpointAuthMethod:'none'}),redirectUris:lines($('redirectUris').value),postLogoutRedirectUris:lines($('logoutUris').value),accessTokenAudience:$('audience').value,accessTokenScope:$('scope').value,emailOptionalClaim:$('emailOptionalClaim').checked};await clientEditor.save({clientId:$('clientId').value,...payload})};
$('resetClients').onclick=async()=>{if(!confirm('すべての OIDC クライアントを初期状態に戻しますか？'))return;clientEditor.beginChange();try{renderClients(await request('/__mock/api/clients/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));$('clientError').textContent=''}catch(error){$('clientError').textContent=message(error)}};clientTypeFields();void loadClients();
function newUuid(){if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)}
function openUser(user){$('userSub').value=user?.sub??newUuid();$('userSub').disabled=!!user;$('userOid').value=user?.oid??newUuid();$('userName').value=user?.name??'';$('userPreferredUsername').value=user?.preferred_username??'';$('userMail').value=user?.mail??'';$('userGroups').value=(user?.groups??[]).join('\\n');userEditor.open(user?.sub??null)}
function renderUsers(items){const root=$('users');$('userCount').textContent='（'+items.length+' 件）';if(!items.length){root.textContent='登録済みのテストユーザーはありません。';return}const body=listTable(root,['表示名（name）','優先ユーザー名（preferred_username）','グループ（groups）','操作']);for(const user of items){const row=document.createElement('tr');row.append(cell(user.name),cell(user.preferred_username),cell(user.groups.join(', ')||'なし',user.groups.length?'':'muted'),rowActions(user.sub,()=>openUser(user),async()=>{if(!confirm('テストユーザー（ユーザー ID（sub）：'+user.sub+'）を削除しますか？'))return;userEditor.beginChange();try{await request('/__mock/api/users/'+encodeURIComponent(user.sub),{method:'DELETE'});await loadUsers()}catch(error){$('userError').textContent=message(error)}}));body.append(row)}}
async function loadUsers(){await userEditor.load()}
$('newUser').onclick=()=>openUser(null);
$('userForm').onsubmit=async event=>{event.preventDefault();const payload={oid:$('userOid').value.trim(),name:$('userName').value,preferred_username:$('userPreferredUsername').value,mail:$('userMail').value.trim(),groups:lines($('userGroups').value)},sub=$('userSub').value.trim();await userEditor.save({...(sub?{sub}:{}),...payload})};
$('resetUsers').onclick=async()=>{if(!confirm('すべてのテストユーザーを初期状態に戻しますか？'))return;userEditor.beginChange();try{renderUsers(await request('/__mock/api/users/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));$('userError').textContent=''}catch(error){$('userError').textContent=message(error)}};void loadUsers();
</script></body></html>`;
}
