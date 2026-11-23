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
const SYNC_LIVE_URL = `${SYNC_API}/contents/demo-sync-progress.json?ref=cs2-sync-progress`;
const SYNC_HEADERS = {'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin','x-robots-tag':'noindex, nofollow'};
const SYNC_DETAIL_TIMEOUT_MS = 3500;
const SYNC_LIVE_STALE_MS = 90000, SYNC_CLOCK_SKEW_MS = 15000;
const SYNC_STAGE_LABELS = new Map([
  ['prepare','准备运行环境'],['discover','查询 Steam 比赛与战绩'],['process','下载并解析 Demo'],
  ['summary','整理处理结果'],['checkpoint','提交比赛数据'],['publish','通知站点更新'],['finish','核对运行结果'],
]);
const SYNC_STEP_IDS = new Map([
  ['Set up job','prepare'],['Install replay worker','prepare'],
  ['Sync Steam codes and Leetify stats','discover'],['Download, parse and analyze Demo jobs','process'],
  ['Add Demo worker report to run summary','summary'],['Commit generated data only when changed','checkpoint'],
  ['Refresh the private Netlify snapshot','publish'],['Propagate service errors after saving progress','finish'],
]);
const SYNC_DEMO_OUTCOMES = new Set(['idle','ok','partial','failed','blocked_auth','waiting_for_replays','deferred_steam_playing_elsewhere']);
const SYNC_DISCOVERY_STATES = new Set(['not_checked','discovered','transient','expired','unavailable']);
const SYNC_DISCOVERY_ERRORS = new Set([
  'gc_discovery_failed','gc_recent_request_rejected','steam_connection_failed','steam_playing_elsewhere',
  'steam_account_mismatch','steam_auth_rejected','steam_guard_reauth_required','steam_refresh_token_expired',
  'steam_refresh_token_invalid','steam_refresh_token_missing','steam_refresh_token_rejected','steam_refresh_token_requires_client',
]);
const SYNC_BATCH_COUNTS = ['attempted_this_run','completed_this_run','deferred_this_run','selected_this_run','settled_this_run'];
const SYNC_JOB_ID = /^[a-f0-9]{24}$/;
const SYNC_JOB_STATES = new Set(['complete','retry','unavailable','blocked_auth','deferred','verified']);
const SYNC_LIVE_PHASES = new Set(['discovering','resolving','connecting','downloading','decompressing','validating','parsing','analyzing','saving','checkpointing','reporting','retrying','settled','finished']);
const SYNC_PARSER_STAGES = new Set(['start','header','player_info','events','positions','metrics','advanced_metrics','all_player_metrics','crosshair_windows','mechanics_targets','radar_replay','tactical_replay']);
const SYNC_DOWNLOAD_ERRORS = new Set([
  'download_network_error','download_socket_timeout','download_connection_reset','download_timeout','download_too_large',
  'truncated_download','demo_too_large','not_cs2_demo','corrupt_demo','url_not_allowed',
  'manual_url_required','match_unavailable','replay_url_unavailable','gc_url_unavailable','resolver_failed','resolver_process_failed',
  'parsed_account_mismatch','native_source_manifest_write_failed','sync_worker_failed',
]);
const SYNC_PARSER_ERRORS = ['parser_timeout','parser_memory_limit','parser_player_absent','parser_event_schema','parser_no_live_rounds','parser_python_error','parser_worker_failed'];
const SYNC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
function syncJSON(value,status=200,extra={}) {return new Response(JSON.stringify(value),{status,headers:{...SYNC_HEADERS,...extra}});}
class SyncError extends Error {constructor(code,status=503,retryAfter=null){super(code);this.code=code;this.status=status;this.retryAfter=retryAfter;}}
async function syncReadJSON(response,limit,timeoutMs=10000) {
  if(Number(response.headers.get('content-length')||0)>limit){void response.body?.cancel().catch(()=>{});throw new SyncError('response_too_large',502);}
  const reader=response.body?.getReader();if(!reader)throw new SyncError('invalid_response',502);
  const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0,timedOut=false;
  const deadline=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},timeoutMs);
  try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new SyncError('response_too_large',502);}text+=decoder.decode(value,{stream:true});}if(timedOut)throw new SyncError('response_timeout',502);text+=decoder.decode();return JSON.parse(text);}
  catch(error){await reader.cancel().catch(()=>{});if(error instanceof SyncError)throw error;throw new SyncError('invalid_response',502);}
  finally {clearTimeout(deadline);reader.releaseLock();}
}
function syncDetailTime(value) {
  if(typeof value!=='string'||!SYNC_TIMESTAMP.test(value))return null;
  const time=Date.parse(value);
  return Number.isFinite(time)?new Date(time).toISOString():null;
}
function syncRunAttempt(value) {
  const parsed=typeof value==='string'&&/^[1-9][0-9]{0,6}$/.test(value)?Number(value):value;
  return Number.isSafeInteger(parsed)&&parsed>=1?parsed:null;
}
function syncMatchesRunId(value,runId) {
  return value===runId||Number.isSafeInteger(value)&&String(value)===runId;
}
function syncInRange(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}
function syncSettledCounts(raw) {
  const counts={};
  for(const key of SYNC_BATCH_COUNTS)if(syncInRange(raw[key],0,20))counts[key]=raw[key];
  if(counts.attempted_this_run!==undefined&&counts.completed_this_run>counts.attempted_this_run)delete counts.completed_this_run;
  if(counts.selected_this_run!==undefined&&(counts.attempted_this_run??0)+(counts.deferred_this_run??0)>counts.selected_this_run)delete counts.selected_this_run;
  if(counts.settled_this_run>counts.selected_this_run||counts.settled_this_run<counts.completed_this_run)delete counts.settled_this_run;
  return counts;
}
function syncJobError(code) {
  if(typeof code!=='string'||code.length>64)return null;
  if(SYNC_DISCOVERY_ERRORS.has(code)||SYNC_DOWNLOAD_ERRORS.has(code)||/^http_[45][0-9]{2}$/.test(code))return code;
  for(const parserCode of SYNC_PARSER_ERRORS){
    if(code===parserCode||code.startsWith(parserCode+'_')&&SYNC_PARSER_STAGES.has(code.slice(parserCode.length+1)))return code;
  }
  return null;
}
function syncJobResultRows(value,selected) {
  if(!Array.isArray(value)||value.length>20)return [];
  const rows=[],ids=new Set(),indexes=new Set();
  for(const item of value){
    if(!item||typeof item.job_id!=='string'||!SYNC_JOB_ID.test(item.job_id)||!syncInRange(item.job_index,1,selected??20)
      ||!SYNC_JOB_STATES.has(item.status)||ids.has(item.job_id)||indexes.has(item.job_index))continue;
    ids.add(item.job_id);indexes.add(item.job_index);
    const error=syncJobError(item.error_code),retryAt=syncDetailTime(item.retry_at);
    rows.push({job_id:item.job_id,job_index:item.job_index,status:item.status,
      ...(error?{error_code:error}:{}),...(retryAt?{retry_at:retryAt}:{})});
  }
  return rows.sort((a,b)=>a.job_index-b.job_index);
}
function syncLiveEvent(raw) {
  const phase=raw?.phase;
  if(!SYNC_LIVE_PHASES.has(phase))return null;
  const event={phase};
  if(typeof raw.job_id==='string'&&SYNC_JOB_ID.test(raw.job_id))event.job_id=raw.job_id;
  if(syncInRange(raw.job_index,1,20))event.job_index=raw.job_index;
  if(syncInRange(raw.attempt,1,20))event.attempt=raw.attempt;
  if(SYNC_PARSER_STAGES.has(raw.parser_stage))event.parser_stage=raw.parser_stage;
  const error=syncJobError(raw.error_code),retryAt=syncDetailTime(raw.retry_at);
  if(error)event.error_code=error;
  if(retryAt)event.retry_at=retryAt;
  return event;
}
function syncDetailLive(raw,run,attempt,runStarted,now) {
  if(raw?.schema_version!==1||raw.workflow_run_id!==run.id||raw.workflow_run_attempt!==attempt
    ||!syncInRange(raw.sequence,1,1000000))return null;
  const updatedAt=syncDetailTime(raw.updated_at),updated=Date.parse(updatedAt),earliest=Date.parse(runStarted)-SYNC_CLOCK_SKEW_MS;
  if(!updatedAt||!Number.isFinite(earliest)||updated<earliest||updated>now+SYNC_CLOCK_SKEW_MS)return null;
  const event=syncLiveEvent(raw);
  if(!event)return null;
  const live={schema_version:1,workflow_run_id:run.id,workflow_run_attempt:attempt,sequence:raw.sequence,updated_at:updatedAt,...event,...syncSettledCounts(raw)};
  const maxBytes=2*1024**3;
  if(syncInRange(raw.received_bytes,0,maxBytes))live.received_bytes=raw.received_bytes;
  if(syncInRange(raw.total_bytes,1,maxBytes)&&raw.total_bytes>=(live.received_bytes??0))live.total_bytes=raw.total_bytes;
  if(event.phase==='finished'&&SYNC_DEMO_OUTCOMES.has(raw.run_outcome))live.run_outcome=raw.run_outcome;
  if(event.phase!=='finished'&&(run.status==='completed'||now-updated>SYNC_LIVE_STALE_MS))live.stale=true;
  const recent=[];
  if(Array.isArray(raw.recent)&&raw.recent.length<=8){
    let last=earliest;
    for(const item of raw.recent){
      const past=syncLiveEvent(item),at=syncDetailTime(item?.at),stamp=Date.parse(at);
      if(!past||!at||stamp<last||stamp>updated)continue;
      last=stamp;recent.push({at,...past});
    }
  }
  if(recent.length)live.recent=recent;
  return live;
}
function syncStepState(step) {
  if(step.status==='completed'){
    if(step.conclusion==='success')return 'completed';
    if(step.conclusion==='skipped'||step.conclusion==='neutral')return 'skipped';
    if(['failure','cancelled','timed_out','action_required','startup_failure','stale'].includes(step.conclusion))return 'failed';
  }
  if(step.status==='in_progress')return 'in_progress';
  if(SYNC_ACTIVE.has(step.status))return 'queued';
  return null;
}
function syncStageState(states) {
  if(states.has('failed'))return 'failed';
  if(states.has('in_progress'))return 'in_progress';
  if(states.has('queued'))return states.has('completed')?'in_progress':'queued';
  return states.has('completed')?'completed':'skipped';
}
function syncDetailSteps(payload,runId,attempt) {
  if(!Array.isArray(payload?.jobs)||payload.jobs.length>10)return [];
  const job=payload.jobs.find(item=>item?.name==='sync'&&syncMatchesRunId(item.run_id,runId)&&(!attempt||syncRunAttempt(item.run_attempt)===attempt));
  if(!Array.isArray(job?.steps)||job.steps.length>40)return [];
  const stages=new Map();
  for(const step of job.steps){
    const name=step?.name;
    if(typeof name!=='string'||name.length>100)continue;
    const id=SYNC_STEP_IDS.get(name)??(/^Run actions\/(?:checkout|setup-python|setup-node)@v[0-9]+$/.test(name)?'prepare':null);
    const state=id?syncStepState(step):null;
    if(!state)continue;
    if(!stages.has(id))stages.set(id,[]);
    stages.get(id).push({state,started:syncDetailTime(step.started_at),completed:syncDetailTime(step.completed_at)});
  }
  return [...SYNC_STAGE_LABELS].flatMap(([id,label])=>{
    const rows=stages.get(id);
    if(!rows)return [];
    const states=new Set(rows.map(row=>row.state));
    const started=rows.map(row=>row.started).filter(Boolean).sort();
    const completed=rows.map(row=>row.completed).filter(Boolean).sort();
    const state=syncStageState(states);
    const terminal=state==='completed'||state==='failed'||state==='skipped';
    return [{id,label,state,started_at:started[0]??null,completed_at:terminal?(completed.at(-1)??null):null}];
  });
}
function syncDetailDemo(raw,runId,attempt,runStarted,now) {
  if(!attempt||!raw||!syncMatchesRunId(raw.workflow_run_id,runId)||syncRunAttempt(raw.workflow_run_attempt)!==attempt)return null;
  const lastRun=syncDetailTime(raw.last_run_at),observed=Date.parse(lastRun),earliest=Date.parse(runStarted)-SYNC_CLOCK_SKEW_MS;
  if(!lastRun||!Number.isFinite(earliest)||observed<earliest||observed>now+SYNC_CLOCK_SKEW_MS||!SYNC_DEMO_OUTCOMES.has(raw.run_outcome))return null;
  const demo={run_outcome:raw.run_outcome,last_run_at:lastRun,...syncSettledCounts(raw)};
  if(raw.checkpoint_state==='processing'||raw.checkpoint_state==='final')demo.checkpoint_state=raw.checkpoint_state;
  if(SYNC_DISCOVERY_STATES.has(raw.gc_discovery_status))demo.gc_discovery_status=raw.gc_discovery_status;
  if(SYNC_DISCOVERY_ERRORS.has(raw.gc_discovery_error_code))demo.gc_discovery_error_code=raw.gc_discovery_error_code;
  const statusCounts={};
  for(const key of ['complete','pending','retry','blocked_auth','unavailable']){
    const value=raw.status_counts?.[key];
    if(syncInRange(value,0,1000000))statusCounts[key]=value;
  }
  if(Object.keys(statusCounts).length)demo.status_counts=statusCounts;
  const jobs=syncJobResultRows(raw.job_results,demo.selected_this_run);
  if(jobs.length)demo.job_results=jobs;
  return demo;
}
function syncSafeRun(run) {
  if(!run||!SYNC_RUN_ID.test(String(run.id))||run.head_branch!==SYNC_TARGET.ref)return null;
  const path=String(run.path||'').split('@')[0];if(path!=='.github/workflows/sync.yml')return null;
  const state=SYNC_ACTIVE.has(run.status)?run.status:run.status==='completed'?'completed':null;
  if(!state)return null;
  const attempt=syncRunAttempt(run.run_attempt);
  return {id:String(run.id),status:state,conclusion:typeof run.conclusion==='string'?run.conclusion:null,url:`https://github.com/${SYNC_TARGET.owner}/${SYNC_TARGET.repo}/actions/runs/${run.id}`,created_at:Number.isFinite(Date.parse(run.created_at))?run.created_at:null,updated_at:Number.isFinite(Date.parse(run.updated_at))?run.updated_at:null,...(attempt?{run_attempt:attempt}:{})};
}
function syncRunResult(run,requestId=null) {
  return {configured:true,status:run.status==='completed'?(run.conclusion==='success'?'completed':'failed'):run.status==='in_progress'?'in_progress':'queued',...(requestId?{request_id:requestId}:{}),run};
}
function syncActiveRun(items) {
  return items.find(item=>item.run.status==='in_progress')??items.find(item=>SYNC_ACTIVE.has(item.run.status));
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
  async function provider(path,token,{accept='application/vnd.github+json',timeoutMs=10000,...options}={}) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetcher(path,{...options,redirect:'manual',signal:controller.signal,headers:{Accept:accept,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'CS2-Analyst','Authorization':`Bearer ${token}`,...(options.body?{'Content-Type':'application/json'}:{})}});
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
  async function readDetail(path,token,limit,accept) {
    try {return await syncReadJSON(await provider(path,token,{accept,timeoutMs:SYNC_DETAIL_TIMEOUT_MS}),limit,SYNC_DETAIL_TIMEOUT_MS);}
    catch {return null;}
  }
  async function runProgress({run,raw},token) {
    const progress={run_id:run.id,steps:[]};
    if(run.status!=='in_progress'&&run.status!=='completed')return progress;
    const attempt=syncRunAttempt(raw.run_attempt);
    const jobsPath=attempt?`/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=10`:`/actions/runs/${run.id}/jobs?filter=latest&per_page=10`;
    const [jobs,report,ledger]=await Promise.all([
      readDetail(SYNC_API+jobsPath,token,128*1024),
      attempt?readDetail(`${SYNC_API}/contents/reports/demo_status.json?ref=${SYNC_TARGET.ref}`,token,8*1024,'application/vnd.github.raw+json'):null,
      attempt&&raw.repository?.private===true?readDetail(SYNC_LIVE_URL,token,8*1024,'application/vnd.github.raw+json'):null,
    ]);
    progress.steps=syncDetailSteps(jobs,run.id,attempt);
    const runStarted=syncDetailTime(raw.run_started_at)??run.created_at,observedAt=now();
    const demo=syncDetailDemo(report,run.id,attempt,runStarted,observedAt);
    if(demo)progress.demo=demo;
    const live=syncDetailLive(ledger,run,attempt,runStarted,observedAt);
    if(live)progress.live=live;
    return progress;
  }
  async function complete(run,requestId,token,store,env) {
    const result=syncRunResult(run,requestId);
    if(result.status!=='completed'||!onComplete)return result;
    try {const publication=await onComplete(run,{token,store,env});return {...result,...(publication?{publication,status:publication.status==='publishing'?'publishing':publication.status==='error'?'publication_failed':result.status}:{})};}
    catch {return {...result,status:'publication_failed',publication:{status:'error',error:'sync_snapshot_update_failed'}};}
  }
  async function detailedResult(result,item,detail,token) {
    if(!detail||!item)return syncJSON(await result);
    const [value,progress]=await Promise.all([result,runProgress(item,token)]);
    return syncJSON({...value,progress});
  }
  async function status(url,token,store,env) {
    const params=url.searchParams,keys=[...params.keys()];
    if(keys.some(key=>!['request_id','run_id','detail'].includes(key))||new Set(keys).size!==keys.length)throw new SyncError('invalid_sync_request',400);
    const requestId=params.get('request_id'),runId=params.get('run_id'),detail=params.get('detail');
    if(requestId!==null&&runId!==null||requestId!==null&&!SYNC_UUID.test(requestId)||runId!==null&&!SYNC_RUN_ID.test(runId)||detail!==null&&detail!=='1')throw new SyncError('invalid_sync_request',400);
    if(runId){
      const raw=await syncReadJSON(await provider(`${SYNC_API}/actions/runs/${runId}`,token),SYNC_RESPONSE_LIMIT),run=syncSafeRun(raw);
      if(run?.id!==runId)throw new SyncError('sync_run_not_found',404);
      return detailedResult(complete(run,null,token,store,env),{raw,run},detail,token);
    }
    const items=await runs(token);
    if(requestId){
      const found=items.find(({raw})=>raw.event==='workflow_dispatch'&&raw.display_title===`CS2 Dashboard ${requestId}`);
      if(found)return detailedResult(complete(found.run,requestId,token,store,env),found,detail,token);
      const receipt=await store.get(`requests/${requestId}`);if(!receipt)throw new SyncError('sync_request_not_found',404);
      return syncJSON(syncReceiptResult(receipt,now()));
    }
    const active=syncActiveRun(items);
    const latest=items[0];
    return detailedResult(active?syncRunResult(active.run):{configured:true,status:'idle',latest_run:latest?.run??null},active??latest,detail,token);
  }
  async function dispatch(input,token,store,env) {
    const previous=await store.get(`requests/${input.request_id}`);
    if(previous){const url=new URL('https://sync.invalid/api/sync');url.searchParams.set('request_id',input.request_id);return status(url,token,store,env);}
    const items=await runs(token),active=syncActiveRun(items);
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
