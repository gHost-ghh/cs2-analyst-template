// A projection of server-validated task state. This view never schedules work
// and never infers that a step completed from elapsed time or model prose.
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const list=value=>Array.isArray(value)?value:[];
const text=(value,size=300)=>typeof value==='string'?value.slice(0,size):'';
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const terminal=new Set(['complete','deferred','cancelled']);
const labels={pending:'待执行',ready:'可执行',active:'进行中',complete:'已完成',blocked:'等待依赖',retry:'可重试',deferred:'已推迟',cancelled:'已取消'};
const marks={pending:'○',ready:'○',active:'◉',complete:'✓',blocked:'↳',retry:'↻',deferred:'Ⅱ',cancelled:'×'};
function savedToolOperations(value,status){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const fields=['running','completed','failed','interrupted','retention'],descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==fields.length||Reflect.ownKeys(descriptors).some(key=>!fields.includes(key)||!Object.hasOwn(descriptors[key],'value')))return null;
  const plain=Object.fromEntries(fields.map(key=>[key,descriptors[key].value])),counts=fields.slice(0,4).map(key=>plain[key]);
  if(counts.some(item=>!Number.isSafeInteger(item)||item<0||item>160)||counts.reduce((sum,item)=>sum+item,0)>160||!['recent','complete'].includes(plain.retention)||status!=='running'&&plain.running!==0)return null;
  return plain;
}

/** Deterministic, bounded display lanes for the actual dependency graph. */
export function projectAgentWorkflow(task={}){
  const seen=new Set(),steps=[];
  for(const item of list(task?.plan).slice(0,30)){
    if(!item||typeof item!=='object'||typeof item.id!=='string'||!item.id||seen.has(item.id))continue;
    seen.add(item.id);steps.push({id:text(item.id,120),label:text(item.label,300)||text(item.id,120),detail:text(item.detail,1000),scope:item.scope&&typeof item.scope==='object'?item.scope:null,status:Object.hasOwn(labels,item.status)?item.status:'pending',readiness:item.readiness,depends_on:[...new Set(list(item.depends_on).filter(value=>typeof value==='string').slice(0,30))],blocked_by:list(item.blocked_by).filter(value=>typeof value==='string').slice(0,30)});
  }
  const byId=new Map(steps.map(step=>[step.id,step])),depths=new Map(),cyclic=new Set();
  const depthOf=(step,path=new Set())=>{
    if(depths.has(step.id))return depths.get(step.id);
    if(path.has(step.id)){for(const id of path)cyclic.add(id);return null;}
    const next=new Set(path);next.add(step.id);let depth=0;
    for(const id of step.depends_on){const parent=byId.get(id);if(!parent){depths.set(step.id,null);return null;}const parentDepth=depthOf(parent,next);if(parentDepth===null){depths.set(step.id,null);return null;}depth=Math.max(depth,parentDepth+1);}
    depths.set(step.id,depth);return depth;
  };
  for(const step of steps)depthOf(step);
  const totals={complete:0,active:0,ready:0,waiting:0,retired:0},lanes=new Map();
  for(const step of steps){
    const missing=step.depends_on.filter(id=>!byId.has(id)),waiting=step.depends_on.filter(id=>byId.get(id)?.status!=='complete'),badGraph=cyclic.has(step.id)||depths.get(step.id)===null;
    let display=step.status;
    if(!terminal.has(step.status)&&step.status!=='active'){
      if(badGraph||waiting.length||step.blocked_by.length||step.readiness==='blocked')display='blocked';
      else if(step.status==='blocked'&&step.readiness==='ready')display='retry';
      else if(step.status==='ready'||step.readiness==='ready')display='ready';
      else display='pending';
    }
    if(display==='complete')totals.complete++;else if(display==='active')totals.active++;else if(['ready','retry'].includes(display))totals.ready++;else if(terminal.has(display))totals.retired++;else totals.waiting++;
    const depth=badGraph?null:depths.get(step.id),key=depth??'unresolved';
    const dependencies=step.depends_on.map(id=>({id,label:byId.get(id)?.label||'未知依赖',complete:byId.get(id)?.status==='complete',missing:missing.includes(id)}));
    if(!lanes.has(key))lanes.set(key,{depth,steps:[]});lanes.get(key).steps.push({...step,display,dependencies});
  }
  const operations=savedToolOperations(task?.workflow?.operations,task?.status),recentTools={active:0,complete:0,failed:0,interrupted:0};
  if(operations)Object.assign(recentTools,{active:operations.running,complete:operations.completed,failed:operations.failed,interrupted:operations.interrupted});
  else{
    const tools=new Map();
    for(const entry of list(task?.activity).slice(-160))if(entry?.kind==='tool'&&typeof entry.call_id==='string'&&Number.isSafeInteger(entry.attempt)&&entry.attempt>=0&&['started','completed','failed'].includes(entry.status))tools.set(`${entry.attempt}:${entry.call_id}`,entry.status);
    // Legacy activity has no execution-window epoch. Even a resumed running
    // task cannot prove that an unmatched old `started` call is still alive.
    for(const status of tools.values())recentTools[status==='started'?'interrupted':status==='completed'?'complete':'failed']++;
  }
  return {revision:count(task?.plan_revision),total:steps.length,totals,lanes:[...lanes.values()].sort((a,b)=>(a.depth??Infinity)-(b.depth??Infinity)),recentTools,toolHistoryPartial:operations?operations.retention==='recent':task?.activity_truncated===true};
}

export function renderAgentWorkflow(task){
  const workflow=projectAgentWorkflow(task);if(!workflow.total)return '';
  const laneCards=workflow.lanes.map(lane=>`<section class="agent-workflow-lane" aria-label="${lane.depth===null?'待核对的依赖':`阶段 ${lane.depth+1}`}"><h4>${lane.depth===null?'依赖待核对':`阶段 ${lane.depth+1}`}<span>${lane.steps.length} 项</span></h4><ol>${lane.steps.map(step=>`<li class="agent-workflow-step ${step.display}"><div class="agent-workflow-step-top"><span class="agent-workflow-mark" aria-hidden="true">${marks[step.display]}</span><strong>${escapeHtml(step.label)}</strong><span class="agent-workflow-status">${labels[step.display]}</span></div>${step.dependencies.length?`<p class="agent-workflow-dependencies"><span>依赖</span>${step.dependencies.map(dependency=>`<span class="${dependency.complete?'satisfied':'waiting'}">${dependency.complete?'✓ ':''}${escapeHtml(dependency.label)}</span>`).join('')}</p>`:''}${step.scope?`<p class="agent-workflow-scope">${escapeHtml([step.scope.match_id?'对局 '+String(step.scope.match_id).slice(0,6):'',step.scope.round_number?'R'+step.scope.round_number:'',step.scope.clip_id?'片段 '+step.scope.clip_id:'',step.scope.section||''].filter(Boolean).join(' · '))}</p>`:''}${step.detail?`<p class="agent-workflow-detail">${escapeHtml(step.detail)}</p>`:''}</li>`).join('')}</ol></section>`).join('');
  const recent=workflow.recentTools,toolCount=recent.active+recent.complete+recent.failed+recent.interrupted;
  return `<section class="agent-workflow" aria-label="任务依赖路线"><div class="agent-workflow-heading"><div><span class="agent-workflow-kicker">WORKFLOW</span><h4>任务路线</h4></div><span class="agent-workflow-completion">${workflow.totals.complete} / ${workflow.total} 已完成</span></div><div class="agent-workflow-summary"><span><i class="active" aria-hidden="true"></i>进行中 <strong>${workflow.totals.active}</strong></span><span><i class="ready" aria-hidden="true"></i>可执行 <strong>${workflow.totals.ready}</strong></span><span><i aria-hidden="true"></i>待执行 <strong>${workflow.totals.waiting}</strong></span>${workflow.totals.retired?`<span>推迟 / 取消 <strong>${workflow.totals.retired}</strong></span>`:''}</div><div class="agent-workflow-lanes">${laneCards}</div>${toolCount?`<p class="agent-workflow-tool-summary" aria-label="近期实际工具状态">近期工具 · 运行中 ${recent.active} · 已返回 ${recent.complete} · 未取得结果 ${recent.failed} · 中断 ${recent.interrupted}${workflow.toolHistoryPartial?' · 较早记录已省略':''}</p>`:''}</section>`;
}
