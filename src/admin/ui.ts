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
export const adminHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock OIDC Provider</title><style>
:root{font-family:ui-sans-serif,system-ui;color:#16202a;background:#eef2f6}body{margin:0;padding:2rem}.wrap{max-width:900px;margin:auto}
h1{margin:0 0 1rem}.card{background:white;border-radius:12px;padding:1.25rem;margin:1rem 0;box-shadow:0 2px 12px #18324b18}
.state{border-left:8px solid #159957}.state.fault{border-color:#d33b32}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem}
.label{font-size:.78rem;text-transform:uppercase;color:#64748b}.value{font-size:1.15rem;font-weight:700;margin-top:.25rem}label{display:block;margin:.8rem 0 .3rem}
select,input,textarea,button{font:inherit;padding:.65rem;border:1px solid #bdc7d3;border-radius:6px}select,input,textarea{width:100%;box-sizing:border-box}textarea{min-height:5rem}button{cursor:pointer;font-weight:650}.primary{background:#1261a0;color:white}.danger{background:#b42318;color:white}.actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem}.hidden{display:none}.error,.warning{color:#b42318;white-space:pre-wrap}.client{border-top:1px solid #d9e0e7;padding:1rem 0}.client:first-child{border-top:0}.client code{overflow-wrap:anywhere}
</style></head><body><main class="wrap"><h1>Mock OIDC Provider</h1>
<section id="state" class="card state"><div class="grid">
<div><div class="label">Current Scenario</div><div id="current" class="value">Loading…</div></div><div><div class="label">Mode</div><div id="currentMode" class="value">—</div></div>
<div><div class="label">Initial Failures</div><div id="initial" class="value">—</div></div><div><div class="label">Remaining</div><div id="remaining" class="value">—</div></div>
<div><div class="label">Triggered</div><div id="triggered" class="value">0</div></div><div><div class="label">Status</div><div id="status" class="value">—</div></div></div></section>
<section class="card"><form id="form"><label for="scenario">Scenario</label><select id="scenario">${options}</select>
<div id="modeFields"><label for="mode">Mode</label><select id="mode"><option>CONTINUOUS</option><option>LIMITED</option></select>
<div id="countField" class="hidden"><label for="failureCount">Failure Count</label><input id="failureCount" type="number" min="1" step="1" value="1"></div>
<div id="delayField" class="hidden"><label for="delayMs">Delay (ms)</label><input id="delayMs" type="number" min="1" max="${scenarioUiDefaults.maxDelayMs}" step="1" value="${scenarioUiDefaults.delayMs}"></div>
<div id="retryAfterRequiredField" class="hidden"><label for="retryAfterRequired">Retry-After (seconds)</label><input id="retryAfterRequired" type="number" min="1" step="1" value="${scenarioUiDefaults.retryAfterSeconds}" required></div>
<div id="retryAfterOptionalField" class="hidden"><label for="retryAfterOptional">Retry-After (seconds, optional)</label><input id="retryAfterOptional" type="number" min="1" step="1" placeholder="No Retry-After header"></div>
<div id="errorFields" class="hidden"><label for="errorCode">OAuth error</label><input id="errorCode" value="${scenarioUiDefaults.tokenError}"><label for="errorDescription">Description</label><input id="errorDescription"></div></div>
<p id="rolloverNote" class="warning">After SIGNING_KEY_ROLLOVER is activated, the new signing key remains published in JWKS after completion, Return to Normal, or selecting another scenario. Reset restores the initial key set.</p>
<div class="actions"><button class="primary" type="submit">Apply</button><button id="normal" type="button">Return to Normal</button><button id="refresh" type="button">Refresh</button><button id="reset" class="danger" type="button">Reset</button></div><p id="error" class="error" aria-live="polite"></p></form></section>
<section class="card"><div class="label">Last completed scenario</div><div id="history" class="value">None</div></section>
<section class="card"><h2>OIDC Clients</h2><p class="warning">Secrets are stored and displayed in plain text. Never expose this unauthenticated Admin API to the internet.</p>
<div id="clients">Loading…</div><div class="actions"><button id="newClient" class="primary" type="button">Register client</button><button id="resetClients" class="danger" type="button">Reset clients</button></div><p id="clientError" class="error" aria-live="polite"></p></section>
<section id="clientEditor" class="card hidden"><h2 id="clientEditorTitle">Register OIDC client</h2><form id="clientForm">
<label for="clientId">Client ID</label><input id="clientId" required>
<label for="clientType">Client type</label><select id="clientType"><option>PUBLIC</option><option>CONFIDENTIAL</option></select>
<div id="secretFields"><label for="clientSecret">Client secret</label><input id="clientSecret"><label for="authMethod">Token endpoint authentication</label><select id="authMethod"><option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option></select></div>
<label for="redirectUris">Redirect URIs (one per line)</label><textarea id="redirectUris" required></textarea>
<label for="logoutUris">Post logout redirect URIs (one per line)</label><textarea id="logoutUris"></textarea>
<label for="audience">Access token audience</label><input id="audience" value="urn:mock-api" required>
<div class="actions"><button class="primary" type="submit">Save</button><button id="cancelClient" type="button">Cancel</button></div><p id="editorError" class="error" aria-live="polite"></p></form></section>
</main><script>
const $=id=>document.getElementById(id),metadata=${uiMetadata},defaults=${uiDefaults};
let sequence=0,lastSettled=0,pendingUpdates=0,editingClientId=null,clientItems=[];
function fields(){const info=metadata[$('scenario').value],m=$('mode').value,retryRequired=info.parameterKind==='retryAfterRequired',retryOptional=info.parameterKind==='retryAfterOptional';$('modeFields').classList.toggle('hidden',!info.supportsMode);$('countField').classList.toggle('hidden',m!=='LIMITED'||!info.supportsMode);$('delayField').classList.toggle('hidden',info.parameterKind!=='timeout');$('retryAfterRequiredField').classList.toggle('hidden',!retryRequired);$('retryAfterRequired').disabled=!retryRequired;$('retryAfterRequired').required=retryRequired;$('retryAfterOptionalField').classList.toggle('hidden',!retryOptional);$('retryAfterOptional').disabled=!retryOptional;$('errorFields').classList.toggle('hidden',info.parameterKind!=='token400')}
async function request(url,opts){const r=await fetch(url,opts),raw=await r.text(),data=raw?JSON.parse(raw):null;if(!r.ok)throw new Error(data?.message||raw||r.statusText);return data}
function render(s){$('current').textContent=s.scenario;$('currentMode').textContent=s.mode??'—';$('initial').textContent=s.initialFailureCount??'—';$('remaining').textContent=s.remainingFailures??'—';$('triggered').textContent=s.triggeredCount;$('status').textContent=s.status;$('state').classList.toggle('fault',s.status==='ACTIVE');$('history').textContent=s.lastCompleted?(s.lastCompleted.scenario+' — '+s.lastCompleted.triggeredCount+' time(s) — '+s.lastCompleted.completedAt):'None'}
function renderLatest(id,state){if(id<lastSettled)return false;lastSettled=id;render(state);return true}
function showLatestError(id,error,visible=true){if(id<lastSettled)return;lastSettled=id;if(visible)$('error').textContent=message(error)}
function message(error){return error instanceof Error?error.message:String(error)}
async function refresh(showError=true){if(pendingUpdates)return;const id=++sequence;try{if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error,showError)}}
async function update(url,options){pendingUpdates++;let id=++sequence;try{await request(url,options);id=++sequence;if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error)}finally{pendingUpdates--}}
$('scenario').onchange=fields;$('mode').onchange=fields;$('form').onsubmit=e=>{e.preventDefault();const scenario=$('scenario').value,info=metadata[scenario];let body={scenario};if(info.supportsMode){body.mode=$('mode').value;if(body.mode==='LIMITED')body.failureCount=Number($('failureCount').value);if(info.parameterKind==='timeout')body.parameters={delayMs:Number($('delayMs').value||defaults.delayMs)};if(info.parameterKind==='retryAfterRequired')body.parameters={retryAfterSeconds:Number($('retryAfterRequired').value||defaults.retryAfterSeconds)};if(info.parameterKind==='retryAfterOptional'&&$('retryAfterOptional').value)body.parameters={retryAfterSeconds:Number($('retryAfterOptional').value)};if(info.parameterKind==='token400')body.parameters={error:$('errorCode').value||defaults.tokenError,...($('errorDescription').value?{errorDescription:$('errorDescription').value}:{})}}void update('/__mock/api/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)})};
$('normal').onclick=()=>void update('/__mock/api/scenario',{method:'DELETE'});$('reset').onclick=()=>void update('/__mock/api/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});$('refresh').onclick=()=>void refresh();fields();void refresh();setInterval(()=>void refresh(false),3000);
function lines(value){return [...new Set(value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean))]}
function clientTypeFields(){$('secretFields').classList.toggle('hidden',$('clientType').value==='PUBLIC')}
function openClient(client){editingClientId=client?.clientId??null;$('clientEditorTitle').textContent=client?'Edit OIDC client':'Register OIDC client';$('clientId').value=client?.clientId??'';$('clientId').disabled=!!client;$('clientType').value=client?.clientType??'PUBLIC';$('clientSecret').value=client?.clientSecret??'';$('authMethod').value=client?.tokenEndpointAuthMethod==='client_secret_post'?'client_secret_post':'client_secret_basic';$('redirectUris').value=(client?.redirectUris??['http://localhost:3000/callback']).join('\\n');$('logoutUris').value=(client?.postLogoutRedirectUris??[]).join('\\n');$('audience').value=client?.accessTokenAudience??'urn:mock-api';$('editorError').textContent='';$('clientEditor').classList.remove('hidden');clientTypeFields();$('clientEditor').scrollIntoView({behavior:'smooth'})}
function renderClients(items){clientItems=items;const root=$('clients');root.replaceChildren();for(const client of items){const row=document.createElement('div');row.className='client';const title=document.createElement('strong');title.textContent=client.clientId+' ('+client.clientType+')';const details=document.createElement('div');details.textContent='Redirect: '+client.redirectUris.join(', ')+' | Audience: '+client.accessTokenAudience;const secret=document.createElement('code');secret.textContent=client.clientSecret?'Secret: '+client.clientSecret:'';const actions=document.createElement('div');actions.className='actions';const edit=document.createElement('button');edit.type='button';edit.textContent='Edit';edit.onclick=()=>openClient(client);const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='Delete';del.onclick=async()=>{if(!confirm('Delete '+client.clientId+'?'))return;try{await request('/__mock/api/clients/'+encodeURIComponent(client.clientId),{method:'DELETE'});await loadClients()}catch(error){$('clientError').textContent=message(error)}};actions.append(edit,del);row.append(title,document.createElement('br'),details,document.createElement('br'),secret,actions);root.append(row)}if(!items.length)root.textContent='No clients registered.'}
async function loadClients(){try{renderClients(await request('/__mock/api/clients'));$('clientError').textContent=''}catch(error){$('clientError').textContent=message(error)}}
$('newClient').onclick=()=>openClient(null);$('cancelClient').onclick=()=>{$('clientEditor').classList.add('hidden')};$('clientType').onchange=clientTypeFields;
$('clientForm').onsubmit=async event=>{event.preventDefault();const type=$('clientType').value,payload={clientType:type,...(type==='CONFIDENTIAL'?{clientSecret:$('clientSecret').value,tokenEndpointAuthMethod:$('authMethod').value}:{tokenEndpointAuthMethod:'none'}),redirectUris:lines($('redirectUris').value),postLogoutRedirectUris:lines($('logoutUris').value),accessTokenAudience:$('audience').value};try{const url=editingClientId?'/__mock/api/clients/'+encodeURIComponent(editingClientId):'/__mock/api/clients';await request(url,{method:editingClientId?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(editingClientId?payload:{clientId:$('clientId').value,...payload})});$('clientEditor').classList.add('hidden');await loadClients()}catch(error){$('editorError').textContent=message(error)}};
$('resetClients').onclick=async()=>{if(!confirm('Reset all OIDC clients to defaults?'))return;try{renderClients(await request('/__mock/api/clients/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));$('clientError').textContent=''}catch(error){$('clientError').textContent=message(error)}};clientTypeFields();void loadClients();
</script></body></html>`;
