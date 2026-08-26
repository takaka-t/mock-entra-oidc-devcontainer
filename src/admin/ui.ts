import {
  scenarioUiDefaults,
  scenarioUiMetadata,
} from "../scenario/registry.js";

const options = Object.entries(scenarioUiMetadata)
  .map(
    ([name, metadata]) => `<option value="${name}">${metadata.label}</option>`,
  )
  .join("");
const uiMetadata = JSON.stringify(scenarioUiMetadata).replaceAll(
  "<",
  "\\u003c",
);
const uiDefaults = JSON.stringify(scenarioUiDefaults);

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function renderAdminHtml(tenantId: string, issuer: string): string {
  const connectionValues = JSON.stringify({
    authorityUrl: issuer,
    tenantId,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock OIDC Provider</title><style>
:root{font-family:ui-sans-serif,system-ui;color:#16202a;background:#eef2f6}body{margin:0;padding:1rem}.wrap{max-width:900px;margin:auto}
h1{margin:0 0 .75rem;font-size:1.45rem}.card{background:white;border-radius:12px;padding:1rem;margin:.75rem 0;box-shadow:0 2px 12px #18324b18}.card h2{margin:0 0 .75rem;font-size:1.2rem}
.state{border-left:8px solid #159957}.state.fault{border-color:#d33b32}.state-header{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.75rem}.state-header h2{margin:0;font-size:1.05rem}.state-current{min-width:0;padding:.75rem;background:#f8fafc;border-radius:8px}.state-current .value{font-size:1.2rem}.state-details{margin-top:.75rem}.state-details-title{margin:0 0 .5rem;font-size:.82rem;color:#475569}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem}.state-grid>div{min-width:0}.state .value,.history-value{min-width:0;overflow-wrap:anywhere;word-break:break-word}.history{margin-top:.75rem;padding-top:.75rem;border-top:1px solid #d9e0e7}
.label{font-size:.72rem;color:#64748b}.value{font-size:1rem;font-weight:700;margin-top:.15rem}label{display:block;margin:.55rem 0 .2rem}
select,input,textarea,button{font:inherit;padding:.5rem;border:1px solid #bdc7d3;border-radius:6px}select,input,textarea{width:100%;box-sizing:border-box}input[type=checkbox]{width:auto;padding:0}textarea{min-height:4rem}button{cursor:pointer;font-weight:650}.primary{background:#1261a0;color:white}.danger{background:#b42318;color:white}.actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start;margin-top:.75rem}.action{display:grid;gap:.25rem}.action-hint{margin:0;max-width:15rem;color:#64748b;font-size:.72rem}.action-hint.danger-hint{color:#b42318}.icon-button{display:grid;place-items:center;width:2.3rem;height:2.3rem;padding:0}.icon-button svg{width:1.1rem;height:1.1rem}.connection-value{display:flex;align-items:flex-start;gap:.4rem;min-width:0}.connection-value code{min-width:0;overflow-wrap:anywhere}.connection-message{min-height:1rem;margin:.5rem 0 0;color:#64748b;font-size:.85rem}.hidden{display:none}.error,.warning{color:#b42318;white-space:pre-wrap}.warning{margin:.75rem 0}.hint{margin:.25rem 0 0;color:#64748b;font-size:.82rem}.client{border-top:1px solid #d9e0e7;padding:.75rem 0}.client:first-child{border-top:0}.client code{overflow-wrap:anywhere}
</style></head><body><main class="wrap"><h1>Mock OIDC Provider</h1>
<section class="card"><h2>アプリ接続情報</h2><div class="grid"><div><div class="label">Authority URL</div><div class="connection-value"><code id="authorityUrl">${escapeHtml(issuer)}</code><button id="copyAuthority" class="icon-button" type="button" aria-label="Authority URLをコピー" title="Authority URLをコピー"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button></div></div><div><div class="label">Tenant ID</div><div class="connection-value"><code id="tenantId">${escapeHtml(tenantId)}</code><button id="copyTenantId" class="icon-button" type="button" aria-label="Tenant IDをコピー" title="Tenant IDをコピー"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button></div></div></div><p id="connectionMessage" class="connection-message" aria-live="polite"></p></section>
<section id="state" class="card state"><div class="state-header"><h2>シナリオの状態</h2><button id="refresh" class="icon-button" type="button" aria-label="状態を再読み込み" title="状態を再読み込み"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 16.24 7.76L13 11h7V4z"/></svg></button></div><div class="state-current"><div class="label">現在のシナリオ</div><div id="current" class="value">読み込み中…</div></div><div class="state-details"><h3 class="state-details-title">実行状況</h3><div class="grid state-grid">
<div><div class="label">状態</div><div id="status" class="value">—</div></div><div><div class="label">実行モード</div><div id="currentMode" class="value">—</div></div>
<div><div class="label">設定した失敗回数</div><div id="initial" class="value">—</div></div><div><div class="label">残り失敗回数</div><div id="remaining" class="value">—</div></div>
<div><div class="label">発生回数</div><div id="triggered" class="value">0</div></div></div></div><div class="history"><div class="label">直近で完了したシナリオ</div><div id="history" class="value history-value">なし</div></div></section>
<section class="card"><form id="form"><label for="scenario">シナリオ</label><select id="scenario">${options}</select><p class="hint">各シナリオの詳細は README の「シナリオ API」を参照してください。</p>
<div id="modeFields"><label for="mode">実行モード</label><select id="mode"><option>CONTINUOUS</option><option>LIMITED</option></select>
<div id="countField" class="hidden"><label for="failureCount">失敗回数</label><input id="failureCount" type="number" min="1" step="1" value="1"></div>
<div id="delayField" class="hidden"><label for="delayMs">遅延時間（ms）</label><input id="delayMs" type="number" min="1" max="${scenarioUiDefaults.maxDelayMs}" step="1" value="${scenarioUiDefaults.delayMs}"></div>
<div id="retryAfterRequiredField" class="hidden"><label for="retryAfterRequired">Retry-After（秒）</label><input id="retryAfterRequired" type="number" min="1" step="1" value="${scenarioUiDefaults.retryAfterSeconds}" required></div>
<div id="retryAfterOptionalField" class="hidden"><label for="retryAfterOptional">Retry-After（秒、任意）</label><input id="retryAfterOptional" type="number" min="1" step="1" placeholder="Retry-Afterヘッダーを付与しない"></div>
<div id="errorFields" class="hidden"><label for="errorCode">OAuth error</label><input id="errorCode" value="${scenarioUiDefaults.tokenError}"><label for="errorDescription">説明</label><input id="errorDescription"></div></div>
<p id="rolloverNote" class="warning">SIGNING_KEY_ROLLOVERを有効にすると、シナリオの完了後、NORMALに戻した後、または別のシナリオを選択した後も、新しい署名鍵はJWKSで公開され続けます。シナリオを初期状態に戻すと、初期の鍵セットに戻ります。</p>
<div class="actions"><button class="primary" type="submit">適用</button><div class="action"><button id="normal" type="button">NORMALに戻す</button><p class="action-hint">シナリオを停止します（履歴は残ります）</p></div><div class="action"><button id="reset" class="danger" type="button">シナリオを初期状態に戻す</button><p class="action-hint danger-hint">履歴と鍵の状態を初期化します</p></div></div><p id="error" class="error" aria-live="polite"></p></form></section>
<section class="card"><h2>OIDC Client一覧</h2><p class="warning">Client secretは平文で保存・表示されます。このAdmin APIには認証がないため、インターネットに公開しないでください。</p>
<div id="clients">読み込み中…</div><div class="actions"><button id="newClient" class="primary" type="button">OIDC Clientを登録</button><button id="resetClients" class="danger" type="button">OIDC Clientを初期状態に戻す</button></div><p id="clientError" class="error" aria-live="polite"></p></section>
<section id="clientEditor" class="card hidden"><h2 id="clientEditorTitle">OIDC Clientを登録</h2><form id="clientForm">
<label for="clientId">Client ID</label><input id="clientId" required>
<label for="clientType">Client種別</label><select id="clientType"><option>PUBLIC</option><option>CONFIDENTIAL</option></select>
<div id="secretFields"><label for="clientSecret">Client secret</label><input id="clientSecret"><label for="authMethod">Token endpointの認証方式</label><select id="authMethod"><option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option></select></div>
<label for="redirectUris">Redirect URI（1行に1件）</label><textarea id="redirectUris" required></textarea>
<label for="logoutUris">Post logout redirect URI（1行に1件）</label><textarea id="logoutUris"></textarea>
<label for="audience">Access tokenのaudience</label><input id="audience" value="urn:mock-api" required>
<label for="scope">Access tokenのscp</label><input id="scope" value="access_as_user" required>
<label><input id="emailOptionalClaim" type="checkbox"> emailをoptional claimとして常に含める（emailスコープ要求の有無に関わらず付与）</label>
<div class="actions"><button class="primary" type="submit">保存</button><button id="cancelClient" type="button">キャンセル</button></div><p id="editorError" class="error" aria-live="polite"></p></form></section>
</main><script>
const $=id=>document.getElementById(id),metadata=${uiMetadata},defaults=${uiDefaults},connection=${connectionValues};
let sequence=0,lastSettled=0,pendingUpdates=0,editingClientId=null,clientItems=[];
function copyFallback(value){const textarea=document.createElement('textarea');textarea.value=value;textarea.style.position='fixed';textarea.style.opacity='0';document.body.append(textarea);textarea.select();const copied=document.execCommand('copy');textarea.remove();if(!copied)throw new Error('copy failed')}
async function copyConnectionValue(key,label){try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(connection[key]);else copyFallback(connection[key]);$('connectionMessage').textContent=label+'をコピーしました'}catch{try{copyFallback(connection[key]);$('connectionMessage').textContent=label+'をコピーしました'}catch{$('connectionMessage').textContent=label+'をコピーできませんでした。値を選択してコピーしてください。'}}}
$('copyAuthority').onclick=()=>void copyConnectionValue('authorityUrl','Authority URL');$('copyTenantId').onclick=()=>void copyConnectionValue('tenantId','Tenant ID');
function fields(){const info=metadata[$('scenario').value],m=$('mode').value,retryRequired=info.parameterKind==='retryAfterRequired',retryOptional=info.parameterKind==='retryAfterOptional';$('modeFields').classList.toggle('hidden',!info.supportsMode);$('countField').classList.toggle('hidden',m!=='LIMITED'||!info.supportsMode);$('delayField').classList.toggle('hidden',info.parameterKind!=='timeout');$('retryAfterRequiredField').classList.toggle('hidden',!retryRequired);$('retryAfterRequired').disabled=!retryRequired;$('retryAfterRequired').required=retryRequired;$('retryAfterOptionalField').classList.toggle('hidden',!retryOptional);$('retryAfterOptional').disabled=!retryOptional;$('errorFields').classList.toggle('hidden',info.parameterKind!=='token400')}
async function request(url,opts){const r=await fetch(url,opts),raw=await r.text(),data=raw?JSON.parse(raw):null;if(!r.ok)throw new Error(data?.message||raw||r.statusText);return data}
function render(s){$('current').textContent=s.scenario;$('currentMode').textContent=s.mode??'—';$('initial').textContent=s.initialFailureCount??'—';$('remaining').textContent=s.remainingFailures??'—';$('triggered').textContent=s.triggeredCount;$('status').textContent=s.status;$('state').classList.toggle('fault',s.status==='ACTIVE');$('history').textContent=s.lastCompleted?(s.lastCompleted.scenario+' — '+s.lastCompleted.triggeredCount+'回 — '+s.lastCompleted.completedAt):'なし'}
function renderLatest(id,state){if(id<lastSettled)return false;lastSettled=id;render(state);return true}
function showLatestError(id,error,visible=true){if(id<lastSettled)return;lastSettled=id;if(visible)$('error').textContent=message(error)}
function message(error){return error instanceof Error?error.message:String(error)}
async function refresh(showError=true){if(pendingUpdates)return;const id=++sequence;try{if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error,showError)}}
async function update(url,options){pendingUpdates++;let id=++sequence;try{await request(url,options);id=++sequence;if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error)}finally{pendingUpdates--}}
$('scenario').onchange=fields;$('mode').onchange=fields;$('form').onsubmit=e=>{e.preventDefault();const scenario=$('scenario').value,info=metadata[scenario];let body={scenario};if(info.supportsMode){body.mode=$('mode').value;if(body.mode==='LIMITED')body.failureCount=Number($('failureCount').value);if(info.parameterKind==='timeout')body.parameters={delayMs:Number($('delayMs').value||defaults.delayMs)};if(info.parameterKind==='retryAfterRequired')body.parameters={retryAfterSeconds:Number($('retryAfterRequired').value||defaults.retryAfterSeconds)};if(info.parameterKind==='retryAfterOptional'&&$('retryAfterOptional').value)body.parameters={retryAfterSeconds:Number($('retryAfterOptional').value)};if(info.parameterKind==='token400')body.parameters={error:$('errorCode').value||defaults.tokenError,...($('errorDescription').value?{errorDescription:$('errorDescription').value}:{})}}void update('/__mock/api/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)})};
$('normal').onclick=()=>void update('/__mock/api/scenario',{method:'DELETE'});$('reset').onclick=()=>void update('/__mock/api/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});$('refresh').onclick=()=>void refresh();fields();void refresh();
function lines(value){return [...new Set(value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean))]}
function clientTypeFields(){$('secretFields').classList.toggle('hidden',$('clientType').value==='PUBLIC')}
function openClient(client){editingClientId=client?.clientId??null;$('clientEditorTitle').textContent=client?'OIDC Clientを編集':'OIDC Clientを登録';$('clientId').value=client?.clientId??'';$('clientId').disabled=!!client;$('clientType').value=client?.clientType??'PUBLIC';$('clientSecret').value=client?.clientSecret??'';$('authMethod').value=client?.tokenEndpointAuthMethod==='client_secret_post'?'client_secret_post':'client_secret_basic';$('redirectUris').value=(client?.redirectUris??['http://localhost:3000/callback']).join('\\n');$('logoutUris').value=(client?.postLogoutRedirectUris??[]).join('\\n');$('audience').value=client?.accessTokenAudience??'urn:mock-api';$('scope').value=client?.accessTokenScope??'access_as_user';$('emailOptionalClaim').checked=client?.emailOptionalClaim??false;$('editorError').textContent='';$('clientEditor').classList.remove('hidden');clientTypeFields();$('clientEditor').scrollIntoView({behavior:'smooth'})}
function renderClients(items){clientItems=items;const root=$('clients');root.replaceChildren();for(const client of items){const row=document.createElement('div');row.className='client';const title=document.createElement('strong');title.textContent=client.clientId+' ('+client.clientType+')';const details=document.createElement('div');details.textContent='Redirect URI：'+client.redirectUris.join(', ')+' ｜ audience：'+client.accessTokenAudience+' ｜ scp：'+client.accessTokenScope+(client.emailOptionalClaim?' ｜ email optional claim：有効':'');const secret=document.createElement('code');secret.textContent=client.clientSecret?'Client secret：'+client.clientSecret:'';const actions=document.createElement('div');actions.className='actions';const edit=document.createElement('button');edit.type='button';edit.textContent='編集';edit.onclick=()=>openClient(client);const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='削除';del.onclick=async()=>{if(!confirm('OIDC Client「'+client.clientId+'」を削除しますか？'))return;try{await request('/__mock/api/clients/'+encodeURIComponent(client.clientId),{method:'DELETE'});await loadClients()}catch(error){$('clientError').textContent=message(error)}};actions.append(edit,del);row.append(title,document.createElement('br'),details,document.createElement('br'),secret,actions);root.append(row)}if(!items.length)root.textContent='登録済みのOIDC Clientはありません。'}
async function loadClients(){try{renderClients(await request('/__mock/api/clients'));$('clientError').textContent=''}catch(error){$('clientError').textContent=message(error)}}
$('newClient').onclick=()=>openClient(null);$('cancelClient').onclick=()=>{$('clientEditor').classList.add('hidden')};$('clientType').onchange=clientTypeFields;
$('clientForm').onsubmit=async event=>{event.preventDefault();const type=$('clientType').value,payload={clientType:type,...(type==='CONFIDENTIAL'?{clientSecret:$('clientSecret').value,tokenEndpointAuthMethod:$('authMethod').value}:{tokenEndpointAuthMethod:'none'}),redirectUris:lines($('redirectUris').value),postLogoutRedirectUris:lines($('logoutUris').value),accessTokenAudience:$('audience').value,accessTokenScope:$('scope').value,emailOptionalClaim:$('emailOptionalClaim').checked};try{const url=editingClientId?'/__mock/api/clients/'+encodeURIComponent(editingClientId):'/__mock/api/clients';await request(url,{method:editingClientId?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(editingClientId?payload:{clientId:$('clientId').value,...payload})});$('clientEditor').classList.add('hidden');await loadClients()}catch(error){$('editorError').textContent=message(error)}};
$('resetClients').onclick=async()=>{if(!confirm('すべてのOIDC Clientを初期状態に戻しますか？'))return;try{renderClients(await request('/__mock/api/clients/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));$('clientError').textContent=''}catch(error){$('clientError').textContent=message(error)}};clientTypeFields();void loadClients();
</script></body></html>`;
}
