const requestPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const runPattern=/^[1-9][0-9]{0,15}$/;
const messages={sync_not_configured:'Demo 同步服务尚未配置',github_access_denied:'同步权限不足，请检查 GitHub 授权',workflow_unavailable:'同步任务暂不可用',workflow_input_rejected:'同步任务需要更新',github_rate_limited:'GitHub 请求频繁，请稍后重试',github_unavailable:'GitHub 暂时不可用，请稍后重试',origin_rejected:'请从当前页面发起同步',sign_in_required:'请先登录后同步 Demo',sync_state_unavailable:'同步状态暂不可用',sync_service_unavailable:'同步服务暂不可用'};
const storageKey='cs2-demo-sync-pending-v1',receiptKey='cs2-demo-sync-receipt-v1',detailKey='cs2-demo-sync-detail-v1';
const statusLabels={dispatching:'已提交',queued:'等待同步',in_progress:'正在同步',publishing:'正在更新分析数据',publication_failed:'数据更新未完成',completed:'已完成',failed:'未完成',unknown:'结果待确认'};
const buttonLabels={dispatching:'正在提交',queued:'正在排队',in_progress:'正在同步',publishing:'正在更新分析数据',publication_failed:'重试数据更新',completed:'再次同步 Demo',unknown:'同步结果待确认',cooldown:'同步 Demo'};
const activeStatuses=new Set(['dispatching','queued','in_progress','publishing']);
const stepLabels={prepare:'准备运行环境',discover:'发现 Steam 对局',process:'下载与解析 Demo',summary:'整理同步报告',checkpoint:'保存分析数据',publish:'更新站点快照',finish:'检查运行结果'};
const stepStates=new Set(['queued','in_progress','completed','skipped','failed']);
const demoOutcomes=new Set(['idle','ok','partial','failed','blocked_auth','waiting_for_replays','deferred_steam_playing_elsewhere']);
const countFields=['attempted_this_run','completed_this_run','deferred_this_run','selected_this_run'];
const jobStates=['complete','pending','retry','unavailable','blocked_auth'];
const detailStatuses=new Set([...Object.keys(statusLabels),'idle','not_configured','error','cooldown']);
const observeIdleMs=50000;
const safeTime=value=>typeof value==='string'&&value.length<=45&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const safeCount=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const runUrl=id=>`https://github.com/__GITHUB_REPOSITORY__/actions/runs/${id}`;
function safeRun(value){
  const raw=value?.id,id=typeof raw==='string'||Number.isSafeInteger(raw)?String(raw):'';
  if(!runPattern.test(id))return null;
  const {status,conclusion,run_attempt}=value;
  return {id,url:runUrl(id),status:['queued','in_progress','completed','waiting','pending','requested'].includes(status)?status:null,
    conclusion:typeof conclusion==='string'&&/^[a-z_]{1,40}$/.test(conclusion)?conclusion:null,
    created_at:safeTime(value.created_at),updated_at:safeTime(value.updated_at),
    ...(safeCount(run_attempt,1000000)&&run_attempt>0?{run_attempt}:{})};
}
function safeProgress(value,run){
  if(!run||value?.run_id!==run.id)return null;
  const steps=[],seen=new Set();
  for(const step of Array.isArray(value.steps)?value.steps.slice(0,16):[]){
    if(typeof step?.id!=='string'||!Object.hasOwn(stepLabels,step.id)||seen.has(step.id)||!stepStates.has(step.state))continue;
    seen.add(step.id);
    steps.push({id:step.id,label:stepLabels[step.id],state:step.state,started_at:safeTime(step.started_at),completed_at:safeTime(step.completed_at)});
  }
  const raw=value.demo;
  if(!raw||typeof raw!=='object')return {run_id:run.id,steps};
  const demo={};
  for(const key of countFields)if(safeCount(raw[key],20))demo[key]=raw[key];
  if(demoOutcomes.has(raw.run_outcome))demo.run_outcome=raw.run_outcome;
  if(['discovered','not_checked','expired','transient','unavailable'].includes(raw.gc_discovery_status))demo.gc_discovery_status=raw.gc_discovery_status;
  if(typeof raw.gc_discovery_error_code==='string'&&/^[a-z_]{1,64}$/.test(raw.gc_discovery_error_code))demo.gc_discovery_error_code=raw.gc_discovery_error_code;
  if(safeTime(raw.last_run_at))demo.last_run_at=raw.last_run_at;
  const counts=Object.fromEntries(jobStates.filter(key=>safeCount(raw.status_counts?.[key],1000000)).map(key=>[key,raw.status_counts[key]]));
  if(Object.keys(counts).length)demo.status_counts=counts;
  return {run_id:run.id,steps,...(Object.keys(demo).length?{demo}:{})};
}
function safePublication(value){
  if(!value||!['publishing','updated','unchanged','error'].includes(value.status))return null;
  const result={status:value.status};
  for(const key of ['staged_count','total_shards','match_count'])if(safeCount(value[key],1000000))result[key]=value[key];
  if(safeTime(value.generated_at))result.generated_at=value.generated_at;
  if(typeof value.source_revision==='string'&&/^[a-f0-9]{40,64}$/.test(value.source_revision))result.source_revision=value.source_revision;
  return result;
}
function detailView(result,source){
  if(!result||typeof result!=='object'||Array.isArray(result))result={status:'error',error:'sync_service_unavailable'};
  const run=safeRun(result.run||result.latest_run);
  const status=detailStatuses.has(result.status)?result.status:'unknown';
  return {status:status==='idle'&&run?.status==='completed'?(run.conclusion==='success'?'completed':'failed'):status,
    source,run,progress:safeProgress(result.progress,run),publication:safePublication(result.publication),
    ...(safeCount(result.retry_after,3600)?{retry_after:result.retry_after}:{}),
    ...(typeof result.error==='string'&&(Object.hasOwn(messages,result.error)||result.error==='sync_cooldown')?{error:result.error}:{}),
    ...(result.progress_stale===true?{progress_stale:true}:{}),
    ...(result.joined_existing===true?{joined_existing:true}:{})};
}
function sameRun(view,previous){
  return !!view&&view.id===previous?.id&&view.run_attempt===previous.run_attempt;
}
function retainProgress(view,previous){
  if(!sameRun(view.run,previous?.run)||!previous.progress)return view;
  const steps=view.progress?.steps.length?view.progress.steps:previous.progress.steps;
  const demo=view.progress?.demo||previous.progress.demo;
  const stale=steps.length&&!view.progress?.steps.length||demo&&!view.progress?.demo;
  return stale?{...view,progress:{run_id:view.run.id,steps,...(demo?{demo}:{})},progress_stale:true}:view;
}
function olderRun(run,previous){
  if(!run||!previous)return false;
  if(run.id===previous.id)return !!run.run_attempt&&!!previous.run_attempt&&run.run_attempt<previous.run_attempt;
  if(run.created_at&&previous.created_at&&run.created_at!==previous.created_at)return run.created_at<previous.created_at;
  return run.id.length===previous.id.length?run.id<previous.id:run.id.length<previous.id.length;
}
function safeRecord(value,maxAge){
  if(!value||typeof value!=='object'||!Number.isFinite(value.started_at)||Date.now()-value.started_at>maxAge||value.started_at>Date.now()+60000)return null;
  const request_id=requestPattern.test(value.request_id||'')?value.request_id:null,run_id=runPattern.test(value.run_id||'')?value.run_id:null;
  if(!request_id&&!run_id)return null;
  return {started_at:value.started_at,...(request_id?{request_id}:{}),...(run_id?{run_id}:{}),status:Object.hasOwn(statusLabels,value.status)?value.status:'dispatching',replay_safe:!!request_id&&value.replay_safe===true,...(value.phase==='publication_failed'?{phase:value.phase}:{}),...(typeof value.conclusion==='string'&&/^[a-z_]{1,40}$/.test(value.conclusion)?{conclusion:value.conclusion}:{})};
}
export function mountSync({button,resultButton,showReceipt,showProgress,reload,notice,fetcher=(...args)=>fetch(...args),storage=globalThis.sessionStorage,timers=globalThis}={}) {
  let pending=null,receipt=null,timer=null,busy=false,checking=false,disposed=false;
  const detailed=typeof showProgress==='function';
  let manualView=null,observedView=null,observing=false,observeTimer=null,observeEpoch=0;
  const currentView=()=>pending?manualView:(observedView||manualView);
  function displayProgress(open=false){if(detailed)showProgress(currentView()||{status:'idle',source:'background'},{open});}
  const paint=label=>{
    const view=currentView(),observedActive=observing&&view?.source==='background'&&activeStatuses.has(view.status);
    const active=busy||checking||observedActive;
    if(button){
      button.disabled=active;
      button.dataset.syncBusy=String(active);
      if(detailed){
        const status=view?.source==='background'&&!observing?'idle':view?.status||'idle';
        const waiting=['waiting_for_replays','deferred_steam_playing_elsewhere'].includes(view?.progress?.demo?.run_outcome);
        button.dataset.syncState=status==='completed'&&waiting?'waiting':status;
        button.setAttribute?.('aria-busy',String(active));
        const target=button.querySelector?.('[data-sync-label]')||button;
        target.textContent=buttonLabels[status]||'同步 Demo';
      }else button.textContent=label||'↻ 同步 Demo';
    }
    if(resultButton){
      resultButton.hidden=detailed?!view||view.status==='idle':!receipt?.replay_safe;
      resultButton.disabled=detailed?false:checking||!!(busy&&pending?.request_id!==receipt?.request_id);
      resultButton.textContent=detailed?(activeStatuses.has(view?.status)?'查看同步进度':'查看同步结果'):checking?'正在核对同步结果':'查看本次同步结果';
    }
  };
  const remember=()=>{try{
    if(pending)storage?.setItem(storageKey,JSON.stringify(pending));else storage?.removeItem(storageKey);
    if(receipt)storage?.setItem(receiptKey,JSON.stringify(receipt));
    if(detailed&&manualView?.run&&manualView.run.id===receipt?.run_id)storage?.setItem(detailKey,JSON.stringify(manualView));
  }catch{}};
  function displayReceipt(open=false){showReceipt?.(receipt?{...receipt,status_label:statusLabels[receipt.status]||'结果待确认',url:receipt.run_id?runUrl(receipt.run_id):null}:null,{open});}
  function stopTimer(){if(timer!==null)timers.clearTimeout(timer);timer=null;}
  function clear(){stopTimer();pending=null;busy=false;remember();paint();scheduleObserver(observeIdleMs);}
  async function request(url,options){const controller=new AbortController(),timeout=globalThis.setTimeout(()=>controller.abort(),30000);try{const response=await fetcher(url,{...options,signal:controller.signal});return {response,result:await response.json()};}finally{globalThis.clearTimeout(timeout);}}
  function readStatus(selector={}){
    const query=new URLSearchParams(selector);if(detailed)query.set('detail','1');
    return request(`/api/sync?${query}`,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});
  }
  function setManual(result){if(detailed)manualView=retainProgress(detailView(result,'manual'),manualView);}
  function stopObserver(){
    observeEpoch++;
    if(observeTimer!==null)timers.clearTimeout(observeTimer);
    observeTimer=null;
  }
  function scheduleObserver(delay){
    stopObserver();
    if(observing&&!disposed&&!pending)observeTimer=timers.setTimeout(()=>{observeTimer=null;void observe();},delay);
  }
  async function observe(){
    const epoch=observeEpoch;
    if(disposed||!observing||pending)return;
    let result,httpStatus;
    try{
      const {response,result:value}=await readStatus();
      httpStatus=response.status;
      result=response.ok||detailStatuses.has(value?.status)?value:{status:'error',error:value?.error};
    }catch{result={status:'error',error:'github_unavailable'};}
    if(disposed||epoch!==observeEpoch||!observing||pending)return;
    const view=detailView(result,'background'),previous=observedView||manualView;
    if(previous?.run&&(!view.run||olderRun(view.run,previous.run))){
      observedView=view.status==='error'||view.status==='not_configured'
        ?{...previous,read_error:view.error||'sync_service_unavailable',progress_stale:!!previous.progress}
        :previous;
    }else{
      observedView=retainProgress(view,previous);
      if(sameRun(view.run,manualView?.run)&&manualView.status===view.status){
        observedView.source='manual';
        observedView.publication=manualView.publication;
      }
    }
    paint();displayProgress();
    if([401,403,404].includes(httpStatus)||view.status==='not_configured')return;
    if(activeStatuses.has(view.status))scheduleObserver(Math.max(5000,Math.min(30000,(view.retry_after||15)*1000)));
    else scheduleObserver(observeIdleMs);
  }
  function watch(visible){
    if(!detailed||disposed||observing===!!visible)return;
    observing=!!visible;
    if(observing)scheduleObserver(0);else stopObserver();
    paint();
  }
  async function getStatus(){
    if(disposed||!pending)return;
    const base=pending;
    try {const query=base.run_id?{run_id:base.run_id}:{request_id:base.request_id},{response,result}=await readStatus(query);if(!response.ok)throw Object.assign(new Error(messages[result.error]||'读取同步状态失败'),{status:response.status,code:result.error});if(pending!==base)return;await update(result,base);}
    catch(error){if(disposed||pending!==base)return;if(error.status===401||error.status===403||error.status===404){setManual({status:'error',error:error.code});clear();displayProgress();notice?.(error.message,'error');return;}if(detailed&&manualView){manualView={...manualView,status:'unknown',read_error:'github_unavailable',progress_stale:!!manualView.progress};paint();displayProgress();}notice?.('同步任务仍在确认中，当前数据已保留');schedule(30000);}
  }
  function schedule(delay=10000){stopTimer();if(!disposed)timer=timers.setTimeout(()=>{timer=null;void getStatus();},delay);}
  async function update(result,base=pending,isReview=false){
    if(disposed)return;
    const previousStatus=receipt?.status;
    const request_id=requestPattern.test(result.request_id||'')?result.request_id:base?.request_id,run_id=runPattern.test(String(result.run?.id||''))?String(result.run.id):base?.run_id;
    receipt=safeRecord({...base,request_id,run_id,status:result.status,conclusion:result.run?.conclusion,replay_safe:requestPattern.test(result.request_id||'')||base?.replay_safe===true,phase:result.status==='publication_failed'?'publication_failed':undefined,started_at:base?.started_at||Date.now()},24*60*60*1000);
    pending=receipt;
    setManual(result);remember();displayReceipt(isReview);displayProgress();
    if(result.status==='completed'){
      clear();
      const outcome=manualView?.progress?.demo?.run_outcome;
      notice?.(outcome==='waiting_for_replays'?'同步已结束，录像待提供':outcome==='deferred_steam_playing_elsewhere'?'Steam 正在游戏，同步已暂缓':isReview?'本次 Demo 同步已完成':'Demo 同步完成，正在读取分析数据');
      if(previousStatus!=='completed'||!isReview)await reload?.();return;
    }
    if(result.status==='publication_failed'){busy=false;paint('↻ 重试数据更新');notice?.('Demo 同步完成，数据更新暂未完成，可点击重试','error');return;}
    if(result.status==='failed'){const reason=result.run?.conclusion==='cancelled'?'Demo 同步已取消':'Demo 同步未完成，可展开本次同步详情';clear();notice?.(reason,'error');return;}
    if(result.status==='unknown'){clear();notice?.('暂未确认任务结果，请展开本次同步详情','error');return;}
    busy=true;paint(result.status==='publishing'?'↻ 更新分析数据':result.status==='in_progress'?'↻ 正在同步':'↻ 等待同步');
    if(!detailed||previousStatus!==result.status)notice?.(result.status==='publishing'?'Demo 同步完成，正在更新分析数据':result.status==='in_progress'?'正在下载与分析 Demo，当前数据可继续查看':result.joined_existing?'已有同步任务，正在查看进度':'Demo 同步任务已提交');
    schedule(Math.max(5000,Math.min(30000,(result.retry_after||10)*1000)));
  }
  async function refresh(){
    if(disposed||busy||checking)return;
    if(pending?.phase==='publication_failed'){busy=true;if(detailed&&manualView)manualView={...manualView,status:'publishing'};paint('↻ 更新分析数据');displayProgress();await getStatus();return;}
    stopObserver();observedView=null;busy=true;setManual({status:'dispatching'});
    const requestId=globalThis.crypto.randomUUID();pending={request_id:requestId,started_at:Date.now(),replay_safe:false,status:'dispatching'};remember();
    paint('↻ 提交同步');displayProgress();notice?.('正在启动 Demo 同步');
    try {
      const {response,result}=await request('/api/sync',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({request_id:requestId})});
      if(!response.ok){setManual(result.error==='sync_cooldown'?{...result,status:'cooldown'}:result);clear();displayProgress();notice?.(result.error==='sync_cooldown'?`请 ${Math.max(1,result.retry_after||120)} 秒后再次同步`:messages[result.error]||'Demo 同步暂时不可用','error');return;}
      await update(result);
    }catch{
      if(disposed)return;
      if(detailed){manualView={...manualView,status:'unknown',read_error:'github_unavailable'};paint();displayProgress();}
      notice?.('提交结果待确认，正在查询同步状态');schedule(10000);
    }
  }
  async function review(){
    if(detailed){if(!disposed&&currentView())displayProgress(true);return;}
    // Joining an existing run does not create a receipt for a new request ID.
    // Only a server-confirmed receipt may be replayed by this explicit action.
    if(disposed||checking||!receipt?.replay_safe||busy&&pending?.request_id!==receipt.request_id)return;
    const base=receipt;checking=true;stopTimer();paint(busy?'↻ 正在同步':null);
    // Invalidate an earlier GET so that it cannot overwrite this result.
    pending=pending?{...pending}:null;
    notice?.('正在核对本次同步结果');
    try {
      const {response,result}=await request('/api/sync',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({request_id:base.request_id})});
      if(!response.ok)throw new Error(messages[result.error]||'暂时无法核对同步结果');
      await update(result,base,true);
    }catch(error){if(!disposed){displayReceipt(true);notice?.(Object.values(messages).includes(error.message)?`${error.message}，本次回执已保留`:'暂时无法核对同步结果，本次回执已保留','error');if(busy&&pending)schedule(30000);}}
    finally {checking=false;if(!disposed)paint(pending?.phase==='publication_failed'?'↻ 重试数据更新':busy?'↻ 正在同步':null);}
  }
  button?.addEventListener('click',refresh);resultButton?.addEventListener('click',review);
  try {const text=storage?.getItem(receiptKey);if(text&&text.length<=1024)receipt=safeRecord(JSON.parse(text),24*60*60*1000);}catch{}
  try {const text=storage?.getItem(storageKey),saved=text&&text.length<=1024?safeRecord(JSON.parse(text),4*60*60*1000):null;if(saved){pending=saved;if(!receipt)receipt={...saved};if(saved.phase!=='publication_failed'){busy=true;schedule(0);}}}catch{}
  if(detailed&&(pending||receipt)){
    const base=pending||receipt;
    let saved;
    try {const text=storage?.getItem(detailKey);if(text&&text.length<=8192){const value=JSON.parse(text);if(base.run_id&&value?.run?.id===base.run_id)saved=value;}}catch{}
    setManual({...saved,status:base.status,run:saved?.run||(base.run_id?{id:base.run_id,conclusion:base.conclusion}:null)});
  }
  displayReceipt();displayProgress();paint(pending?.phase==='publication_failed'?'↻ 重试数据更新':busy?'↻ 查询同步':null);
  return {refresh,review,watch,get busy(){return busy||checking;},repaint(){paint(pending?.phase==='publication_failed'?'↻ 重试数据更新':busy?'↻ 正在同步':null);},dispose(){disposed=true;stopTimer();stopObserver();button?.removeEventListener('click',refresh);resultButton?.removeEventListener('click',review);}};
}
