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
select,input,button{font:inherit;padding:.65rem;border:1px solid #bdc7d3;border-radius:6px}select,input{width:100%;box-sizing:border-box}button{cursor:pointer;font-weight:650}.primary{background:#1261a0;color:white}.danger{background:#b42318;color:white}.actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem}.hidden{display:none}.error{color:#b42318;white-space:pre-wrap}
</style></head><body><main class="wrap"><h1>Mock OIDC Provider</h1>
<section id="state" class="card state"><div class="grid">
<div><div class="label">Current Scenario</div><div id="current" class="value">Loading…</div></div><div><div class="label">Mode</div><div id="currentMode" class="value">—</div></div>
<div><div class="label">Initial Failures</div><div id="initial" class="value">—</div></div><div><div class="label">Remaining</div><div id="remaining" class="value">—</div></div>
<div><div class="label">Triggered</div><div id="triggered" class="value">0</div></div><div><div class="label">Status</div><div id="status" class="value">—</div></div></div></section>
<section class="card"><form id="form"><label for="scenario">Scenario</label><select id="scenario">${options}</select>
<div id="modeFields"><label for="mode">Mode</label><select id="mode"><option>CONTINUOUS</option><option>LIMITED</option></select>
<div id="countField" class="hidden"><label for="failureCount">Failure Count</label><input id="failureCount" type="number" min="1" step="1" value="1"></div>
<div id="delayField" class="hidden"><label for="delayMs">Delay (ms)</label><input id="delayMs" type="number" min="1" max="${scenarioUiDefaults.maxDelayMs}" step="1" value="${scenarioUiDefaults.delayMs}"></div>
<div id="errorFields" class="hidden"><label for="errorCode">OAuth error</label><input id="errorCode" value="${scenarioUiDefaults.tokenError}"><label for="errorDescription">Description</label><input id="errorDescription"></div></div>
<div class="actions"><button class="primary" type="submit">Apply</button><button id="normal" type="button">Return to Normal</button><button id="refresh" type="button">Refresh</button><button id="reset" class="danger" type="button">Reset</button></div><p id="error" class="error" aria-live="polite"></p></form></section>
<section class="card"><div class="label">Last completed scenario</div><div id="history" class="value">None</div></section>
</main><script>
const $=id=>document.getElementById(id),metadata=${uiMetadata},defaults=${uiDefaults};
let sequence=0,lastSettled=0,pendingUpdates=0;
function fields(){const info=metadata[$('scenario').value],m=$('mode').value;$('modeFields').classList.toggle('hidden',!info.supportsMode);$('countField').classList.toggle('hidden',m!=='LIMITED'||!info.supportsMode);$('delayField').classList.toggle('hidden',info.parameterKind!=='timeout');$('errorFields').classList.toggle('hidden',info.parameterKind!=='token400')}
async function request(url,opts){const r=await fetch(url,opts);const data=await r.json();if(!r.ok)throw new Error(data.message||JSON.stringify(data));return data}
function render(s){$('current').textContent=s.scenario;$('currentMode').textContent=s.mode??'—';$('initial').textContent=s.initialFailureCount??'—';$('remaining').textContent=s.remainingFailures??'—';$('triggered').textContent=s.triggeredCount;$('status').textContent=s.status;$('state').classList.toggle('fault',s.status==='ACTIVE');$('history').textContent=s.lastCompleted?(s.lastCompleted.scenario+' — '+s.lastCompleted.triggeredCount+' time(s) — '+s.lastCompleted.completedAt):'None'}
function renderLatest(id,state){if(id<lastSettled)return false;lastSettled=id;render(state);return true}
function showLatestError(id,error,visible=true){if(id<lastSettled)return;lastSettled=id;if(visible)$('error').textContent=message(error)}
function message(error){return error instanceof Error?error.message:String(error)}
async function refresh(showError=true){if(pendingUpdates)return;const id=++sequence;try{if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error,showError)}}
async function update(url,options){pendingUpdates++;let id=++sequence;try{await request(url,options);id=++sequence;if(renderLatest(id,await request('/__mock/api/scenario')))$('error').textContent=''}catch(error){showLatestError(id,error)}finally{pendingUpdates--}}
$('scenario').onchange=fields;$('mode').onchange=fields;$('form').onsubmit=e=>{e.preventDefault();const scenario=$('scenario').value,info=metadata[scenario];let body={scenario};if(info.supportsMode){body.mode=$('mode').value;if(body.mode==='LIMITED')body.failureCount=Number($('failureCount').value);if(info.parameterKind==='timeout')body.parameters={delayMs:Number($('delayMs').value||defaults.delayMs)};if(info.parameterKind==='token400')body.parameters={error:$('errorCode').value||defaults.tokenError,...($('errorDescription').value?{errorDescription:$('errorDescription').value}:{})}}void update('/__mock/api/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)})};
$('normal').onclick=()=>void update('/__mock/api/scenario',{method:'DELETE'});$('reset').onclick=()=>void update('/__mock/api/reset',{method:'POST'});$('refresh').onclick=()=>void refresh();fields();void refresh();setInterval(()=>void refresh(false),3000);
</script></body></html>`;
