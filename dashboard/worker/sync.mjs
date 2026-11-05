// Fixed-target GitHub Actions control. Runtime credentials stay on the server.
export const SYNC_TARGET = Object.freeze({owner:'__GITHUB_OWNER__',repo:'__GITHUB_REPO__',workflow:'sync.yml',ref:'main'});
export const SYNC_COOLDOWN_MS = 120000;
const SYNC_BODY_LIMIT = 1024, SYNC_RESPONSE_LIMIT = 512 * 1024;
const SYNC_PENDING_MS = 10 * 60 * 1000;
const SYNC_ACTIVE = new Set(['queued','in_progress','waiting','pending','requested']);
const SYNC_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SYNC_RUN_ID = /^[1-9][0-9]{0,15}$/;
const SYNC_API = `https://api.github.com/repos/${SYNC_TARGET.owner}/${SYNC_TARGET.repo}`;
const SYNC_WORKFLOW = `${SYNC_API}/actions/workflows/${SYNC_TARGET.workflow}`;
const SYNC_HEADERS = {'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin','x-robots-tag':'noindex, nofollow'};
function syncJSON(value,status=200,extra={}) {return new Response(JSON.stringify(value),{status,headers:{...SYNC_HEADERS,...extra}});}
class SyncError extends Error {constructor(code,status=503,retryAfter=null){super(code);this.code=code;this.status=status;this.retryAfter=retryAfter;}}
async function syncReadJSON(response,limit) {
  if(Number(response.headers.get('content-length')||0)>limit)throw new SyncError('response_too_large',502);
  const reader=response.body?.getReader();if(!reader)throw new SyncError('invalid_response',502);
  const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0,timedOut=false;
  const deadline=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},10000);
  try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new SyncError('response_too_large',502);}text+=decoder.decode(value,{stream:true});}if(timedOut)throw new SyncError('response_timeout',502);text+=decoder.decode();return JSON.parse(text);}
  catch(error){await reader.cancel().catch(()=>{});if(error instanceof SyncError)throw error;throw new SyncError('invalid_response',502);}
  finally {clearTimeout(deadline);reader.releaseLock();}
}
function syncSafeRun(run) {
  if(!run||!SYNC_RUN_ID.test(String(run.id))||run.head_branch!==SYNC_TARGET.ref)return null;
  const path=String(run.path||'').split('@')[0];if(path!=='.github/workflows/sync.yml')return null;
  const state=SYNC_ACTIVE.has(run.status)?run.status:run.status==='completed'?'completed':null;
  if(!state)return null;
  return {id:String(run.id),status:state,conclusion:typeof run.conclusion==='string'?run.conclusion:null,url:`https://github.com/${SYNC_TARGET.owner}/${SYNC_TARGET.repo}/actions/runs/${run.id}`,created_at:Number.isFinite(Date.parse(run.created_at))?run.created_at:null,updated_at:Number.isFinite(Date.parse(run.updated_at))?run.updated_at:null};
}
function syncRunResult(run,requestId=null) {
  return {configured:true,status:run.status==='completed'?(run.conclusion==='success'?'completed':'failed'):run.status==='in_progress'?'in_progress':'queued',...(requestId?{request_id:requestId}:{}),run};
}
function syncReceiptResult(receipt,now) {
  if(receipt.error)return {configured:true,status:'failed',request_id:receipt.request_id,error:receipt.error};
  return {configured:true,status:now-receipt.created_ms<SYNC_PENDING_MS?'dispatching':'unknown',request_id:receipt.request_id,retry_after:now-receipt.created_ms<SYNC_PENDING_MS?10:30};
}

// Conditional creation is the only lock operation. Receipt updates are cache
// entries written by the single dispatch owner, never counters or balances.
export function createR2SyncStore(bucket) {
  return {
    async get(key){const item=await bucket.get(`sync/${key}`);return item?item.json():null;},
    async claim(key,value){return !!await bucket.put(`sync/${key}`,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});},
    async set(key,value){await bucket.put(`sync/${key}`,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});},
  };
}
export function createMemorySyncStore() {
  const values=new Map();
  return {async get(key){return values.get(key)??null;},async claim(key,value){if(values.has(key))return false;values.set(key,value);return true;},async set(key,value){values.set(key,value);}};
}
export function createSyncHandler({fetcher=(...args)=>fetch(...args),now=()=>Date.now(),store:fixedStore=null,requireIdentity=false,onComplete=null}={}) {
  const memory=createMemorySyncStore();let serial=Promise.resolve();
  async function provider(path,token,options={}) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
    try {
      const response=await fetcher(path,{...options,redirect:'manual',signal:controller.signal,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'CS2-Analyst','Authorization':`Bearer ${token}`,...(options.body?{'Content-Type':'application/json'}:{})}});
      if(!response.ok){await response.body?.cancel().catch(()=>{});if(response.status===429||response.headers.get('x-ratelimit-remaining')==='0')throw new SyncError('github_rate_limited',429,60);if(response.status===401||response.status===403)throw new SyncError('github_access_denied',403);if(response.status===404)throw new SyncError('workflow_unavailable',503);if(response.status===422)throw new SyncError('workflow_input_rejected',503);if(response.status===429)throw new SyncError('github_rate_limited',429,60);throw new SyncError('github_unavailable',502);}
      return response;
    }catch(error){if(error instanceof SyncError)throw error;throw new SyncError('github_unavailable',502);}
    finally {clearTimeout(timeout);}
  }
  async function runs(token) {
    const response=await provider(`${SYNC_WORKFLOW}/runs?branch=main&per_page=20`,token),data=await syncReadJSON(response,SYNC_RESPONSE_LIMIT);
    if(!Array.isArray(data.workflow_runs)||data.workflow_runs.length>20)throw new SyncError('invalid_response',502);
    return data.workflow_runs.map(raw=>({raw,run:syncSafeRun(raw)})).filter(item=>item.run);
  }
  async function complete(run,requestId,token,store,env) {
    const result=syncRunResult(run,requestId);
    if(result.status!=='completed'||!onComplete)return syncJSON(result);
    try {const publication=await onComplete(run,{token,store,env});return syncJSON({...result,...(publication?{publication,status:publication.status==='publishing'?'publishing':publication.status==='error'?'publication_failed':result.status}:{})});}
    catch {return syncJSON({...result,status:'publication_failed',publication:{status:'error',error:'sync_snapshot_update_failed'}});}
  }
  async function status(url,token,store,env) {
    const keys=[...url.searchParams.keys()];if(keys.some(key=>!['request_id','run_id'].includes(key))||keys.length>1)throw new SyncError('invalid_sync_request',400);
    const requestId=url.searchParams.get('request_id'),runId=url.searchParams.get('run_id');
    if(requestId&&!SYNC_UUID.test(requestId)||runId&&!SYNC_RUN_ID.test(runId))throw new SyncError('invalid_sync_request',400);
    if(runId){const raw=await syncReadJSON(await provider(`${SYNC_API}/actions/runs/${runId}`,token),SYNC_RESPONSE_LIMIT),run=syncSafeRun(raw);if(!run)throw new SyncError('sync_run_not_found',404);return complete(run,null,token,store,env);}
    const items=await runs(token);
    if(requestId){
      const found=items.find(({raw})=>raw.event==='workflow_dispatch'&&raw.display_title===`CS2 Dashboard ${requestId}`);
      if(found)return complete(found.run,requestId,token,store,env);
      const receipt=await store.get(`requests/${requestId}`);if(!receipt)throw new SyncError('sync_request_not_found',404);
      return syncJSON(syncReceiptResult(receipt,now()));
    }
    const active=items.find(item=>SYNC_ACTIVE.has(item.run.status));
    return syncJSON(active?syncRunResult(active.run):{configured:true,status:'idle',latest_run:items[0]?.run??null});
  }
  async function dispatch(input,token,store,env) {
    const previous=await store.get(`requests/${input.request_id}`);
    if(previous){const url=new URL('https://sync.invalid/api/sync');url.searchParams.set('request_id',input.request_id);return status(url,token,store,env);}
    const items=await runs(token),active=items.find(item=>SYNC_ACTIVE.has(item.run.status));
    if(active)return syncJSON({...syncRunResult(active.run),joined_existing:true},202);
    const latest=items[0]?.run,age=latest?.created_at?now()-Date.parse(latest.created_at):Infinity;
    if(age>=0&&age<SYNC_COOLDOWN_MS){const retry=Math.ceil((SYNC_COOLDOWN_MS-age)/1000);return syncJSON({configured:true,status:'cooldown',error:'sync_cooldown',retry_after:retry,latest_run:latest},429,{'retry-after':String(retry)});}
    const receipt={request_id:input.request_id,created_ms:now()};
    const slot=`slots/${Math.floor(receipt.created_ms/SYNC_COOLDOWN_MS)}`;
    if(!await store.claim(slot,receipt)){
      const pending=await store.get(slot);if(!pending||!SYNC_UUID.test(pending.request_id))throw new SyncError('sync_state_unavailable',503);
      return syncJSON({...syncReceiptResult(pending,now()),joined_existing:true},202);
    }
    if(!await store.claim(`requests/${input.request_id}`,receipt))return syncJSON(syncReceiptResult(await store.get(`requests/${input.request_id}`),now()),202);
    try {
      const response=await provider(`${SYNC_WORKFLOW}/dispatches`,token,{method:'POST',body:JSON.stringify({ref:SYNC_TARGET.ref,inputs:{dashboard_request_id:input.request_id,retry_now:'false',job_limit:'4'}})});
      if(![202,204].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new SyncError('invalid_dispatch_response',502);}
      await response.body?.cancel().catch(()=>{});
      return syncJSON({...syncReceiptResult(receipt,now()),accepted:true},202);
    }catch(error){
      // A timeout may occur after GitHub accepted the dispatch. Poll instead of
      // replaying a write whose result is uncertain.
      const uncertain=['github_unavailable','invalid_dispatch_response'].includes(error.code);
      await store.set(`requests/${input.request_id}`,{...receipt,...(uncertain?{uncertain:true}:{error:error.code})});
      if(uncertain)return syncJSON({...syncReceiptResult(receipt,now()),error:'dispatch_result_pending'},202);
      throw error;
    }
  }
  return async function syncHandler(request,env={}) {
    try {
      const url=new URL(request.url),origin=request.headers.get('origin');
      if(origin&&origin!==url.origin||request.headers.get('sec-fetch-site')==='cross-site')throw new SyncError('origin_rejected',403);
      if(!['GET','POST'].includes(request.method))return syncJSON({error:'method_not_allowed'},405,{Allow:'GET, POST'});
      if(requireIdentity&&!request.headers.get('oai-authenticated-user-id'))throw new SyncError('sign_in_required',401);
      if(request.method==='POST'&&origin!==url.origin)throw new SyncError('origin_rejected',403);
      const token=env.GITHUB_ACTIONS_TOKEN;
      if(typeof token!=='string'||!token.trim())return syncJSON({configured:false,status:'not_configured',error:'sync_not_configured'},503);
      const store=fixedStore||(env.BUCKET?createR2SyncStore(env.BUCKET):memory);
      if(request.method==='GET')return await status(url,token,store,env);
      if(url.search)throw new SyncError('invalid_sync_request',400);
      if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw new SyncError('json_required',415);
      if(Number(request.headers.get('content-length')||0)>SYNC_BODY_LIMIT)throw new SyncError('sync_request_too_large',413);
      let input;try{input=await syncReadJSON(request,SYNC_BODY_LIMIT);}catch(error){throw new SyncError(error.code==='response_too_large'?'sync_request_too_large':'invalid_sync_request',error.code==='response_too_large'?413:400);}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!SYNC_UUID.test(input.request_id))throw new SyncError('invalid_sync_request',400);
      const current=serial.then(()=>dispatch(input,token,store,env));serial=current.then(()=>{},()=>{});return await current;
    }catch(error){const safe=error instanceof SyncError?error:new SyncError('sync_service_unavailable',503);return syncJSON({configured:safe.code==='sync_not_configured'?false:true,error:safe.code,status:'error',...(safe.retryAfter?{retry_after:safe.retryAfter}:{})},safe.status,safe.retryAfter?{'retry-after':String(safe.retryAfter)}:{});}
  };
}
