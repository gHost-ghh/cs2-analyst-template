const requestPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const runPattern=/^[1-9][0-9]{0,15}$/;
const messages={sync_not_configured:'Demo 同步服务尚未配置',github_access_denied:'同步权限不足，请检查 GitHub 授权',workflow_unavailable:'同步任务暂不可用',workflow_input_rejected:'同步任务需要更新',github_rate_limited:'GitHub 请求频繁，请稍后重试',github_unavailable:'GitHub 暂时不可用，请稍后重试',origin_rejected:'请从当前页面发起同步',sign_in_required:'请先登录后同步 Demo',sync_state_unavailable:'同步状态暂不可用',sync_service_unavailable:'同步服务暂不可用'};
const storageKey='cs2-demo-sync-pending-v1',receiptKey='cs2-demo-sync-receipt-v1';
const statusLabels={dispatching:'已提交',queued:'等待同步',in_progress:'正在同步',publishing:'正在更新分析数据',publication_failed:'数据更新未完成',completed:'已完成',failed:'未完成',unknown:'结果待确认'};
function safeRecord(value,maxAge){
  if(!value||typeof value!=='object'||!Number.isFinite(value.started_at)||Date.now()-value.started_at>maxAge||value.started_at>Date.now()+60000)return null;
  const request_id=requestPattern.test(value.request_id||'')?value.request_id:null,run_id=runPattern.test(value.run_id||'')?value.run_id:null;
  if(!request_id&&!run_id)return null;
  return {started_at:value.started_at,...(request_id?{request_id}:{}),...(run_id?{run_id}:{}),status:Object.hasOwn(statusLabels,value.status)?value.status:'dispatching',replay_safe:!!request_id&&value.replay_safe===true,...(value.phase==='publication_failed'?{phase:value.phase}:{}),...(typeof value.conclusion==='string'&&/^[a-z_]{1,40}$/.test(value.conclusion)?{conclusion:value.conclusion}:{})};
}
export function mountSync({button,resultButton,showReceipt,reload,notice,fetcher=(...args)=>fetch(...args),storage=globalThis.sessionStorage,timers=globalThis}={}) {
  let pending=null,receipt=null,timer=null,busy=false,checking=false,disposed=false;
  const paint=label=>{
    if(button){button.disabled=busy||checking;button.dataset.syncBusy=String(busy||checking);button.textContent=label||'↻ 同步 Demo';}
    if(resultButton){resultButton.hidden=!receipt?.replay_safe;resultButton.disabled=checking||!!(busy&&pending?.request_id!==receipt?.request_id);resultButton.textContent=checking?'正在核对同步结果':'查看本次同步结果';}
  };
  const remember=()=>{try{if(pending)storage?.setItem(storageKey,JSON.stringify(pending));else storage?.removeItem(storageKey);if(receipt)storage?.setItem(receiptKey,JSON.stringify(receipt));}catch{}};
  function displayReceipt(open=false){showReceipt?.(receipt?{...receipt,status_label:statusLabels[receipt.status]||'结果待确认',url:receipt.run_id?`https://github.com/__GITHUB_REPOSITORY__/actions/runs/${receipt.run_id}`:null}:null,{open});}
  function stopTimer(){if(timer!==null)timers.clearTimeout(timer);timer=null;}
  function clear(){stopTimer();pending=null;busy=false;remember();paint();}
  async function request(url,options){const controller=new AbortController(),timeout=globalThis.setTimeout(()=>controller.abort(),30000);try{const response=await fetcher(url,{...options,signal:controller.signal});return {response,result:await response.json()};}finally{globalThis.clearTimeout(timeout);}}
  async function getStatus(){
    if(disposed||!pending)return;
    const base=pending;
    try {const query=base.run_id?{run_id:base.run_id}:{request_id:base.request_id},{response,result}=await request(`/api/sync?${new URLSearchParams(query)}`,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Object.assign(new Error(messages[result.error]||'读取同步状态失败'),{status:response.status});if(pending!==base)return;await update(result,base);}
    catch(error){if(disposed||pending!==base)return;if(error.status===401||error.status===403||error.status===404){clear();notice?.(error.message,'error');return;}notice?.('同步任务仍在确认中，当前数据已保留');schedule(30000);}
  }
  function schedule(delay=10000){stopTimer();if(!disposed)timer=timers.setTimeout(()=>{timer=null;void getStatus();},delay);}
  async function update(result,base=pending,isReview=false){
    if(disposed)return;
    const previousStatus=receipt?.status;
    const request_id=requestPattern.test(result.request_id||'')?result.request_id:base?.request_id,run_id=runPattern.test(String(result.run?.id||''))?String(result.run.id):base?.run_id;
    receipt=safeRecord({...base,request_id,run_id,status:result.status,conclusion:result.run?.conclusion,replay_safe:requestPattern.test(result.request_id||'')||base?.replay_safe===true,phase:result.status==='publication_failed'?'publication_failed':undefined,started_at:base?.started_at||Date.now()},24*60*60*1000);
    pending=receipt;remember();displayReceipt(isReview);
    if(result.status==='completed'){clear();notice?.(isReview?'本次 Demo 同步已完成':'Demo 同步完成，正在读取分析数据');if(previousStatus!=='completed'||!isReview)await reload?.();return;}
    if(result.status==='publication_failed'){busy=false;paint('↻ 重试数据更新');notice?.('Demo 同步完成，数据更新暂未完成，可点击重试','error');return;}
    if(result.status==='failed'){const reason=result.run?.conclusion==='cancelled'?'Demo 同步已取消':'Demo 同步未完成，可展开本次同步详情';clear();notice?.(reason,'error');return;}
    if(result.status==='unknown'){clear();notice?.('暂未确认任务结果，请展开本次同步详情','error');return;}
    busy=true;paint(result.status==='publishing'?'↻ 更新分析数据':result.status==='in_progress'?'↻ 正在同步':'↻ 等待同步');
    notice?.(result.status==='publishing'?'Demo 同步完成，正在更新分析数据':result.status==='in_progress'?'正在下载与分析 Demo，当前数据可继续查看':result.joined_existing?'已有同步任务，正在查看进度':'Demo 同步任务已提交');
    schedule(Math.max(5000,Math.min(30000,(result.retry_after||10)*1000)));
  }
  async function refresh(){
    if(disposed||busy||checking)return;if(pending?.phase==='publication_failed'){busy=true;paint('↻ 更新分析数据');await getStatus();return;}busy=true;paint('↻ 提交同步');notice?.('正在启动 Demo 同步');
    const requestId=globalThis.crypto.randomUUID();pending={request_id:requestId,started_at:Date.now(),replay_safe:false,status:'dispatching'};remember();
    try {
      const {response,result}=await request('/api/sync',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({request_id:requestId})});
      if(!response.ok){clear();notice?.(result.error==='sync_cooldown'?`请 ${Math.max(1,result.retry_after||120)} 秒后再次同步`:messages[result.error]||'Demo 同步暂时不可用','error');return;}
      await update(result);
    }catch {notice?.('提交结果待确认，正在查询同步状态');schedule(10000);}
  }
  async function review(){
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
  try {const text=storage?.getItem(storageKey),saved=text&&text.length<=1024?safeRecord(JSON.parse(text),4*60*60*1000):null;if(saved){pending=saved;if(!receipt)receipt={...saved};if(saved.phase==='publication_failed'){busy=false;paint('↻ 重试数据更新');}else{busy=true;paint('↻ 查询同步');schedule(0);}}}catch{}
  displayReceipt();paint(pending?.phase==='publication_failed'?'↻ 重试数据更新':busy?'↻ 查询同步':null);
  return {refresh,review,get busy(){return busy||checking;},repaint(){paint(pending?.phase==='publication_failed'?'↻ 重试数据更新':busy?'↻ 正在同步':null);},dispose(){disposed=true;stopTimer();button?.removeEventListener('click',refresh);resultButton?.removeEventListener('click',review);}};
}
