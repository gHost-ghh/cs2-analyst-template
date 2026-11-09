import {mountAgentVisual} from './agent-visual.js';
import {renderAgentWorkflow} from './agent-workflow.js';
import {prepareProviderTrace,reduceProviderTrace,renderProviderTrace} from './agent-reasoning.js';
import {validateBoundAgentVisualization} from '../shared/agent-visual.mjs';

const coachEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const coachResourceNames={catalog:'数据目录',status:'样本范围',overview:'总体表现',matches:'对局档案',match:'对局详情',players:'玩家名单',player:'玩家档案',compare:'共同对局对比',rounds:'回合数据',round:'回合详情',round_results:'回合结果',events:'交战事件',analysis:'技术指标',aim:'定位片段',replay_frames:'回放帧',grenades:'投掷轨迹',effects:'道具效果',shots:'射击记录',bullet_impacts:'弹着点',damage_events:'伤害记录',bomb:'C4 状态',definitions:'指标定义',sync:'同步状态',inspect:'数据明细',raw_schema:'原始字段目录',raw_rows:'原始数据行'};
const coachErrorText={not_configured:'模型密钥尚未配置。',provider_auth_failed:'模型服务拒绝当前凭证，不会自动重复请求；请检查密钥和项目权限后继续。',provider_quota_exceeded:'模型服务商账户额度不足，不会自动重复请求；请补足额度后继续。',provider_rate_limited:'模型服务商当前限流，本轮不会自动重复请求；请稍后核对进度再继续。',provider_timeout:'本次请求超时，请先读取任务状态，确认进度后继续。',provider_unreachable:'暂时无法连接模型服务。',provider_request_failed:'模型服务暂时无法完成分析。',analysis_incomplete:'模型尚未提交完整结果，请先读取任务状态，再继续本任务或补充说明。',analysis_evidence_invalid:'结果中的引用未通过核对，请读取当前任务状态后继续修订。',analysis_format_invalid:'结果格式未通过校验，请读取当前任务状态后继续修订。',query_budget_exhausted:'本次读取暂未完成，请先核对任务状态，再继续本任务。',analysis_in_progress:'另一项分析正在进行。',origin_rejected:'登录状态已变化，请刷新页面。',snapshot_unavailable:'比赛数据暂不可用。',match_not_found:'当前对局已变化，请重新选择。',invalid_question:'请输入 1–1600 字的任务目标。',invalid_task:'请选择有效的分析任务。',request_cancelled:'分析已取消。'};
coachErrorText.provider_key_format_invalid='模型密钥格式有误，请在项目设置中检查后保存。';
coachErrorText.analysis_visual_invalid='交互图解尚未通过校验，请核对任务进度后继续修订。';
Object.assign(coachErrorText,{continuation_required:'本轮进度已保存，可继续执行或在同一会话补充需求。',conversation_not_found:'未找到该会话。可重试尚未确认的一轮，或创建新任务。',conversation_expired:'该会话已过期，请创建新任务；现有分析记录仍可查看。',invalid_conversation:'会话信息无效，请创建新任务。',conversation_storage_unavailable:'会话暂时无法保存，请稍后重试。'});
Object.assign(coachErrorText,{stream_interrupted:'连接已中断，正在核对已保存的任务状态。未校验的草稿不会作为正式结果。',stream_invalid:'分析数据流无法读取，任务进度可从服务端恢复。',stream_too_large:'分析数据流过大，任务进度可从服务端恢复。'});
const coachGoals=[
  {mode:'diagnose',label:'技术诊断',icon:'◎',description:'发现优先改进项',question:'结合当前筛选范围的比赛数据，找出最影响我表现的 3 个技术问题，引用具体证据，给出下一阶段训练目标。'},
  {mode:'match_review',label:'对局复盘',icon:'↗',description:'回到关键回合',question:'复盘当前选择的对局，找出最值得改进的关键回合、决策与技术问题，给出证据和具体调整。'},
  {mode:'aim_lab',label:'瞄准实验室',icon:'⊕',description:'定位、急停与射击',question:'分析当前范围的定位、首发时机、急停与连续射击，区分已测结果和缺失数据，引用片段并列出值得原生渲染复核的回合。'},
  {mode:'teamwork',label:'团队配合',icon:'⇄',description:'共同回合与道具',question:'分析我与常一起玩的队友在共同回合中的差异，包括伤害、首杀、补枪、道具和配合，引用证据并提出可执行的调整。'},
  {mode:'training',label:'训练计划',icon:'▥',description:'安排练习与复测',question:'根据当前范围最明确的技术短板，制定下一阶段训练计划，安排每项练习的时长、方法和可复测目标，并引用比赛依据。'},
];
const coachHistoryKey='cs2.coach.tasks.v1',coachHistoryLimit=10,coachHistoryMaxChars=240000,coachHistoryResultMaxChars=60000;
const coachConversationKey='cs2.coach.conversation.v1';
const coachArray=value=>Array.isArray(value)?value:[];
const coachText=(value,length=1600)=>String(value??'').slice(0,length);
const coachTime=value=>{const date=new Date(value||'');return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});};
const coachCount=value=>Number.isFinite(Number(value))?Math.max(0,Math.trunc(Number(value))):0;
const coachErrorCount=value=>Array.isArray(value)?value.length:coachCount(value);
const coachModeLabel=mode=>coachGoals.find(goal=>goal.mode===mode)?.label||'技术诊断';
const coachActions=result=>coachArray(result?.agent?.actions).filter(action=>action&&typeof action.id==='string'&&action.id.length<=120&&['open_evidence','request_render','open_sync'].includes(action.kind)&&(action.kind==='open_sync'||coachArray(result.evidence).some(ref=>ref?.id===action.evidence_ref))).slice(0,4);
Object.assign(coachResourceNames,{native_captures:'已验收原生片段',native_frames:'原生帧观测'});
const coachVisualActions=['open_evidence','open_match','open_round','open_aim','open_replay','request_render'];

/** Decode real SSE frames; no timers synthesize text or model progress. */
export async function readCoachEventStream(response,{signal,onEvent=()=>{},maxEventBytes=1024*1024,maxStreamBytes=16*1024*1024}={}){
  const reader=response.body?.getReader();if(!reader)throw Object.assign(Error(),{code:'stream_invalid'});
  const decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();let buffer='',data=[],event='message',eventBytes=0,total=0,stopped=false,ended=false;
  const abortError=()=>Object.assign(Error('Aborted'),{name:'AbortError'}),abort=()=>{reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  async function line(value){
    if(value===''){
      if(data.length){let payload;try{payload=JSON.parse(data.join('\n'));}catch{throw Object.assign(Error(),{code:'stream_invalid'});}if(await onEvent({event,data:payload})===false)stopped=true;}
      data=[];event='message';eventBytes=0;return;
    }
    eventBytes+=encoder.encode(value).byteLength+1;if(eventBytes>maxEventBytes)throw Object.assign(Error(),{code:'stream_too_large'});
    if(value.startsWith(':'))return;const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon),raw=colon<0?'':value.slice(colon+1),content=raw.startsWith(' ')?raw.slice(1):raw;
    if(field==='data')data.push(content);else if(field==='event')event=content;
  }
  async function flush(final=false){
    while(!stopped){const match=/[\r\n]/.exec(buffer);if(!match)break;const offset=match.index;if(buffer[offset]==='\r'&&offset===buffer.length-1&&!final)break;const count=buffer[offset]==='\r'&&buffer[offset+1]==='\n'?2:1,value=buffer.slice(0,offset);buffer=buffer.slice(offset+count);await line(value);}
    if(encoder.encode(buffer).byteLength+eventBytes>maxEventBytes)throw Object.assign(Error(),{code:'stream_too_large'});
    // An EOF without a blank-line delimiter is an incomplete SSE event.
    if(final&&!stopped){buffer='';data=[];eventBytes=0;}
  }
  try{
    while(!stopped){if(signal?.aborted)throw abortError();const part=await reader.read();if(signal?.aborted)throw abortError();if(part.done){ended=true;buffer+=decoder.decode();await flush(true);break;}total+=part.value.byteLength;if(total>maxStreamBytes)throw Object.assign(Error(),{code:'stream_too_large'});buffer+=decoder.decode(part.value,{stream:true});await flush();}
    return {ended,stopped,bytes:total};
  }catch(error){if(signal?.aborted)throw abortError();if(typeof error.code==='string'&&(error.streamFailure||Object.hasOwn(coachErrorText,error.code)))throw error;throw Object.assign(Error(),{code:'stream_invalid'});}
  finally{signal?.removeEventListener('abort',abort);if(!ended)try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}
}

const coachStreamTypes=['provider_trace','status','plan','tool','activity','artifact','draft_delta','draft_reset','validated','paused','completed','error','snapshot'];
const coachStreamPhases={connecting:'正在连接任务',reading:'正在读取比赛证据',planning:'正在更新任务计划',generating:'正在分析已读取证据',presenting:'正在生成讲解',repairing:'正在修订讲解',validating:'正在校验引用与交互文档',recovering:'连接中断，正在读取已保存进度',paused:'进度已保存，等待继续',completed:'分析已校验完成',error:'本次执行已中断'};
coachStreamPhases.continuing='正在继续读取与核查余下数据';
const coachStreamSource=value=>({source_revision:coachText(value?.source_revision,120)||null,generated_at:coachText(value?.generated_at,60)||null,content_sha256:coachText(value?.content_sha256,80)||null});
export function newCoachStreamState(conversation){return {id:conversation.id,turn_id:conversation.turn_id,stream_id:null,seq:0,attempt:-1,source:null,phase:'connecting',headline:'',summary:'',unverified:true,tools:[],activity:[],provider_trace:[],activity_truncated:false,plan_revision:0};}
export function reduceCoachStreamEvent(previous,frame){
  const value=frame?.data;
  if(!coachRecord(value)||value.version!==1||!coachStreamTypes.includes(value.type)||frame.event!==`agent.${value.type}`||!coachUuid(value.stream_id)||previous.stream_id&&value.stream_id!==previous.stream_id||!Number.isSafeInteger(value.seq)||value.seq<=previous.seq||value.seq<1||!Number.isSafeInteger(value.attempt)||value.attempt<0||value.attempt<previous.attempt||value.session?.id!==previous.id||value.session?.turn_id!==previous.turn_id||value.id!==`${previous.turn_id}:${value.stream_id}:${value.seq}`||!coachRecord(value.source)||!coachRecord(value.payload))return {state:previous,accepted:false};
  const source=coachStreamSource(value.source);if(previous.source&&JSON.stringify(source)!==JSON.stringify(previous.source))return {state:previous,accepted:false};
  const state={...previous,stream_id:value.stream_id,seq:value.seq,attempt:value.attempt,source,tools:previous.tools.slice()};if(value.attempt>previous.attempt){state.headline='';state.summary='';state.unverified=true;}
  const payload=value.payload;
  if(value.type==='provider_trace'){const trace=reduceProviderTrace(previous.provider_trace,payload,value.attempt);if(!trace)return {state:previous,accepted:false};state.provider_trace=trace;}
  if(value.type==='status'&&Object.hasOwn(coachStreamPhases,payload.phase))state.phase=payload.phase;
  if(value.type==='draft_reset'){state.headline='';state.summary='';state.unverified=true;}
  if(value.type==='draft_delta'&&payload.unverified===true&&['headline','summary'].includes(payload.field)&&typeof payload.text==='string'){
    if(state[payload.field].length+payload.text.length>256*1024)throw Object.assign(Error(),{code:'stream_too_large'});state[payload.field]+=payload.text;state.phase='presenting';
  }
  if(value.type==='plan')state.plan_revision=Math.max(previous.plan_revision,coachCount(payload.plan_revision));
  if(value.type==='activity'){
    const entry=prepareCoachActivity([payload],previous.turn_id)[0];if(!entry)return {state:previous,accepted:false};
    state.activity=mergeCoachActivity(previous.activity,[entry],previous.turn_id);state.activity_truncated=previous.activity_truncated||coachArray(previous.activity).length>=160&& !previous.activity.some(item=>item.id===entry.id);
  }
  if(value.type==='tool'&&typeof payload.call_id==='string'&&payload.call_id.length<=200&&typeof payload.name==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(payload.name)&&['started','completed','failed'].includes(payload.status)){
    const key=`${value.attempt}:${payload.call_id}`,tool={key,call_id:payload.call_id,name:payload.name,status:payload.status,resource:Object.hasOwn(coachResourceNames,payload.resource)?payload.resource:null},index=state.tools.findIndex(item=>item.key===key);if(index<0)state.tools.push(tool);else state.tools[index]=tool;state.tools=state.tools.slice(-32);
  }
  if(['paused','completed','error'].includes(value.type))state.phase=value.type;
  return {state,accepted:true,type:value.type,payload,session:value.session};
}
function coachLiveVisuals(result){
  const refs=new Set(coachArray(result?.evidence).map(item=>item?.id));
  return coachArray(result?.agent?.visualizations).slice(0,2).filter(visual=>validateBoundAgentVisualization(visual)&&visual.evidence_refs.every(id=>refs.has(id)));
}

function coachAgentHtml(result) {
  const agent=result?.agent;if(!agent)return '';
  const coverage=agent.coverage||{},steps=coachArray(agent.steps).slice(0,8),actions=coachActions(result);
  return `<section class="coach-agent-plan" aria-label="任务执行记录"><div class="coach-plan-heading"><div><span class="coach-eyebrow">TASK RECORD</span><h3>本轮执行记录</h3></div><span class="coach-complete-mark">✓ 分析结果已返回</span></div>${agent.goal?`<p class="coach-task-goal">${coachEscape(agent.goal)}</p>`:''}${agent.scope?`<p class="coach-task-scope">${coachEscape(agent.scope)}</p>`:''}${steps.length?`<ol class="coach-task-steps">${steps.map(step=>`<li><span class="coach-task-check" aria-hidden="true">${step.status==='complete'?'✓':'·'}</span><div><strong>${coachEscape(step.label)}</strong>${step.detail?`<p>${coachEscape(step.detail)}</p>`:''}</div></li>`).join('')}</ol>`:''}<div class="coach-coverage" aria-label="本次实际查询范围"><div><strong>${coachCount(coverage.queries)}</strong><span>数据查询</span></div><div><strong>${coachArray(coverage.resources).length}</strong><span>数据类型</span></div><div><strong>${coachArray(coverage.match_ids).length}</strong><span>深入对局</span></div><div><strong>${coachCount(coverage.rounds)}</strong><span>指定回合</span></div></div>${coachErrorCount(coverage.tool_errors)?`<p class="coach-query-note">${coachErrorCount(coverage.tool_errors)} 次查询未取得数据，建议范围以结果中的数据引用为准。</p>`:''}${actions.length?`<div class="coach-actions"><div class="coach-section-title"><h3>下一步行动</h3><span>由你选择执行</span></div><div class="coach-action-grid">${actions.map(action=>`<button type="button" class="coach-action" data-coach-action="${coachEscape(action.id)}"><span class="coach-action-icon" aria-hidden="true">${action.kind==='request_render'?'▷':action.kind==='open_sync'?'↻':'↗'}</span><span><strong>${coachEscape(action.label)}</strong><small>${coachEscape(action.reason)}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div></div>`:''}</section>`;
}

export function coachResultHtml(input,{compact=false}={}) {
  const result=coachHistoryResult(input);if(!result)return '';
  const analysis=result?.analysis;if(!analysis)return '';
  const evidence=new Map(coachArray(result.evidence).map(value=>[value.id,value]));
  const chips=refs=>`<div class="coach-evidence">${coachArray(refs).map(id=>{const value=evidence.get(id);return value?`<button type="button" class="coach-evidence-chip" data-coach-evidence="${coachEscape(id)}"><span aria-hidden="true">↗</span> ${coachEscape(value.round_number?`R${value.round_number} · ${coachResourceNames[value.resource]||value.resource}`:coachResourceNames[value.resource]||value.resource)}</button>`:'';}).join('')}</div>`;
  const priorities={high:'优先改进',medium:'下一步',low:'细节优化'},findings=coachArray(analysis.findings),training=coachArray(analysis.training),limitations=coachArray(analysis.limitations);
  return `<article class="coach-report"><div class="coach-report-heading"><div><span class="coach-eyebrow">EVIDENCE & RECOMMENDATIONS</span><h2>${coachEscape(analysis.headline)}</h2></div><span class="coach-model">${coachEscape(result.model||'DeepSeek Flash')}</span></div><p class="coach-summary">${coachEscape(analysis.summary)}</p><div class="coach-findings">${findings.map((finding,index)=>`<section class="coach-finding"><div class="coach-finding-top"><span class="coach-step">${String(index+1).padStart(2,'0')}</span><span class="coach-priority ${Object.hasOwn(priorities,finding.priority)?finding.priority:''}">${Object.hasOwn(priorities,finding.priority)?priorities[finding.priority]:''}</span></div><h3>${coachEscape(finding.title)}</h3><p>${coachEscape(finding.assessment)}</p>${chips(finding.evidence_refs)}</section>`).join('')}</div>${training.length?`<section class="coach-training"><div class="coach-section-title"><h3>训练计划</h3><span>${training.reduce((sum,item)=>sum+coachCount(item.minutes),0)} 分钟</span></div>${training.map((item,index)=>`<div class="coach-drill"><div class="coach-drill-number">${index+1}</div><div><div class="coach-drill-title"><h4>${coachEscape(item.skill)}</h4><span>${coachCount(item.minutes)} min</span></div><p>${coachEscape(item.exercise)}</p><div class="coach-target"><span>复测目标</span>${coachEscape(item.target)}</div>${chips(item.evidence_refs)}</div></div>`).join('')}</section>`:''}${limitations.length?`<aside class="coach-limitations"><strong>本次数据范围</strong><ul>${limitations.map(item=>`<li>${coachEscape(item)}</li>`).join('')}</ul></aside>`:''}<div class="coach-report-footer"><span>${coachTime(result.generated_at)}</span><span>${coachCount(result.usage?.tool_calls)} 次数据查询</span></div></article>${compact?'':coachAgentHtml(result)}`;
}

// Store only a bounded task report and its query references, never fetched evidence payloads.
const rawHistoryDatasets=['owner_rounds','player_rounds','owner_events','player_events','replay_frames','replay_kills','replay_shots','replay_damage','replay_impacts','grenades','effects','bomb_events','bomb_carrier_frames','aim_points','aim_camera','aim_target_points'];
const safeRawPath=value=>typeof value==='string'&&value.length<=240&&/^[A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)*$/.test(value)&&value.split('.').every(part=>!['__proto__','prototype','constructor','api_key','authorization','cookie','password','secret','access_token','refresh_token'].includes(part.toLowerCase()));
const safeRawScalar=value=>value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=256;
const safeRawFilters=value=>Array.isArray(value)&&value.length<=12&&value.every(filter=>filter&&typeof filter==='object'&&!Array.isArray(filter)&&Object.keys(filter).length===3&&['field','op','value'].every(key=>Object.hasOwn(filter,key))&&safeRawPath(filter.field)&&['eq','ne','lt','lte','gt','gte','in','exists'].includes(filter.op)&&(filter.op==='exists'?typeof filter.value==='boolean':filter.op==='in'?Array.isArray(filter.value)&&filter.value.length<=32&&filter.value.every(safeRawScalar):safeRawScalar(filter.value)));
function coachHistoryQuery(value) {
  const keys=['resource','match_id','player_id','player_ids','round_number','tick_from','tick_to','offset','limit','section','metric','clip_id','scope','path','raw_dataset','columns','filters','source_revision'];
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(coachResourceNames,value.resource))return null;
  const entries=Object.entries(value);
  if(entries.some(([key,item])=>!keys.includes(key)||item!=null&&(key==='columns'?!Array.isArray(item)||!item.length||item.length>32||new Set(item).size!==item.length||item.some(path=>!safeRawPath(path)):key==='filters'?!safeRawFilters(item):key==='source_revision'?!/^[a-f0-9]{40,64}$/.test(item):key==='raw_dataset'?!rawHistoryDatasets.includes(item):key==='match_id'?!coachMatchId(item):key==='player_id'?!coachPlayerId(item):key==='player_ids'?!Array.isArray(item)||!item.length||item.length>10||item.some(id=>!coachPlayerId(id)):key==='path'?!Array.isArray(item)||item.length>12||item.some(part=>typeof part!=='string'||!/^[A-Za-z0-9_:-]{1,100}$/.test(part)||['__proto__','prototype','constructor','toString','valueOf','hasOwnProperty','api_key','authorization','cookie','password','secret','access_token','refresh_token'].includes(part.toLowerCase())):['round_number','tick_from','tick_to','offset','limit'].includes(key)?coachInteger(item,['round_number','limit'].includes(key)?1:0)===null:typeof item!=='string'||item.length>300)))return null;
  const query=Object.fromEntries(entries);return JSON.stringify(query).length<=4000?query:null;
}
export function coachArchiveReference(value){
  if(typeof value!=='string'||value.length>240)return null;
  const match=/^turn:([a-f0-9-]{36}):g(0|[1-9]\d*):query:([1-9]\d*)$/.exec(value);
  if(!match||!coachUuid(match[1])||!Number.isSafeInteger(Number(match[2]))||!Number.isSafeInteger(Number(match[3])))return null;
  return {reference:value,turn_id:match[1],generation:Number(match[2])};
}
export async function fetchCoachArchivedEvidence({fetchImpl=globalThis.fetch,conversationId,turnId,currentTurnId,reference,source,query}={}){
  const parsed=coachArchiveReference(reference);
  if(!coachUuid(conversationId)||!coachUuid(turnId)||!parsed||parsed.turn_id!==turnId)throw Error('invalid_archived_evidence');
  const params=new URLSearchParams({conversation_id:conversationId,turn_id:turnId,query_ref:reference});
  const response=await fetchImpl('/api/coach?'+params,{method:'GET',credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('archived_evidence_unavailable');const data=await response.json();
  if(!coachRecord(data)||data.status!=='complete'||data.read_only!==true||data.query_ref!==reference||data.session?.id!==conversationId||data.session?.turn_id!==turnId||data.session?.generation!==parsed.generation||data.session?.can_resume!==false||currentTurnId&&data.session?.current_turn_id!==currentTurnId||!coachRecord(data.result)||data.result.query_evidence_ref!==reference||!coachHistoryQuery(data.query))throw Error('archived_evidence_mismatch');
  const queryKey=value=>JSON.stringify(Object.entries(coachHistoryQuery(value)??{}).sort(([a],[b])=>a.localeCompare(b)));
  if(query&&queryKey(data.query)!==queryKey(query))throw Error('archived_evidence_mismatch');
  if(!coachRecord(data.source)||source&&JSON.stringify(coachSource(data.source))!==JSON.stringify(coachSource(source))||data.result.source&&JSON.stringify(coachSource(data.result.source))!==JSON.stringify(coachSource(data.source)))throw Error('archived_evidence_source_mismatch');
  return data;
}
function coachHistoryResult(result,{live=false}={}) {
  if(!result||result.status!=='complete'||!result.analysis||typeof result.analysis!=='object'||Array.isArray(result.analysis)||!Array.isArray(result.evidence))return null;
  const trim=(value,fields)=>Object.fromEntries(fields.filter(field=>value?.[field]!=null).map(field=>[field,coachText(value[field],2400)]));
  const analysis=result.analysis||{},clean={status:'complete',generated_at:coachText(result.generated_at,60),model:coachText(result.model,100),provider:coachText(result.provider,30),usage:{tool_calls:coachCount(result.usage?.tool_calls)},analysis:{headline:coachText(analysis.headline,300),summary:coachText(analysis.summary,3000),findings:coachArray(analysis.findings).filter(coachRecord).slice(0,8).map(item=>({...trim(item,['title','assessment','priority']),evidence_refs:coachArray(item.evidence_refs).slice(0,12).map(ref=>coachText(ref,200))})),training:coachArray(analysis.training).filter(coachRecord).slice(0,8).map(item=>({...trim(item,['skill','exercise','target']),minutes:Math.min(240,coachCount(item.minutes)),evidence_refs:coachArray(item.evidence_refs).slice(0,12).map(ref=>coachText(ref,200))})),limitations:coachArray(analysis.limitations).filter(item=>typeof item==='string').slice(0,8).map(item=>coachText(item,800))},evidence:coachArray(result.evidence).slice(0,40).flatMap(item=>{try{const query=coachHistoryQuery(item?.query);if(!query||typeof item.id!=='string'||!item.id||item.id.length>200||item.resource!==query.resource||item.match_id!=null&&!coachMatchId(item.match_id))return [];return [{...trim(item,['id','resource','match_id']),round_number:coachInteger(item.round_number,1,1000)||undefined,query}];}catch{return [];}})};
  clean.evidence=clean.evidence.map(item=>{const original=coachArray(result.evidence).find(value=>value?.id===item.id),parsed=coachArchiveReference(original?.query_ref)||coachArchiveReference(item.id);return parsed?{...item,query_ref:parsed.reference}:item;});
  if(result.context)clean.context=prepareCoachContext(result.context);
  const refs=new Set(clean.evidence.map(item=>item.id));for(const item of [...clean.analysis.findings,...clean.analysis.training])item.evidence_refs=item.evidence_refs.filter(ref=>refs.has(ref));
  if(result.agent){const agent=result.agent,coverage=agent.coverage||{};clean.agent={...trim(agent,['goal','scope']),steps:coachArray(agent.steps).filter(coachRecord).slice(0,8).map(step=>({...trim(step,['label','detail']),status:step.status==='complete'?'complete':'pending'})),coverage:{queries:coachCount(coverage.queries),resources:coachArray(coverage.resources).slice(0,40).map(item=>coachText(item,100)),match_ids:coachArray(coverage.match_ids).slice(0,100).map(item=>coachText(item,100)),rounds:coachCount(coverage.rounds),tool_errors:coachErrorCount(coverage.tool_errors)},actions:coachActions({...result,evidence:clean.evidence}).map(action=>({...trim(action,['id','kind','label','reason','evidence_ref'])}))};}
  const validSize=JSON.stringify(clean).length<=coachHistoryResultMaxChars;
  if(clean.agent){const visuals=coachLiveVisuals({...result,evidence:clean.evidence});clean.agent.visualizations_omitted=Math.min(2,Math.max(coachCount(result.agent.visualizations_omitted),visuals.length));if(live)clean.agent.visualizations=coachClone(visuals);}
  return validSize?clean:null;
}
export function prepareCoachHistory(values) {
  const history=[],seen=new Set();
  for(const item of coachArray(values).slice(0,50)){
    if(!item||typeof item.id!=='string'||!item.id.length||item.id.length>120||seen.has(item.id)||typeof item.question!=='string'||!item.question.trim()||item.question.length>1600||!coachGoals.some(goal=>goal.mode===item.mode))continue;
    let result;try{result=coachHistoryResult(item.result);}catch{continue;}if(!result)continue;
    seen.add(item.id);history.push({id:item.id,mode:item.mode,question:item.question,created_at:coachText(item.created_at,60),context:item.context?prepareCoachContext(item.context):result.context??null,source:coachSource(item.source||item.context?.source||result.context?.source),conversation:prepareCoachConversation(item.conversation),result});
    if(history.length>=coachHistoryLimit)break;
  }
  while(history.length&&JSON.stringify({version:1,tasks:history}).length>coachHistoryMaxChars)history.pop();
  return history;
}
export function normalizeCoachHistory(raw) {
  if(typeof raw!=='string'||raw.length>coachHistoryMaxChars)return [];
  try{const value=JSON.parse(raw);return value?.version===1?prepareCoachHistory(value.tasks):[];}catch{return [];}
}

const coachRecord=value=>value&&typeof value==='object'&&!Array.isArray(value);
const coachClone=value=>JSON.parse(JSON.stringify(value));
const coachMatchId=value=>typeof value==='string'&&/^[a-f0-9]{24}$/.test(value)?value:null;
const coachPlayerId=value=>typeof value==='string'&&/^\d{17}$/.test(value)?value:null;
const coachInteger=(value,min=0,max=2147483647)=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max?value:null;
const coachSource=value=>({source_revision:coachText(value?.source_revision,120),generated_at:coachText(value?.generated_at,60),content_sha256:coachText(value?.content_sha256,80)});
const coachHasSource=value=>['source_revision','generated_at','content_sha256'].some(key=>Boolean(value?.[key]));
const coachSourceChanged=(before,after)=>['source_revision','generated_at','content_sha256'].some(key=>before?.[key]&&after?.[key]&&before[key]!==after[key]);
const coachViews=['overview','matches','players','mechanics','replay','sources','coach'];
const coachViewNames={overview:'表现总览',matches:'对局档案',players:'玩家档案',mechanics:'瞄准实验室',replay:'战术回放',sources:'数据中心',coach:'教练工作台'};
const coachId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_ .-]{1,160}$/.test(value)?value:null;

/** Bounded request metadata only; full private data shards never enter this session. */
export function prepareCoachContext(value) {
  const input=coachRecord(value)?value:{},filters=input.filters||{},aim=input.aim||{},replay=input.replay||{},players=input.players||{};
  const context={view:coachViews.includes(input.view)?input.view:null,section:coachText(input.section,80)||null,component:coachText(input.component,120)||null,filters:{map:coachText(filters.map,80)||'all',side:coachText(filters.side,20)||'all',since:coachText(filters.since,40)||null},match_id:coachMatchId(input.match_id||aim.match_id),round_number:coachInteger(input.round_number??aim.round_number,1,1000),player_id:coachPlayerId(input.player_id),clip_id:coachId(input.clip_id||aim.clip_id),source:coachSource(input.source)};
  if(['all_matches','current_selection'].includes(input.data_scope))context.data_scope=input.data_scope;
  if(coachRecord(input.aim))context.aim={match_id:coachMatchId(aim.match_id),round_number:coachInteger(aim.round_number,1,1000),clip_id:coachId(aim.clip_id),tick:coachInteger(aim.tick),reference_player_id:coachPlayerId(aim.reference_player_id),reference_manual:aim.reference_manual===true,display:coachText(aim.display,30)};
  if(coachRecord(input.replay))context.replay={tick:coachInteger(replay.tick),shot_id:coachId(replay.shot_id),kill_id:coachId(replay.kill_id),effect_id:coachId(replay.effect_id)};
  if(coachRecord(input.players))context.players={tab:coachText(players.tab,40),compare_ids:coachArray(players.compare_ids).map(coachPlayerId).filter(Boolean).sort().slice(0,4)};
  return context;
}
export function coachContextKey(value,{includeView=true,includeSource=false}={}) {
  const context=prepareCoachContext(value);
  if(context.data_scope==='all_matches')return JSON.stringify({data_scope:'all_matches',...(includeSource?{source:context.source}:{})});
  if(!includeView){delete context.view;delete context.section;}
  if(!includeSource)delete context.source;
  // Playback progress changes do not create a different analytical scope.
  if(context.aim)delete context.aim.tick;if(context.replay)delete context.replay.tick;
  return JSON.stringify(context);
}
export function coachContextStatus(saved,current) {
  if(!saved)return {unknown:true,sourceStale:false,contextChanged:true};
  const before=prepareCoachContext(saved),after=prepareCoachContext(current),old=before.source,now=after.source;
  if(before.data_scope==='all_matches'&&after.data_scope!=='current_selection')after.data_scope='all_matches';
  if(before.data_scope==='current_selection'&&after.data_scope==null)after.data_scope='current_selection';
  const sourceStale=coachSourceChanged(old,now);
  return {unknown:false,sourceStale,contextChanged:coachContextKey(before)!==coachContextKey(after)};
}
function coachContextLabel(value) {
  const context=prepareCoachContext(value),parts=[];
  if(context.data_scope==='all_matches')parts.push('全部已同步比赛');else if(context.data_scope==='current_selection')parts.push('当前筛选范围');
  if(context.component)parts.push(context.component);else if(context.view&&context.view!=='coach')parts.push(coachViewNames[context.view]);
  if(context.match_id)parts.push(`${context.data_scope==='all_matches'?'当前焦点：':''}对局 ${context.match_id.slice(0,6)}`);if(context.round_number)parts.push(`R${context.round_number}`);if(context.player_id)parts.push(`玩家 ${context.player_id.slice(-6)}`);if(context.clip_id)parts.push(`片段 ${context.clip_id}`);
  if(context.data_scope!=='all_matches'){if(context.filters.map!=='all')parts.push(context.filters.map.replace(/^de_/,''));if(context.filters.side!=='all')parts.push(context.filters.side);if(context.filters.since)parts.push(`${context.filters.since} 起`);}
  return parts.join(' · ')||'全部已同步对局';
}
function coachSourceLabel(value) {const source=coachSource(value);return source.source_revision?`数据版本 ${source.source_revision.slice(0,12)}`:source.generated_at?`数据生成于 ${coachTime(source.generated_at)}`:'未记录数据版本';}

const coachUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():null;
export function prepareCoachActivity(values,turnId){
  const entries=[];if(!coachUuid(turnId))return entries;
  const allowed=['id','at','kind','phase','message','name','call_id','attempt','status','resource','query','summary','evidence_refs'];
  for(const value of coachArray(values).slice(-160)){
    if(!coachRecord(value)||Object.keys(value).some(key=>!allowed.includes(key))||typeof value.id!=='string'||!value.id.startsWith(turnId+':activity:')||!/^[1-9]\d{0,11}$/.test(value.id.slice(turnId.length+10))||typeof value.at!=='string'||value.at.length>40||!Number.isFinite(Date.parse(value.at))||!['commentary','tool','phase','plan'].includes(value.kind))continue;
    const entry={id:value.id,at:coachText(value.at,40),kind:value.kind};
    if(value.phase!=null){if(!['plan','finding','revision','reading','planning','presenting','repairing','validating','generating'].includes(value.phase))continue;entry.phase=value.phase;}
    if(value.message!=null){if(typeof value.message!=='string'||!value.message.trim()||value.message.length>800)continue;entry.message=value.message;}
    if(value.name!=null){if(typeof value.name!=='string'||!/^[a-z][a-z0-9_]{0,127}$/.test(value.name))continue;entry.name=value.name;}
    if(value.call_id!=null){if(typeof value.call_id!=='string'||!/^[A-Za-z0-9_:-]{1,200}$/.test(value.call_id))continue;entry.call_id=value.call_id;}
    if(value.attempt!=null){if(!Number.isSafeInteger(value.attempt)||value.attempt<0||value.attempt>1e9)continue;entry.attempt=value.attempt;}
    if(value.status!=null){if(!['started','completed','failed'].includes(value.status))continue;entry.status=value.status;}
    if(value.resource!=null){if(!Object.hasOwn(coachResourceNames,value.resource))continue;entry.resource=value.resource;}
    if(value.query!=null){const query=coachHistoryQuery(value.query);if(!query)continue;entry.query=query;}
    if(value.summary!=null){if(!coachRecord(value.summary)||Object.keys(value.summary).some(key=>!['rows','available','state','next_offset'].includes(key)))continue;const summary={};let valid=true;for(const [key,item]of Object.entries(value.summary)){if(key==='available'?typeof item!=='boolean':key==='state'?typeof item!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(item):key==='next_offset'&&item===null?false:!Number.isSafeInteger(item)||item<0||item>1e9){valid=false;break;}summary[key]=item;}if(!valid)continue;entry.summary=summary;}
    if(value.evidence_refs!=null){if(!Array.isArray(value.evidence_refs)||value.evidence_refs.length>8||value.evidence_refs.some(ref=>typeof ref!=='string'||!ref||ref.length>240))continue;entry.evidence_refs=[...new Set(value.evidence_refs)];}
    if(entry.kind==='commentary'&&(!entry.message||!['plan','finding','revision'].includes(entry.phase)||entry.phase==='finding'&&!entry.evidence_refs?.length))continue;
    if(entry.kind==='tool'&&(!entry.name||!entry.call_id||!entry.status||entry.attempt==null))continue;
    entries.push(entry);
  }return entries;
}
export function mergeCoachActivity(previous,incoming,turnId){
  const entries=new Map();for(const item of [...prepareCoachActivity(previous,turnId),...prepareCoachActivity(incoming,turnId)])if(!entries.has(item.id))entries.set(item.id,item);
  return [...entries.values()].sort((a,b)=>Number(a.id.slice(a.id.lastIndexOf(':')+1))-Number(b.id.slice(b.id.lastIndexOf(':')+1))).slice(-160);
}
export function prepareCoachStageArtifact(value,expectedSource,turnId=null){
  if(!coachRecord(value)||Object.keys(value).some(key=>!['source','visualizations','evidence'].includes(key))||!coachRecord(value.source)||JSON.stringify(coachStreamSource(value.source))!==JSON.stringify(coachStreamSource(expectedSource)))return null;
  const visuals=coachArray(value.visualizations);if(!visuals.length||visuals.length>2||!visuals.every(validateBoundAgentVisualization))return null;
  const result=coachHistoryResult({status:'complete',analysis:{headline:'阶段结果'},agent:{visualizations:visuals},evidence:value.evidence},{live:true});
  if(!result||result.agent?.visualizations?.length!==visuals.length)return null;
  if(turnId&&visuals.some(visual=>visual.provenance.some(proof=>!proof.query_ref.startsWith('turn:'+turnId+':g'))))return null;
  const source=coachStreamSource(value.source);for(const visual of visuals)for(const data of Object.values(visual.data))if(!data?.source||['source_revision','generated_at'].some(key=>source[key]!=null&&data.source[key]!==source[key]))return null;
  return {source,visualizations:result.agent.visualizations,evidence:result.evidence};
}
const coachToolNames={manage_task_plan:'调整任务计划',report_progress:'分析说明',present_coach_analysis:'提交分析结果',validate_visualization:'核验交互图解',list_statistics_fields:'统计字段目录',analyze_statistics:'本地统计计算',analyze_statistics_batch:'批量统计计算',read_statistics_bulk:'批量加载统计',read_query_archive:'读取已存证据',list_query_archive:'已存证据目录',read_data_coverage:'核对数据覆盖',read_data_batch:'批量读取明细'};
export function coachActivityRows(values,turnId){
  const rows=[],tools=new Map();for(const entry of prepareCoachActivity(values,turnId)){
    if(entry.kind==='tool'){if(entry.name==='report_progress')continue;const key=`tool:${entry.attempt}:${entry.call_id}`,index=tools.get(key);if(index!=null)rows[index]={...rows[index],...entry,key};else{tools.set(key,rows.length);rows.push({...entry,key});}}
    else rows.push({...entry,key:entry.id});
  }return rows;
}
function coachActivityItemHtml(entry){
  const time=new Date(entry.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}),refs=coachArray(entry.evidence_refs).map((ref,index)=>`<button type="button" class="coach-activity-ref" data-coach-activity-ref="${coachEscape(ref)}">证据 ${index+1}</button>`).join('');
  if(entry.kind!=='tool'){const label=entry.kind==='plan'?'计划调整':entry.kind==='phase'?'执行阶段':entry.phase==='finding'?'阶段发现':entry.phase==='revision'?'调整说明':'分析说明';return `<div class="coach-activity-copy"><span class="coach-activity-meta">${label}<time>${time}</time></span><p>${coachEscape(entry.message||coachStreamPhases[entry.phase]||'更新任务计划')}</p>${refs?`<div class="coach-activity-refs">${refs}</div>`:''}</div>`;}
  const query=entry.query||{},summary=entry.summary||{},scope=[entry.message||'',query.match_id?`对局 ${query.match_id.slice(0,6)}`:'',query.round_number?`R${query.round_number}`:'',query.clip_id?`片段 ${query.clip_id}`:'',query.player_id?`玩家 ${query.player_id.slice(-6)}`:'',query.offset!=null?`起点 ${query.offset}`:'',query.limit!=null?`本页最多 ${query.limit} 条`:'',query.tick_from!=null||query.tick_to!=null?`Tick ${query.tick_from??'起点'}–${query.tick_to??'终点'}`:'',query.section||query.metric||''].filter(Boolean).join(' · '),outcome=[summary.rows!=null?`${summary.rows} 条记录`:'',summary.available===false?'数据暂不可用':summary.available===true?'数据可用':'',summary.state?({rendered:'已渲染',not_rendered:'尚未渲染',available:'可读取'}[summary.state]||summary.state):'',summary.next_offset!=null?`可从 ${summary.next_offset} 继续读取`:''].filter(Boolean).join(' · '),name=coachToolNames[entry.name]||(entry.resource?coachResourceNames[entry.resource]:null)||entry.name,status={started:'执行中',completed:'已返回',failed:'未取得结果'}[entry.status];
  return `<details data-coach-activity-detail><summary><span class="coach-activity-tool-icon" aria-hidden="true">${entry.status==='started'?'◉':entry.status==='failed'?'!':'✓'}</span><strong>${coachEscape(name)}</strong><span>${status}</span><time>${time}</time></summary><div class="coach-activity-tool-detail">${scope?`<p>${coachEscape(scope)}</p>`:''}${outcome?`<p>${coachEscape(outcome)}</p>`:''}${entry.message?`<p>${coachEscape(entry.message)}</p>`:''}${refs?`<div class="coach-activity-refs">${refs}</div>`:''}</div></details>`;
}
export function prepareCoachConversation(value){
  if(!coachUuid(value?.id)||!coachUuid(value?.turn_id))return null;
  return {id:coachUuid(value.id),turn_id:coachUuid(value.turn_id),revision:coachCount(value.revision),source_changed:value.source_changed===true,can_resume:value.can_resume===true};
}
export function prepareCoachCoverage(value){
  if(!coachRecord(value)||!['all_matches','selected'].includes(value.scope)||value.granularity!=='round_statistics')return null;
  const counts={};for(const key of ['matches_total','matches_discovered','detail_matches','queries_completed','pages_completed']){if(!Number.isSafeInteger(value[key])||value[key]<0||value[key]>1e9)return null;counts[key]=value[key];}
  const pending=coachArray(value.pending).slice(0,60).flatMap(item=>{if(!coachRecord(item)||!Object.hasOwn(coachResourceNames,item.resource)||item.match_id!=null&&!coachMatchId(item.match_id)||item.offset!=null&&(!Number.isSafeInteger(item.offset)||item.offset<0))return [];return [{resource:item.resource,...(item.match_id?{match_id:item.match_id}:{}),...(item.offset!=null?{offset:item.offset}:{}),reason:typeof item.reason==='string'&&/^[a-z_]{1,80}$/.test(item.reason)?item.reason:'pending'}];});
  const matchIds=items=>[...new Set(coachArray(items).map(coachMatchId).filter(Boolean))].slice(0,1000);
  return {scope:value.scope,granularity:'round_statistics',...counts,match_ids_discovered:matchIds(value.match_ids_discovered),match_ids_detailed:matchIds(value.match_ids_detailed),pending,pending_total:coachArray(value.pending).length,complete:value.complete===true,note:typeof value.note==='string'?coachText(value.note,600):''};
}
export function prepareCoachRecovery(value){
  if(!coachRecord(value)||typeof value.progress_signature!=='string'||!value.progress_signature||value.progress_signature.length>512||typeof value.reason!=='string'||!/^[a-z_]{1,80}$/.test(value.reason))return null;
  const eligible=['execution_window_complete','execution_window_timeout','provider_timeout','provider_unreachable','provider_stream_interrupted','analysis_incomplete','provider_response_invalid','analysis_repair_pending','visual_repair_pending','format_repair_pending'];
  return {can_auto_continue:value.can_auto_continue===true&&!value.stalled&&eligible.includes(value.reason),progress_signature:value.progress_signature,reason:value.reason,stalled:value.stalled===true,retry_after_ms:Number.isSafeInteger(value.retry_after_ms)&&value.retry_after_ms>=0?Math.min(value.retry_after_ms,30000):0};
}
function coachCoverageHtml(coverage,status){
  if(!coverage)return '';
  const reason={pending:'等待读取',not_read:'等待读取',not_yet_read:'等待读取',query_unavailable:'暂不可用',statistics_unavailable:'统计暂不可用',match_detail_unavailable:'详情暂不可用',native_clip_not_found:'尚无匹配原生片段'};
  return `<section class="coach-data-coverage" aria-label="本轮数据覆盖"><div class="coach-section-title"><h4>${coverage.scope==='all_matches'?'全部比赛的数据覆盖':'当前范围的数据覆盖'}</h4><span>${coverage.complete?'逐回合统计已读完':status==='running'?'正在逐步读取':status==='awaiting_continuation'?'后续读取等待继续':'已记录读取范围'}</span></div><div class="coach-data-coverage-counts"><span>比赛目录 <strong>${coverage.matches_discovered}/${coverage.matches_total}</strong></span><span>逐回合统计 <strong>${coverage.detail_matches}/${coverage.matches_total}</strong></span><span>已读数据页 <strong>${coverage.pages_completed}</strong></span></div><p>逐回合统计覆盖不代表所有回放帧或原始事件已读完；可在同一会话继续查询。</p>${coverage.pending_total?`<details data-coach-expand="coverage"><summary>后续数据 · ${coverage.pending_total} 项</summary><ul>${coverage.pending.slice(0,12).map(item=>`<li>${coachEscape(coachResourceNames[item.resource])}${item.match_id?` · 对局 ${coachEscape(item.match_id.slice(0,6))}`:''}${item.offset!=null?` · 从 ${item.offset} 继续`:''} · ${reason[item.reason]||'尚未完成读取'}</li>`).join('')}</ul></details>`:''}</section>`;
}
export function prepareCoachWorkflow(value,task){
  if(!coachRecord(value)||value.version!==1||value.state!==task?.status||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision!==(task.plan_revision??0)||!Number.isSafeInteger(value.generation)||value.generation<0||value.generation!==(task.checkpoint?.generation??0)||!coachRecord(value.operations))return null;
  const descriptors=Object.getOwnPropertyDescriptors(value.operations),fields=['running','completed','failed','interrupted','retention'];
  if(Reflect.ownKeys(descriptors).some(key=>!fields.includes(key)||!Object.hasOwn(descriptors[key],'value'))||fields.some(key=>!Object.hasOwn(descriptors,key)))return null;
  const operations={};let total=0;
  for(const key of fields.slice(0,4)){const count=descriptors[key].value;if(!Number.isSafeInteger(count)||count<0||count>160)return null;operations[key]=count;total+=count;}
  if(total>160||task.status!=='running'&&operations.running!==0||!['recent','complete'].includes(descriptors.retention.value))return null;
  operations.retention=descriptors.retention.value;
  return {version:1,revision:value.revision,generation:value.generation,state:value.state,operations};
}
export function prepareCoachTaskState(value){
  if(!coachRecord(value)||!['running','awaiting_continuation','completed','failed'].includes(value.status))return null;
  const statuses=['pending','ready','active','complete','blocked','deferred','cancelled'],ids=input=>coachArray(input).filter(item=>typeof item==='string').slice(0,30).map(item=>coachText(item,120)),overview=value.plan_overview,progressKnown=Boolean(value.progress_known!==false&&coachRecord(value.progress));
  return {id:coachText(value.id,120),status:value.status,goal:coachText(value.goal,1600),mode:coachGoals.some(goal=>goal.mode===value.mode)?value.mode:'diagnose',context:value.context?prepareCoachContext(value.context):null,source:coachSource(value.source),activity:prepareCoachActivity(value.activity,value.id),provider_trace:prepareProviderTrace(value.provider_trace),activity_truncated:value.activity_truncated===true,stage_artifact:prepareCoachStageArtifact(value.stage_artifact,value.source,value.id),plan:coachArray(value.plan).filter(coachRecord).slice(0,30).map(step=>({id:coachText(step.id,120),label:coachText(step.label,300),detail:coachText(step.detail,1000),status:statuses.includes(step.status)?step.status:'pending',operation:['read_data','validate_visual','present'].includes(step.operation)?step.operation:'read_data',resources:coachArray(step.resources).filter(resource=>Object.hasOwn(coachResourceNames,resource)).slice(0,40),depends_on:ids(step.depends_on),blocked_by:ids(step.blocked_by),scope:coachRecord(step.scope)?coachHistoryQuery({...step.scope,resource:coachArray(step.resources).find(resource=>Object.hasOwn(coachResourceNames,resource))||'inspect'}):null,readiness:['ready','blocked','complete','deferred','cancelled'].includes(step.readiness)?step.readiness:null})),plan_revision:coachCount(value.plan_revision),plan_revisions:coachArray(value.plan_revisions).filter(item=>coachRecord(item)&&['set','append','revise','reorder','activate','defer','cancel','transaction','source_changed'].includes(item.action)).slice(-16).map(item=>({revision:coachCount(item.revision),action:item.action,step_ids:ids(item.step_ids),at:coachText(item.at,60)})),plan_overview:coachRecord(overview)?{total:coachCount(overview.total),completed:coachCount(overview.completed),ready_step_ids:ids(overview.ready_step_ids),blocked_step_ids:ids(overview.blocked_step_ids),deferred_step_ids:ids(overview.deferred_step_ids),cancelled_step_ids:ids(overview.cancelled_step_ids),partial:overview.partial===true}:null,coverage:prepareCoachCoverage(value.coverage),workflow:prepareCoachWorkflow(value.workflow,value),recovery:prepareCoachRecovery(value.recovery),pause_reason:coachText(value.pause_reason,80),progress_known:progressKnown,progress:{model_calls:coachCount(value.progress?.model_calls),reads:coachCount(value.progress?.reads)},checkpoint:{sequence:coachCount(value.checkpoint?.sequence),generation:coachCount(value.checkpoint?.generation)},events:coachArray(value.events).filter(event=>coachRecord(event)&&Object.hasOwn(coachResourceNames,event.resource)&&['complete','failed','error'].includes(event.status)).slice(-12).map(event=>({resource:event.resource,status:event.status==='complete'?'complete':'failed',label:coachText(event.label,200),detail:coachText(event.detail,500)}))};
}
export function prepareSavedCoachConversations(value){
  const seen=new Set(),conversations=[];
  for(const item of coachArray(value?.conversations).slice(0,20)){
    const session=prepareCoachConversation(item?.session),task=prepareCoachTaskState(item?.task);if(!session||!task||seen.has(session.id))continue;seen.add(session.id);
    conversations.push({session,task:{id:task.id,status:task.status,goal:task.goal,mode:task.mode,context:task.context,source:task.source},updated_at:coachText(item.updated_at,60)});
  }
  return {conversations,cursor:typeof value?.cursor==='string'&&value.cursor.length<=2000?value.cursor:null,truncated:value?.truncated===true};
}
export function coachTaskStateHtml(state){
  const task=prepareCoachTaskState(state?.task),conversation=prepareCoachConversation(state?.conversation);if(!task||!conversation)return '';
  const labels={running:'正在执行',awaiting_continuation:state.busy&&state.autoContinuing?'正在接续任务':'等待继续',completed:task.plan_overview?.partial?'本轮部分完成':'本轮已完成',failed:'本轮执行中断'},marks={pending:'○',ready:'○',active:'◉',complete:'✓',blocked:'!',deferred:'Ⅱ',cancelled:'×'},stepLabels={pending:'待执行',ready:'可执行',active:'进行中',complete:'已完成',blocked:'等待依赖',deferred:'已推迟',cancelled:'已取消'},stepName=id=>task.plan.find(step=>step.id===id)?.label||id;
  const resume=conversation.can_resume&&['running','awaiting_continuation','failed'].includes(task.status),failedResume=resume&&task.status==='failed',readResult=task.status==='completed'&&(!state.result||state.activeTaskId!==`turn:${conversation.turn_id}`),disabled=state.busy||state.restoring;
  const scopeLabel=scope=>[scope.match_id?`对局 ${scope.match_id.slice(0,6)}`:'',scope.round_number?`R${scope.round_number}`:'',scope.clip_id?`片段 ${scope.clip_id}`:'',scope.player_id?`玩家 ${scope.player_id.slice(-6)}`:'',scope.tick_from!=null||scope.tick_to!=null?`Tick ${scope.tick_from??'起点'}–${scope.tick_to??'终点'}`:'',scope.section||scope.metric||''].filter(Boolean).join(' · ')||coachResourceNames[scope.resource]||'已指定的数据范围';
  const plan=renderAgentWorkflow(task);
  const overview=task.plan_overview?`<p class="coach-plan-overview">计划 ${task.plan_revision} · 已完成 ${task.plan_overview.completed}/${task.plan_overview.total} · 可执行 ${task.plan_overview.ready_step_ids.length}${task.plan_overview.blocked_step_ids.length?` · 等待依赖 ${task.plan_overview.blocked_step_ids.length}`:''}${task.plan_overview.partial?' · 未完成项已列明':''}</p>`:task.plan_revision?`<p class="coach-plan-overview">计划 ${task.plan_revision}</p>`:'';
  const changeLabels={set:'建立计划',append:'增加步骤',revise:'调整步骤',reorder:'调整顺序',activate:'开始步骤',defer:'推迟步骤',cancel:'取消步骤',transaction:'批量调整计划',source_changed:'按新数据重建计划'};
  const changes=task.plan_revisions.length?`<details class="coach-tool-record" data-coach-expand="plan-changes"><summary>最近计划调整</summary><ol>${task.plan_revisions.map(item=>`<li>计划 ${item.revision} · ${changeLabels[item.action]}${item.step_ids.length?`<p>${item.step_ids.map(id=>coachEscape(stepName(id))).join('、')}</p>`:''}</li>`).join('')}</ol></details>`:'';
  return `<section class="coach-runtime" aria-label="会话任务状态"><div class="coach-section-title"><h3>${labels[task.status]}</h3><span>同一会话 · 全站共享</span></div>${task.goal?`<p class="coach-runtime-goal">${coachEscape(task.goal)}</p>`:''}${conversation.source_changed?'<p class="coach-runtime-note">数据版本已变化，当前任务会重新核对证据；此前结论保留原版本。</p>':''}${coachCoverageHtml(task.coverage,task.status)}${task.recovery?.stalled?'<p class="coach-runtime-note">当前步骤没有新增的可验证进展，已有数据和结果已保存，等待继续。</p>':''}${overview}${plan}${changes}${task.progress_known?`<div class="coach-runtime-counts"><span>已调用模型 <strong>${task.progress.model_calls}</strong> 次</span><span>已执行数据查询 <strong>${task.progress.reads}</strong> 次</span></div>`:''}${task.events.length?`<details class="coach-tool-record" data-coach-expand="tools"><summary>实际工具记录</summary><ol>${task.events.map(event=>`<li><strong>${coachEscape(coachResourceNames[event.resource])}</strong><span>${event.status==='complete'?'已取得结果':'未取得结果'}</span>${event.detail?`<p>${coachEscape(event.detail)}</p>`:''}</li>`).join('')}</ol></details>`:''}${resume?`<p class="coach-runtime-note">${failedResume?'模型服务中断前的进度已保存。修复服务配置或请求问题后，可沿用本轮目标和范围继续。':'进度已保存。点击继续会沿用本轮目标和已读取的证据。'}</p>`:''}<div class="coach-runtime-actions">${resume?`<button type="button" class="button button-primary" data-coach-resume ${disabled?'disabled':''}>${failedResume?'修复后继续':'继续执行'} ↗</button>`:''}${readResult?`<button type="button" class="button button-primary" data-coach-read-result ${disabled?'disabled':''}>读取已完成结果</button>`:''}<button type="button" class="button button-quiet" data-coach-refresh-task ${disabled?'disabled':''}>读取任务状态</button><button type="button" class="button button-quiet" data-coach-new ${state.busy?'disabled':''}>新任务</button></div></section>`;
}

export function prepareCoachTurnHistory(value,conversation){
  if(!conversation||value?.session?.id!==conversation.id||value.session.current_turn_id!==conversation.turn_id||!Array.isArray(value.history?.items))return null;
  const items=[],seen=new Set();
  for(const item of value.history.items.slice(0,9)){
    const turn_id=coachUuid(item?.turn_id);if(!turn_id||seen.has(turn_id)||!['running','awaiting_continuation','completed','failed'].includes(item.status))continue;
    seen.add(turn_id);items.push({turn_id,question:coachText(item.question,1600),status:item.status,source:coachSource(item.source),context:item.context?prepareCoachContext(item.context):null,mode:coachGoals.some(goal=>goal.mode===item.mode)?item.mode:'diagnose',summary:coachText(item.summary,300),stale:item.stale===true,historical:turn_id!==conversation.turn_id,read_only:true});
  }
  const pagination=value.history.pagination,cursor=typeof pagination?.cursor==='string'&&pagination.cursor.length<=8192?pagination.cursor:null;
  return {items,cursor,truncated:pagination?.truncated===true};
}
const emptyCoachTurnHistory=()=>({items:[],cursor:null,truncated:false,loading:false,loaded:false,error:''});

/** Share one instance throughout the app. Only explicit message/resume actions run the Agent. */
export function createCoachSession({fetchImpl=globalThis.fetch,storage,onEvidence=()=>{},onAction=null}={}) {
  if(storage===undefined){try{storage=globalThis.window?.sessionStorage;}catch{storage=null;}}
  let destroyed=false,controller=null,execution=null,executionSerial=0,requestNumber=0,readiness,readinessController=null,readinessNumber=0,readNumber=0,listNumber=0,turnListNumber=0,turnReadNumber=0,streamFrame=null,streamFrameOnlyDraft=true;const listeners=new Set(),visualCache=new Map();let history=[];
  try{history=normalizeCoachHistory(storage?.getItem(coachHistoryKey));}catch{}
  let state={service:null,busy:false,autoContinuing:false,result:null,visualRevision:0,error:'',actionNote:'',history,activeTaskId:'',requestContext:null,source:coachSource(null),request:null,conversation:null,task:null,stageArtifact:null,pendingRequest:null,restoring:false,stream:null,turnHistory:emptyCoachTurnHistory(),historyView:null,savedConversations:{conversations:[],cursor:null,truncated:false,loading:false,loaded:false,error:''}};
  try{const raw=storage?.getItem(coachConversationKey);if(raw&&raw.length<=20000){const saved=JSON.parse(raw),conversation=prepareCoachConversation(saved.conversation);if(saved.version===1&&conversation){state.conversation=conversation;state.task=prepareCoachTaskState(saved.task);state.requestContext=saved.context?prepareCoachContext(saved.context):null;const pending=saved.pendingRequest;if(pending&&typeof pending.question==='string'&&pending.question.length<=1600&&coachGoals.some(goal=>goal.mode===pending.mode)&&pending.conversation?.id===conversation.id&&pending.conversation?.turn_id===conversation.turn_id&&['message','resume'].includes(pending.conversation.action)){state.pendingRequest={question:pending.question,mode:pending.mode,context:prepareCoachContext(pending.context),conversation:{id:conversation.id,turn_id:conversation.turn_id,action:pending.conversation.action,...(pending.conversation.create===true?{create:true}:{})}};}const latest=history.find(item=>item.conversation?.id===conversation.id&&item.conversation?.turn_id===conversation.turn_id);if(latest){state.activeTaskId=latest.id;state.result=coachClone(latest.result);state.requestContext=latest.context;}}}}catch{}
  const snapshot=()=>coachClone(state),notify=(metadata={})=>{if(!destroyed)for(const listener of listeners)listener(snapshot(),metadata);};
  const cancelStreamFrame=()=>{if(streamFrame!==null){if(globalThis.cancelAnimationFrame)globalThis.cancelAnimationFrame(streamFrame);else clearTimeout(streamFrame);streamFrame=null;}streamFrameOnlyDraft=true;};
  function notifyStream(draftOnly=false){if(destroyed)return;streamFrameOnlyDraft=streamFrameOnlyDraft&&draftOnly;if(streamFrame!==null)return;const schedule=globalThis.requestAnimationFrame||((callback)=>setTimeout(callback,0));streamFrame=schedule(()=>{const draftOnly=streamFrameOnlyDraft;streamFrame=null;streamFrameOnlyDraft=true;notify({draftOnly});});}
  function setResult(result){if(JSON.stringify(state.result?.agent?.visualizations??[])!==JSON.stringify(result?.agent?.visualizations??[]))state.visualRevision++;state.result=result;}
  function save(){state.history=prepareCoachHistory(state.history);try{storage?.setItem(coachHistoryKey,JSON.stringify({version:1,tasks:state.history}));}catch{}}
  function saveConversation(){try{if(state.conversation)storage?.setItem(coachConversationKey,JSON.stringify({version:1,conversation:state.conversation,task:state.task?{...state.task,activity:[],provider_trace:[],stage_artifact:null}:null,context:state.requestContext,pendingRequest:state.pendingRequest}));else storage?.removeItem(coachConversationKey);}catch{}}
  function closeHistoryView(){turnReadNumber++;state.historyView=null;}
  function resetTurnHistory(){closeHistoryView();turnListNumber++;state.turnHistory=emptyCoachTurnHistory();}
  function acceptRuntime(data,expected){const conversation=prepareCoachConversation(data.session),task=prepareCoachTaskState(data.task);if(!conversation||!task||conversation.id!==expected.id||expected.turn_id&&conversation.turn_id!==expected.turn_id||state.conversation?.id===conversation.id&&state.conversation?.turn_id===conversation.turn_id&&conversation.revision<state.conversation.revision)return false;if(state.conversation?.id!==conversation.id||state.conversation?.turn_id!==conversation.turn_id)resetTurnHistory();state.conversation=conversation;state.task=task;state.stageArtifact=task.stage_artifact;if(task.context)state.requestContext=prepareCoachContext({...task.context,source:coachHasSource(task.source)?task.source:task.context.source});saveConversation();return true;}
  function hydrateCachedResult(data){
    const raw=data?.result,session=prepareCoachConversation(raw?.session),current=state.conversation;if(!session||!current||session.id!==current.id||session.turn_id!==current.turn_id||data.task?.status!=='completed')return false;
    const expected=data.task.source,actual=raw.source;if(JSON.stringify(coachStreamSource(expected))!==JSON.stringify(coachStreamSource(actual)))return false;
    const result=coachHistoryResult(raw,{live:true});if(!result)return false;result.context=prepareCoachContext({...state.requestContext,...result.context,source:actual||state.requestContext?.source});setResult(result);state.activeTaskId=`turn:${current.turn_id}`;state.requestContext=result.context;state.pendingRequest=null;visualCache.set(state.activeTaskId,coachClone(result.agent?.visualizations??[]));state.history=state.history.filter(item=>item.id!==state.activeTaskId);state.history.unshift({id:state.activeTaskId,mode:state.task?.mode||'diagnose',question:state.task?.goal||'分析任务',created_at:result.generated_at||new Date().toISOString(),context:result.context,source:result.context.source,conversation:current,result});save();saveConversation();return true;
  }
  async function loadTurnHistory({more=false}={}){
    const current=state.conversation;if(destroyed||state.restoring||!current||state.turnHistory.loading)return null;const cursor=more?state.turnHistory.cursor:null;if(more&&!cursor)return null;
    const ownRead=++turnListNumber,id=current.id,turn=current.turn_id;state.turnHistory.loading=true;state.turnHistory.error='';notify();
    try{
      const response=await fetchImpl(`/api/coach?conversation_id=${encodeURIComponent(id)}&history=1&limit=8${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}),data=await response.json();
      if(destroyed||ownRead!==turnListNumber||state.conversation?.id!==id||state.conversation?.turn_id!==turn)return null;if(!response.ok)throw Object.assign(Error(),{code:data.error});
      const page=prepareCoachTurnHistory(data,current);if(!page)throw Error();const previous=more?state.turnHistory.items:[],seen=new Set(previous.map(item=>item.turn_id));state.turnHistory={...page,items:[...previous,...page.items.filter(item=>!seen.has(item.turn_id))].slice(-60),loading:false,loaded:true,error:''};notify();return coachClone(page);
    }catch(cause){if(!destroyed&&ownRead===turnListNumber){state.turnHistory.loading=false;state.turnHistory.error=coachErrorText[cause.code]||'暂时无法读取本会话历史，请读取当前任务状态后重试。';notify();}return null;}
  }
  async function openHistoryTurn(turnId){
    const current=state.conversation,turn=coachUuid(turnId);if(destroyed||state.restoring||!current||!turn)return null;if(turn===current.turn_id){closeHistoryView();notify();return null;}
    const ownRead=++turnReadNumber,id=current.id,currentTurn=current.turn_id;state.historyView={turn_id:turn,loading:true,error:'',result:null,context:null,stale:false};notify();
    try{
      const response=await fetchImpl(`/api/coach?conversation_id=${encodeURIComponent(id)}&turn_id=${encodeURIComponent(turn)}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}),data=await response.json();
      if(destroyed||ownRead!==turnReadNumber||state.conversation?.id!==id||state.conversation?.turn_id!==currentTurn)return null;if(!response.ok)throw Object.assign(Error(),{code:data.error});
      const session=prepareCoachConversation(data.session),task=prepareCoachTaskState(data.task),raw=data.result,resultSession=prepareCoachConversation(raw?.session);
      if(data.historical!==true||data.read_only!==true||!session||session.id!==id||session.turn_id!==turn||data.session.current_turn_id!==currentTurn||!task||task.id!==turn||task.status!=='completed'||!resultSession||resultSession.id!==id||resultSession.turn_id!==turn||raw.task?.id&&raw.task.id!==turn||JSON.stringify(coachStreamSource(task.source))!==JSON.stringify(coachStreamSource(raw.source)))throw Error();
      const result=coachHistoryResult(raw,{live:true});if(!result)throw Error();const context=prepareCoachContext({...task.context,...result.context,source:raw.source});result.context=context;
      state.historyView={turn_id:turn,loading:false,error:'',result,context,stale:session.source_changed||data.stale===true,question:task.goal};notify();return coachClone(result);
    }catch(cause){if(!destroyed&&ownRead===turnReadNumber){state.historyView={turn_id:turn,loading:false,error:coachErrorText[cause.code]||'暂时无法读取该轮已完成结果，请返回当前任务后重试。',result:null,context:null,stale:false};notify();}return null;}
  }
  async function refreshTask({quiet=false,expectedTurn=null,signal}={}){
    const id=state.conversation?.id;if(destroyed||state.restoring||!id)return null;const ownRead=++readNumber,ownRequest=requestNumber;
    try{const response=await fetchImpl(`/api/coach?conversation_id=${encodeURIComponent(id)}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},...(signal?{signal}:{})}),data=await response.json();if(destroyed||signal?.aborted||ownRead!==readNumber||ownRequest!==requestNumber||state.conversation?.id!==id)return null;if(!response.ok)throw Object.assign(Error(),{code:data.error});if(!acceptRuntime(data,{id,turn_id:expectedTurn||(state.busy?state.request?.turn_id:null)}))return null;if(['completed','awaiting_continuation','failed'].includes(state.task.status))state.pendingRequest=null;const cached=hydrateCachedResult(data);saveConversation();if(!quiet)state.error='';notify();const result=coachClone(data);if(!cached)delete result.result;return result;
    }catch(cause){if(!quiet&&!destroyed&&ownRead===readNumber&&ownRequest===requestNumber){state.error=coachErrorText[cause.code]||'暂时无法读取任务状态，请稍后重试。';notify();}return null;}
  }
  async function loadConversations({more=false}={}){
    if(destroyed||state.savedConversations.loading)return null;const cursor=more?state.savedConversations.cursor:null;if(more&&!cursor)return null;const ownRead=++listNumber;state.savedConversations.loading=true;state.savedConversations.error='';notify();
    try{const response=await fetchImpl(`/api/coach?conversations=recent&limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}),data=await response.json();if(destroyed||ownRead!==listNumber)return null;if(!response.ok)throw Object.assign(Error(),{code:data.error});if(!Array.isArray(data.conversations))throw Error();const page=prepareSavedCoachConversations(data),previous=more?state.savedConversations.conversations:[],seen=new Set(previous.map(item=>item.session.id));state.savedConversations={...page,conversations:[...previous,...page.conversations.filter(item=>!seen.has(item.session.id))].slice(-60),loading:false,loaded:true,error:''};notify();return coachClone(page);
    }catch(cause){if(!destroyed&&ownRead===listNumber){state.savedConversations.loading=false;state.savedConversations.error=coachErrorText[cause.code]||'暂时无法读取已保存会话，请稍后重试。';notify();}return null;}
  }
  async function restoreConversation(id){
    if(destroyed||state.busy||!state.savedConversations.conversations.some(item=>item.session.id===id))return null;const active=++requestNumber,ownRead=++readNumber;resetTurnHistory();cancelStreamFrame();state.stream=null;state.restoring=true;state.error='';notify();
    try{const response=await fetchImpl(`/api/coach?conversation_id=${encodeURIComponent(id)}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}),data=await response.json();if(destroyed||active!==requestNumber||ownRead!==readNumber)return null;if(!response.ok)throw Object.assign(Error(),{code:data.error});const conversation=prepareCoachConversation(data.session),task=prepareCoachTaskState(data.task);if(!conversation||!task||conversation.id!==id)throw Object.assign(Error(),{code:'invalid_conversation'});state.result=null;state.activeTaskId='';state.pendingRequest=null;state.actionNote='';acceptRuntime(data,{id});hydrateCachedResult(data);notify();return coachClone(data);
    }catch(cause){if(!destroyed&&active===requestNumber&&ownRead===readNumber)state.error=coachErrorText[cause.code]||'暂时无法恢复该会话，请稍后重试。';return null;}
    finally{if(!destroyed&&active===requestNumber&&ownRead===readNumber){state.restoring=false;notify();if(state.conversation?.id===id)void loadTurnHistory();}}
  }
  async function status(){
    const ownController=new AbortController(),active=++readinessNumber;readinessController=ownController;
    try{const response=await fetchImpl('/api/coach',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:ownController.signal}),data=await response.json();if(destroyed||ownController.signal.aborted||active!==readinessNumber)return;if(!response.ok)throw Object.assign(Error(),{code:data.error});if(!['ready','not_configured'].includes(data.status))throw Error();state.service={status:data.status,provider:coachText(data.provider,30),model:coachText(data.model,100),request_timeout_ms:Number.isSafeInteger(data.execution?.request_timeout_ms)&&data.execution.request_timeout_ms>=150000&&data.execution.request_timeout_ms<=750000?data.execution.request_timeout_ms:750000};if(data.configuration_issue)state.error=coachErrorText[data.configuration_issue]||'请检查模型配置。';}
    catch(cause){if(destroyed||ownController.signal.aborted||active!==readinessNumber)return;state.service={status:'unavailable'};state.error=coachErrorText[cause.code]||'暂时无法连接教练服务。';}
    if(destroyed||ownController.signal.aborted||active!==readinessNumber)return;notify();if(state.conversation)await refreshTask({quiet:true,signal:ownController.signal});if(readinessController===ownController)readinessController=null;
  }
  function awaitReadiness(own){
    if(!state.service&&(!readinessController||readinessController.signal.aborted))readiness=status();
    if(!own)return readiness;
    const pendingController=readinessController;
    return new Promise((resolve,reject)=>{let settled=false;const finish=(callback,value)=>{if(settled)return;settled=true;own.controller.signal.removeEventListener('abort',abort);callback(value);},abort=()=>{pendingController?.abort();finish(reject,Object.assign(Error(),{name:'AbortError'}));};if(own.controller.signal.aborted){abort();return;}own.controller.signal.addEventListener('abort',abort,{once:true});Promise.resolve(readiness).then(value=>finish(resolve,value),error=>finish(reject,error));});
  }
  async function run(options={}){
    if(destroyed||execution||state.busy||state.restoring)return null;
    const own={id:++executionSerial,controller:new AbortController()},seen=new Set();closeHistoryView();execution=own;controller=own.controller;state.busy=true;state.autoContinuing=false;
    const initial=state.task?.recovery?.progress_signature;if(initial&&options.resume)seen.add(initial);
    let next={...options},last=null;
    const wait=milliseconds=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);own.controller.signal.removeEventListener('abort',abort);reject(Object.assign(Error(),{name:'AbortError'}));},timer=setTimeout(()=>{own.controller.signal.removeEventListener('abort',abort);resolve();},milliseconds);if(own.controller.signal.aborted)abort();else own.controller.signal.addEventListener('abort',abort,{once:true});});
    try{
      while(!destroyed&&execution===own&&!own.controller.signal.aborted){
        last=await runWindow({...next,_execution:own});
        if(!last||last.status!=='awaiting_continuation'||options.autoContinue===false||options.readResult||destroyed||execution!==own||own.controller.signal.aborted)break;
        const recovery=state.task?.recovery,session=state.conversation;
        if(!recovery?.can_auto_continue||recovery.stalled||!session?.can_resume){if(recovery?.stalled)state.actionNote='当前步骤没有新增的可验证进展，已保存进度，等待继续。';else if(coachErrorText[recovery?.reason])state.actionNote=coachErrorText[recovery.reason];break;}
        if(seen.has(recovery.progress_signature)){state.actionNote='连续执行未增加新的证据或已验证结果，已保存进度，避免重复同一步骤。';break;}
        seen.add(recovery.progress_signature);state.autoContinuing=true;state.actionNote='';if(state.stream)state.stream.phase='continuing';notify();
        // Yield between owned windows so cancel remains effective before the
        // next paid POST. GET recovery and page rendering never enter this loop.
        await wait(recovery.retry_after_ms);
        if(destroyed||execution!==own||own.controller.signal.aborted)break;
        next={resume:true};
      }
      return own.controller.signal.aborted?null:last;
    }catch(cause){if(!destroyed&&execution===own){state.error=cause.name==='AbortError'?coachErrorText.request_cancelled:'任务已保存，请读取当前进度后继续。';if(state.stream)state.stream.phase='paused';}return null;}
    finally{if(execution===own){execution=null;if(!destroyed){controller=null;state.busy=false;state.autoContinuing=false;state.request=null;saveConversation();notify();}}}
  }
  async function runWindow({question,context={},mode='diagnose',resume=false,retry=false,readResult=false,_execution=null}={}) {
    // Capture the scope before awaiting readiness or network responses.
    let requested=prepareCoachContext(context);question=typeof question==='string'?question.trim():'';
    const owned=Boolean(_execution&&execution===_execution);
    if(destroyed||state.busy&&!owned||state.restoring||_execution?.controller.signal.aborted)return null;if(!state.service)await awaitReadiness(_execution);
    if(destroyed||state.busy&&!owned||state.restoring||state.service?.status!=='ready'||_execution?.controller.signal.aborted)return null;
    if(resume){if(!state.conversation||!readResult&&!state.conversation.can_resume)return null;requested=prepareCoachContext(state.task?.context||state.requestContext);question=state.task?.goal||'';mode=state.task?.mode||mode;}
    else if(!question||question.length>1600||!coachGoals.some(goal=>goal.mode===mode)){state.error=coachErrorText.invalid_question;notify();return null;}
    if(!resume&&!retry&&(state.task?.status==='running'||state.conversation?.can_resume&&state.task?.status!=='awaiting_continuation')){state.error=coachErrorText.continuation_required;notify();return null;}
    if(!resume&&!retry&&state.pendingRequest){state.error='上一轮尚未确认，请先读取任务状态或重试该轮；也可创建新任务。';notify();return null;}
    if(!coachHasSource(requested.source))requested.source=coachSource(state.source);
    let conversation=resume?{id:state.conversation.id,turn_id:state.conversation.turn_id,action:'resume'}:{id:state.conversation?.id||globalThis.crypto.randomUUID(),turn_id:globalThis.crypto.randomUUID(),action:'message',...(!state.conversation?{create:true}:{})};
    if(retry&&state.pendingRequest){({question,mode,context:requested,conversation}=coachClone(state.pendingRequest));}
    const active=++requestNumber,ownController=new AbortController(),stopWindow=()=>ownController.abort();if(_execution)_execution.controller.signal.addEventListener('abort',stopWindow,{once:true});else controller=ownController;readNumber++;cancelStreamFrame();state.busy=true;state.error='';state.actionNote='';state.request={question,mode,context:requested,turn_id:conversation.turn_id};state.pendingRequest={question,mode,context:requested,conversation};state.conversation={...state.conversation,id:conversation.id,turn_id:conversation.turn_id,revision:state.conversation?.revision||0,can_resume:false,source_changed:false};state.result=null;state.stream=newCoachStreamState(conversation);state.activeTaskId=`turn:${conversation.turn_id}`;state.requestContext=requested;if(!resume&&!retry){state.task=null;state.stageArtifact=null;}saveConversation();notify();const timeout=setTimeout(()=>ownController.abort(),state.service?.request_timeout_ms??750000);let pollTimer;
    const poll=async()=>{if(destroyed||active!==requestNumber||!state.busy)return;await refreshTask({quiet:true,expectedTurn:conversation.turn_id});if(!destroyed&&active===requestNumber&&state.busy)pollTimer=setTimeout(poll,1800);};pollTimer=setTimeout(poll,1800);
    try{
      if(ownController.signal.aborted)throw Object.assign(Error(),{name:'AbortError'});
      const body=conversation.action==='resume'?{conversation}:{question,context:requested,task:{mode},conversation};
      const response=await fetchImpl('/api/coach',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json',Accept:'text/event-stream, application/json'},body:JSON.stringify(body),signal:ownController.signal});let data,validated,validatedAttempt=-1;
      if(response.ok&&response.headers.get('content-type')?.split(';')[0].trim()==='text/event-stream'){
        // SSE carries typed application events. Explicit DeepSeek provider traces
        // use their own escaped disclosure; raw tool arguments are not rendered.
        clearTimeout(pollTimer);let terminal=null;
        try{
          await readCoachEventStream(response,{signal:ownController.signal,onEvent:frame=>{
            if(destroyed||active!==requestNumber||ownController.signal.aborted)return false;
            const previousAttempt=state.stream.attempt,update=reduceCoachStreamEvent(state.stream,frame);if(!update.accepted)return;state.stream=update.state;const {payload,type}=update;
            if(state.task&&coachSourceChanged(state.task.source,state.stream.source)){state.task={...state.task,source:state.stream.source,activity:[],provider_trace:[],activity_truncated:false,stage_artifact:null};state.stageArtifact=null;}
            if(state.stream.attempt>previousAttempt||type==='draft_reset'){validated=undefined;validatedAttempt=-1;if(state.result)setResult(null);}
            const final=type==='snapshot'?payload.result:payload.analysis?payload:null;if(final&&JSON.stringify(coachStreamSource(final.source))!==JSON.stringify(state.stream.source))throw Object.assign(Error(),{code:'stream_invalid'});
            if(payload.session&&payload.task){const incoming=prepareCoachConversation(payload.session);if(incoming&&incoming.revision>=(state.conversation?.revision||0))acceptRuntime(payload,conversation);}
            if(type==='artifact'){if(payload.clear===true){if(JSON.stringify(coachStreamSource(payload.source))!==JSON.stringify(state.stream.source))throw Object.assign(Error(),{code:'stream_invalid'});state.stageArtifact=null;}else{const artifact=prepareCoachStageArtifact(payload,state.stream.source,conversation.turn_id);if(!artifact)throw Object.assign(Error(),{code:'stream_invalid'});state.stageArtifact=artifact;}if(state.task)state.task.stage_artifact=state.stageArtifact;}
            if(type==='plan'){
              const base=state.task||{id:conversation.turn_id,status:'running',goal:question,mode,context:requested,source:state.stream.source};
              if(coachCount(payload.plan_revision)>=(base.plan_revision||0))state.task=prepareCoachTaskState({...base,...payload,status:'running',goal:base.goal,mode:base.mode,context:base.context,source:base.source,progress_known:payload.progress?true:base.progress_known});
            }
            if(type==='snapshot'&&payload.result&&hydrateCachedResult(payload)){validated=payload.result;validatedAttempt=state.stream.attempt;}
            if(type==='validated'){
              const result=coachHistoryResult(payload,{live:true});if(!result)throw Object.assign(Error(),{code:'analysis_format_invalid'});validated=payload;validatedAttempt=state.stream.attempt;setResult(result);state.stream.headline='';state.stream.summary='';state.stream.unverified=false;
            }
            if(type==='completed'){terminal=payload.analysis?payload:validatedAttempt===state.stream.attempt?validated:null;if(!terminal)throw Object.assign(Error(),{code:'stream_invalid'});notifyStream();return false;}
            if(type==='paused'){terminal=payload;notifyStream();return false;}
            if(type==='error')throw Object.assign(Error(),{code:typeof payload.error==='string'?payload.error:'provider_request_failed',streamFailure:true});
            notifyStream(type==='draft_delta');
          }});
          if(!terminal)throw Object.assign(Error(),{code:'stream_interrupted'});data=terminal;
        }catch(cause){
          if(ownController.signal.aborted||destroyed||active!==requestNumber)throw cause;
          state.stream.phase='recovering';notify();const recovered=await refreshTask({quiet:true,expectedTurn:conversation.turn_id});
          if(recovered?.task?.status==='completed'&&(recovered.result&&state.result||validated&&validatedAttempt===state.stream.attempt))data={...(recovered.result&&state.result?recovered.result:validated),session:recovered.session,task:recovered.task};
          else if(recovered?.task?.status==='awaiting_continuation'){data={...recovered,status:'awaiting_continuation',analysis:null};state.actionNote='连接已恢复到保存的进度，请点击「继续执行」。';state.stream.phase='paused';}
          else throw cause;
        }
      }else data=await response.json();
      if(active!==requestNumber||destroyed)return null;if(ownController.signal.aborted)throw Object.assign(Error(),{name:'AbortError'});
      if(!response.ok){if(data.session&&data.task)acceptRuntime(data,conversation);throw Object.assign(Error(),{code:data.error,confirmed:true});}readNumber++;
      const runtime=acceptRuntime(data,conversation);if(data.session&&!runtime){if(state.task?.status==='completed'&&state.result&&state.conversation?.id===conversation.id&&state.conversation?.turn_id===conversation.turn_id)return {...coachClone(state.result),source:coachClone(state.task.source),session:coachClone(state.conversation),task:coachClone(state.task)};throw Object.assign(Error(),{code:'analysis_format_invalid'});}if(data.status==='awaiting_continuation'){if(!runtime)throw Object.assign(Error(),{code:'analysis_format_invalid'});state.pendingRequest=null;saveConversation();return coachClone(data);}
      const result=coachHistoryResult(data,{live:true});if(!result)throw Object.assign(Error(),{code:'analysis_format_invalid'});if(!runtime){state.conversation=null;state.task=null;}
      // Keep the captured request scope even when an older server omits context.
      const returned=result.context,authoritative=data.source??returned?.source,source=coachHasSource(authoritative)?coachSource(authoritative):requested.source;
      result.context=prepareCoachContext({...requested,...(runtime?state.task?.context:null),source});setResult(result);state.requestContext=result.context;state.pendingRequest=null;if(state.stream){state.stream.phase='completed';state.stream.headline='';state.stream.summary='';state.stream.unverified=false;}
      visualCache.set(state.activeTaskId,coachClone(result.agent?.visualizations??[]));state.history=state.history.filter(item=>item.id!==state.activeTaskId);state.history.unshift({id:state.activeTaskId,mode,question,created_at:result.generated_at||new Date().toISOString(),context:result.context,source,conversation:state.conversation,result});save();saveConversation();for(const id of visualCache.keys())if(!state.history.some(item=>item.id===id))visualCache.delete(id);return coachClone(result);
    }catch(cause){if(active===requestNumber&&!destroyed){if(cause.confirmed)state.pendingRequest=null;if(state.stream?.phase==='recovering')state.stream.phase='error';state.error=cause.name==='AbortError'?coachErrorText.request_cancelled:(coachErrorText[cause.code]||'本次分析失败，请重试。');if(['analysis_in_progress','continuation_required'].includes(cause.code))await refreshTask({quiet:true});}return null;}
    finally{clearTimeout(timeout);clearTimeout(pollTimer);_execution?.controller.signal.removeEventListener('abort',stopWindow);cancelStreamFrame();if(active===requestNumber&&!destroyed){readNumber++;state.busy=Boolean(_execution&&execution===_execution);state.request=null;if(!_execution)controller=null;saveConversation();notify();}}
  }
  function act(raw) {
    if(destroyed||state.busy||state.historyView)return false;const action=coachArray(state.result?.agent?.actions).find(item=>item.id===raw?.id&&item.kind===raw?.kind);if(!action)return false;
    const ref=state.result.evidence.find(item=>item.id===action.evidence_ref)||null;
    if(action.kind==='open_evidence'){if(ref)onEvidence(coachClone(ref));return Boolean(ref);}
    if(action.kind==='request_render'){if(!ref)return false;state.actionNote='请在瞄准实验室选择片段，并点击「开始渲染」完成原生画面复核。';const target={...ref,view:'mechanics',pending_action:'render'};if(onAction)onAction(coachClone(action),coachClone(target));else onEvidence(coachClone(target));}
    else{state.actionNote='请在数据中心查看同步状态，再按需开始同步。';onAction?.(coachClone(action),ref?coachClone(ref):null);}notify();return true;
  }
  function actVisual(index,raw){
    if(destroyed||state.historyView||!Number.isInteger(index))return false;
    const presented=state.result||{agent:{visualizations:state.stageArtifact?.visualizations},evidence:state.stageArtifact?.evidence};
    const visual=presented.agent?.visualizations?.[index];if(!validateBoundAgentVisualization(visual))return false;
    const action=visual.document.actions.find(item=>item.id===raw?.id&&item.kind===raw?.kind);
    if(!action||!coachVisualActions.includes(action.kind))return false;
    const ref=coachArray(presented.evidence).find(item=>item.id===action.evidence_ref);if(!ref)return false;
    if(action.kind==='open_evidence')onEvidence(coachClone(ref));
    else if(action.kind==='request_render'){
      state.actionNote='请在瞄准实验室选择片段，并点击「开始渲染」完成原生画面复核。';
      if(onAction)onAction(coachClone(action),coachClone(ref));else onEvidence({...coachClone(ref),view:'mechanics'});
    }else if(onAction)onAction(coachClone(action),coachClone(ref));else onEvidence(coachClone(ref));
    notify();return true;
  }
  const api={
    getState:snapshot,
    subscribe(listener){if(destroyed)return ()=>{};listeners.add(listener);listener(snapshot());return ()=>listeners.delete(listener);},run,cancel(){controller?.abort();},refreshTask,loadConversations,restoreConversation,loadTurnHistory,openHistoryTurn,returnToCurrent(){closeHistoryView();notify();},resume(){return run({resume:true});},readResult(){return run({resume:true,readResult:true});},retry(){return state.pendingRequest?run({retry:true,...state.pendingRequest}):null;},
    newTask(){if(destroyed||state.busy)return;requestNumber++;readNumber++;resetTurnHistory();cancelStreamFrame();state.stream=null;state.restoring=false;state.conversation=null;state.task=null;state.stageArtifact=null;state.pendingRequest=null;state.autoContinuing=false;state.activeTaskId='';state.result=null;state.requestContext=null;state.error='';state.actionNote='';saveConversation();notify();},
    selectTask(id){if(destroyed||state.busy)return;const task=state.history.find(item=>item.id===id);if(!task)return;if(state.conversation&&task.conversation?.id===state.conversation.id&&task.conversation.turn_id!==state.conversation.turn_id)return openHistoryTurn(task.conversation.turn_id);requestNumber++;readNumber++;resetTurnHistory();cancelStreamFrame();state.stream=null;state.restoring=false;state.activeTaskId=task.id;state.result=coachClone(task.result);if(state.result.agent)state.result.agent.visualizations=coachClone(visualCache.get(id)??[]);state.requestContext=task.context?coachClone(task.context):null;state.conversation=prepareCoachConversation(task.conversation);state.task=null;state.stageArtifact=null;state.pendingRequest=null;state.error='';state.actionNote='';saveConversation();notify();},
    removeTask(id){if(destroyed||state.busy)return;state.history=state.history.filter(item=>item.id!==id);visualCache.delete(id);if(state.activeTaskId===id)api.newTask();save();notify();},
    clearHistory(){if(destroyed||state.busy)return;state.history=[];visualCache.clear();api.newTask();try{storage?.removeItem(coachHistoryKey);}catch{}notify();},
    setSource(source){if(destroyed)return;const next=coachSource(source);if(JSON.stringify(next)!==JSON.stringify(state.source)){state.source=next;if(state.stageArtifact&&coachSourceChanged(state.stageArtifact.source,next))state.stageArtifact=null;notify();}},act,actVisual,
    destroy(){if(destroyed)return;destroyed=true;requestNumber++;turnListNumber++;turnReadNumber++;cancelStreamFrame();controller?.abort();readinessController?.abort();visualCache.clear();listeners.clear();}
  };
  readiness=status();return api;
}

let coachMountNumber=0;
function mountCoachView(container,{session,getContext=()=>globalThis.window?.CS2Analyst?.getContext?.()??{},view=null,onEvidence=()=>{},onAction=null,fetchImpl=globalThis.fetch,mountVisual=mountAgentVisual,compact=false,expanded=false,onExpandedChange=()=>{}}={}) {
  if(!container)return {update(){},destroy(){}};
  const owned=!session;if(!session)session=createCoachSession({fetchImpl,onEvidence,onAction});
  let surfaceExpanded=compact&&Boolean(expanded);
  let destroyed=false,state=session.getState(),mode='diagnose',draftContext=null,dataScopeChoice=null,evidenceOpen=null,evidenceNumber=0,visualKey=null,visualMounts=[];
  const uid=`coach-question-${++coachMountNumber}`,activeView=()=>view||getContext()?.view||'coach';
  const surfaceModes={overview:['diagnose','training'],matches:['match_review','diagnose'],players:['teamwork','diagnose'],mechanics:['aim_lab','training'],replay:['match_review','teamwork'],sources:['diagnose','training']};
  const availableGoals=compact?coachGoals.filter(goal=>(surfaceModes[activeView()]||['diagnose','training']).includes(goal.mode)):coachGoals;mode=availableGoals[0].mode;
  const composer=`<section class="coach-composer"><div class="coach-section-title"><h3>${compact?'分析当前页面':'创建分析任务'}</h3><span data-coach-mode-label>${coachModeLabel(mode)}</span></div><div class="coach-presets" role="group" aria-label="分析目标">${availableGoals.map(goal=>`<button type="button" data-coach-preset="${coachGoals.indexOf(goal)}" aria-pressed="${goal.mode===mode}"><span aria-hidden="true">${goal.icon}</span><strong>${goal.label}</strong><small>${goal.description}</small></button>`).join('')}</div><form class="coach-form"><div class="coach-data-scope" role="group" aria-label="分析数据范围"><button type="button" data-coach-scope-choice="auto" aria-pressed="true">按问题判断</button><button type="button" data-coach-scope-choice="all_matches" aria-pressed="false">全部比赛</button><button type="button" data-coach-scope-choice="current_selection" aria-pressed="false">当前筛选</button></div><p class="coach-data-scope-note" data-coach-data-scope-note></p><label for="${uid}">任务目标</label><textarea id="${uid}" maxlength="1600" rows="${compact?2:4}" placeholder="${compact?'描述本页希望解决的问题，或选择上方分析目标。':'找出最近比赛首发打偏的主要原因，为我安排 20 分钟训练。'}" required></textarea><div class="coach-form-bottom"><span class="coach-context" data-coach-context></span><div><button type="button" class="button button-quiet" data-coach-new>新任务</button><button type="button" class="button button-quiet" data-coach-cancel hidden>取消</button><button type="submit" class="button button-primary" data-coach-submit disabled>执行分析任务 ↗</button></div></div></form><p class="coach-error" role="alert" data-coach-error hidden></p></section>`;
  container.innerHTML=`<div class="coach-workspace${compact?' coach-surface':''}"><header class="coach-workspace-heading"><div class="coach-agent-identity"><span class="coach-agent-symbol" aria-hidden="true">✳</span><div><span class="coach-eyebrow">CS2 COACH AGENT</span><h2>${compact?`${coachEscape(coachViewNames[activeView()]||'本页')} · 教练分析`:'比赛证据与行动工作台'}</h2></div></div><span class="coach-service" data-coach-service role="status">正在连接</span></header><div class="coach-workspace-grid"><div class="coach-main">${composer}<section class="coach-progress" role="status" aria-live="polite" data-coach-progress hidden><span class="spinner" aria-hidden="true"></span><div><strong data-coach-stream-phase>等待服务端返回分析结果</strong><p data-coach-progress-goal></p></div></section><p class="coach-action-note" role="status" data-coach-action-note hidden></p><div data-coach-provider-trace></div><section class="coach-activity" data-coach-activity hidden aria-label="分析过程"><div class="coach-section-title"><h3>分析过程</h3><span>说明与实际操作</span><button type="button" class="coach-text-button" data-coach-stage-jump hidden>查看阶段结果 ↓</button></div><p class="coach-history-note" data-coach-activity-note hidden>显示最近的执行记录，较早记录已省略。</p><ol data-coach-activity-list aria-live="polite" aria-relevant="additions text"></ol></section><details class="coach-plan-shell" data-coach-plan-shell><summary>任务计划与状态</summary><div data-coach-runtime aria-live="polite"></div></details><section class="coach-stream-draft" data-coach-draft hidden aria-label="待校验分析草稿"><span class="coach-eyebrow">分析草稿 · 待校验</span><h3 data-coach-draft-headline></h3><p data-coach-draft-summary></p><small>引用与交互文档校验完成后，正式结果会替换此草稿。</small></section><div data-coach-stream-tools></div><div data-coach-conversation></div><div data-coach-result-scope></div><div data-coach-results aria-live="polite" aria-busy="false"></div><p class="coach-stage-label" data-coach-stage-label hidden>阶段结果 · 已通过图解校验，任务仍在继续</p><div data-coach-visualizations></div><div data-coach-followups></div><div class="coach-welcome" data-coach-welcome><h3>${compact?'让本页数据进入同一个分析任务':'从一个明确目标开始'}</h3><p>手动执行后，结论、可视化和任务记录会保留在各页面。</p></div><section class="coach-evidence-panel" data-coach-panel hidden aria-label="分析数据引用"><div class="coach-section-title"><h3 data-coach-evidence-title>数据引用</h3><button type="button" class="button button-quiet" data-coach-close>关闭</button></div><div data-coach-evidence-actions></div><pre data-coach-evidence-data tabindex="0"></pre></section></div><aside class="coach-task-sidebar"><section class="coach-scope-card"><span class="coach-eyebrow">CURRENT SCOPE</span><h3>当前任务范围</h3><p data-coach-scope></p><p class="coach-source-caption" data-coach-source></p></section><section class="coach-saved"><div class="coach-section-title"><h3>已保存会话</h3><button type="button" class="coach-text-button" data-coach-load-saved>读取</button></div><p class="coach-history-note">账户私有 · 可跨浏览器找回</p><p class="coach-history-note">分批读取，列表最多保留当前读取的 60 项。</p><p class="coach-history-note" data-coach-restore-note role="status" hidden></p><div data-coach-saved-list></div></section><section class="coach-history"><div class="coach-section-title"><h3>共享任务记录</h3><button type="button" class="coach-text-button" data-coach-clear-history>清空</button></div><p class="coach-history-note">当前浏览器会话 · 全站共享 · 最近 10 项</p><div data-coach-history></div></section></aside></div></div>`;
  if(compact)container.innerHTML=`<div class="coach-drawer"><aside class="coach-drawer-panel" id="${uid}-panel" aria-label="本页 Agent" tabindex="-1" hidden><div class="coach-drawer-bar"><span>页面 Agent</span><button type="button" class="coach-drawer-close" data-coach-drawer-close aria-label="收起本页 Agent">×</button></div><div class="coach-drawer-scroll">${container.innerHTML}</div></aside><button type="button" class="coach-drawer-launcher" data-coach-drawer-toggle aria-controls="${uid}-panel" aria-expanded="false"><span class="coach-drawer-symbol" aria-hidden="true">✳</span><span><strong>Agent</strong><small data-coach-drawer-status role="status">随时分析</small></span><span class="coach-drawer-chevron" aria-hidden="true">↗</span></button></div>`;
  const select=selector=>container.querySelector(selector),form=select('form'),textarea=select('textarea'),submit=select('[data-coach-submit]');
  function updateDrawer(){
    if(!compact)return;select('[data-coach-drawer-toggle]').setAttribute('aria-expanded',String(surfaceExpanded));select('[data-coach-drawer-toggle]').setAttribute('aria-label',surfaceExpanded?'收起本页 Agent':'展开本页 Agent');select('.coach-drawer-panel').hidden=!surfaceExpanded;
    const label=state.busy?'正在分析':state.task?.status==='awaiting_continuation'?'任务待继续':state.result?'有分析结果':'随时分析';select('[data-coach-drawer-status]').textContent=label;
  }
  function setExpanded(value,{focus=true}={}){
    if(!compact||destroyed)return;const next=Boolean(value),changed=next!==surfaceExpanded;surfaceExpanded=next;updateDrawer();if(changed)onExpandedChange(next);
    if(focus)(next?(state.busy?select('.coach-drawer-panel'):textarea):select('[data-coach-drawer-toggle]')).focus({preventScroll:true});
  }
  function drawerKeydown(event){if(compact&&surfaceExpanded&&event.key==='Escape'){event.preventDefault();setExpanded(false);}}

  function composerContext(){const context=prepareCoachContext(dataScopeChoice==='current_selection'?getContext():draftContext||(state.conversation&&state.requestContext)||getContext());if(dataScopeChoice==='auto')delete context.data_scope;else if(dataScopeChoice)context.data_scope=dataScopeChoice;return context;}
  const renderedHtml=new Map();
  function setHtml(selector,html){if(renderedHtml.get(selector)===html)return;const node=select(selector),expanded=Array.from(node.querySelectorAll?.('details[data-coach-expand]')??[]).filter(item=>item.open).map(item=>item.dataset.coachExpand);node.innerHTML=html;renderedHtml.set(selector,html);for(const id of expanded)if(/^[a-z][a-z0-9-]{0,100}$/.test(id)){const detail=node.querySelector?.(`[data-coach-expand="${id}"]`);if(detail)detail.open=true;}}
  function renderStreamText(){
    if(destroyed)return;const stream=state.stream,visible=Boolean(stream&&!state.result&&(stream.headline||stream.summary));select('[data-coach-draft]').hidden=!visible;
    for(const [selector,value] of [['[data-coach-draft-headline]',stream?.headline||''],['[data-coach-draft-summary]',stream?.summary||''],['[data-coach-stream-phase]',stream?coachStreamPhases[stream.phase]||'等待服务端返回分析结果':'等待服务端返回分析结果']]){const node=select(selector);if(node.textContent!==value)node.textContent=value;}
  }
  function renderStreamTools(){const tools=state.stream?.tools||[],active=tools.filter(item=>item.status==='started').length,labels={manage_task_plan:'调整任务计划',present_coach_analysis:'生成分析讲解',validate_visual_document:'核验交互文档',validate_visualization:'核验交互文档'};setHtml('[data-coach-stream-tools]',tools.length?`<section class="coach-stream-tools" aria-label="实时工具状态"><div class="coach-section-title"><h3>实际工具调用</h3><span>${active>1?`${active} 项并行执行`:active?'1 项执行中':'本轮调用记录'}</span></div><ol>${tools.map(tool=>`<li class="${tool.status}"><span aria-hidden="true">${tool.status==='started'?'◉':tool.status==='completed'?'✓':'!'}</span><strong>${coachEscape(tool.resource?coachResourceNames[tool.resource]:labels[tool.name]||'读取分析数据')}</strong><small>${tool.status==='started'?'执行中':tool.status==='completed'?'已返回':'未取得结果'}</small></li>`).join('')}</ol></section>`:'');}
  let activityTurn=null,planPreparedTurn=null,planCollapseTurn=null;const activityNodes=new Map();
  function renderActivity(){
    const turn=state.conversation?.turn_id,entries=mergeCoachActivity(state.task?.activity,state.stream?.activity,turn),rows=coachActivityRows(entries,turn),host=select('[data-coach-activity-list]');
    const planShell=select('[data-coach-plan-shell]');planShell.hidden=!state.task&&!state.pendingRequest;if(planPreparedTurn!==turn){planShell.open=true;planPreparedTurn=turn;}if(rows.length&&planCollapseTurn!==turn){planShell.open=false;planCollapseTurn=turn;}select('[data-coach-stage-jump]').hidden=!state.stageArtifact||Boolean(state.result);select('[data-coach-activity]').hidden=!rows.length;select('[data-coach-stream-tools]').hidden=rows.length>0;select('[data-coach-activity-note]').hidden=!(state.task?.activity_truncated||state.stream?.activity_truncated);
    // Keep existing rows and open tool details in place as new entries arrive.
    // Draft text takes its separate rAF path and never replaces this journal.
    if(!host.ownerDocument?.createElement||!host.insertBefore){setHtml('[data-coach-activity-list]',rows.map(row=>`<li class="coach-activity-item ${row.kind} ${row.status||''}" data-coach-activity-id="${coachEscape(row.key)}">${coachActivityItemHtml(row)}</li>`).join(''));return;}
    if(activityTurn!==turn){host.replaceChildren();activityNodes.clear();activityTurn=turn;}
    const keys=new Set(rows.map(row=>row.key));for(const [key,item]of activityNodes)if(!keys.has(key)){item.node.remove();activityNodes.delete(key);}
    let cursor=host.firstElementChild;
    for(const row of rows){let item=activityNodes.get(row.key);const html=coachActivityItemHtml(row);if(!item){item={node:host.ownerDocument.createElement('li'),html:null};activityNodes.set(row.key,item);}if(item.html!==html){const open=item.node.querySelector('details')?.open;item.node.innerHTML=html;item.node.className=`coach-activity-item ${row.kind} ${row.status||''}`;item.node.dataset.coachActivityId=row.key;if(open&&item.node.querySelector('details'))item.node.querySelector('details').open=true;item.html=html;}if(item.node!==cursor)host.insertBefore(item.node,cursor);cursor=item.node.nextElementSibling;}
  }
  function activityEvidence(id){
    const direct=coachArray((state.historyView?.result??state.result)?.evidence).find(item=>item.id===id)||!state.historyView&&coachArray(state.stageArtifact?.evidence).find(item=>item.id===id);if(direct)return direct;
    const turn=state.conversation?.turn_id,entry=mergeCoachActivity(state.task?.activity,state.stream?.activity,turn).find(item=>item.query&&coachArray(item.evidence_refs).includes(id));return entry?{id,resource:entry.query.resource,query:entry.query,match_id:entry.query.match_id,round_number:entry.query.round_number}:null;
  }
  function renderVisuals(){
    const viewed=state.historyView,result=viewed?viewed.result:state.result,stage=!viewed&&!result&&state.stageArtifact,visuals=result?coachLiveVisuals(result):stage?.visualizations||[],omitted=coachCount(result?.agent?.visualizations_omitted),key=`${viewed?.turn_id||state.conversation?.turn_id||state.activeTaskId}:${JSON.stringify(visuals)}:${visuals.length?0:omitted}`;
    select('[data-coach-stage-label]').hidden=!stage;
    if(visualKey===key)return;visualKey=key;for(const mounted of visualMounts)mounted.destroy();visualMounts=[];
    const host=select('[data-coach-visualizations]');host.innerHTML=visuals.length?visuals.map((_,index)=>`<section data-coach-visual="${index}"></section>`).join(''):omitted?'<p class="coach-visual-history-note">本次交互文档使用的查询数据未写入浏览器存储。请手动重新执行任务，生成当前数据版本的交互讲解。</p>':'';
    for(const [index,visual] of visuals.entries()){
      try{visualMounts.push(mountVisual(select(`[data-coach-visual="${index}"]`),visual,{onAction:action=>{const actual=coachArray(visual.document?.actions).find(item=>item.id===action?.id&&item.kind===action?.kind);if(actual?.kind==='open_evidence')return showEvidence(actual.evidence_ref);if(!viewed)return session.actVisual(index,action);}}));}
      catch{select(`[data-coach-visual="${index}"]`).textContent='交互文档暂不可用，请重新执行任务。';}
    }
  }
  function render(){
    if(destroyed)return;updateDrawer();const current=prepareCoachContext(getContext()),ready=state.service?.status==='ready',context=composerContext(),paused=state.task?.status==='awaiting_continuation',unfinished=Boolean(state.restoring||state.conversation?.can_resume&&!paused||state.task?.status==='running'||state.pendingRequest),viewed=state.historyView,result=viewed?viewed.result:state.result,reportContext=viewed?viewed.context:state.requestContext;
    renderStreamText();renderStreamTools();renderActivity();setHtml('[data-coach-provider-trace]',renderProviderTrace(state.historyView?[]:[...(state.task?.provider_trace??[]),...(state.stream?.provider_trace??[])]));
    const dataScope=context.data_scope||'auto';for(const value of ['auto','all_matches','current_selection']){const button=select(`[data-coach-scope-choice="${value}"]`);button.disabled=state.busy||unfinished;button.setAttribute('aria-pressed',String(value===dataScope));}select('[data-coach-data-scope-note]').textContent=dataScope==='all_matches'?'分析范围为全部已同步比赛；页面所选片段仅作当前焦点。':dataScope==='current_selection'?'按当前页面的筛选与选择分析，仍可在同一会话继续深入其他比赛。':'根据任务确定范围；可明确选择全部比赛，逐步深入所有可用数据。';
    select('[data-coach-service]').textContent=ready?`${state.service?.provider==='openai'?'OpenAI':'DeepSeek Flash'} 已配置`:state.service?.status==='unavailable'?'暂不可用':state.service?'等待配置':'正在连接';select('[data-coach-service]').classList.toggle('ready',ready);submit.disabled=state.busy||!ready||unfinished;submit.textContent=state.busy?'任务进行中…':unfinished?'先读取当前进度':paused?'发送补充需求 ↗':state.conversation?'继续此会话 ↗':'执行分析任务 ↗';textarea.disabled=state.busy||unfinished;
    select('[data-coach-cancel]').hidden=!state.busy;select('[data-coach-progress]').hidden=!state.busy;select('[data-coach-error]').hidden=!state.error;select('[data-coach-error]').textContent=state.error;select('[data-coach-action-note]').hidden=!state.actionNote;select('[data-coach-action-note]').textContent=state.actionNote;select('[data-coach-welcome]').hidden=state.busy||Boolean(state.result||state.task||state.pendingRequest);select('[data-coach-progress-goal]').textContent=state.request?.question||'';select('[data-coach-mode-label]').textContent=coachModeLabel(mode);
    select('[data-coach-context]').textContent=`${draftContext||state.conversation&&state.requestContext?'原任务范围':'当前范围'} · ${coachContextLabel(context)}`;select('[data-coach-scope]').textContent=coachContextLabel(context);select('[data-coach-source]').textContent=coachSourceLabel(context.source);
    const runtime=coachTaskStateHtml(state),recovery=state.conversation&&!state.busy&&state.pendingRequest?`<section class="coach-runtime" aria-label="未确认的任务"><p>上一轮请求尚未确认。先读取服务端状态，可避免重复执行。</p><div class="coach-runtime-actions"><button type="button" class="button button-quiet" data-coach-refresh-task>读取任务状态</button><button type="button" class="button button-quiet" data-coach-retry>重试同一轮</button><button type="button" class="button button-quiet" data-coach-new>新任务</button></div></section>`:'';
    setHtml('[data-coach-runtime]',runtime+recovery);
    const turnHistory=state.turnHistory,completed=turnHistory.items.filter(item=>item.status==='completed'&&item.historical),localTurns=state.history.filter(item=>item.conversation?.id===state.conversation?.id);
    setHtml('[data-coach-conversation]',state.conversation?`<section class="coach-conversation" aria-label="同会话历史结果"><div class="coach-section-title"><h3>本会话已完成结果</h3><button type="button" class="coach-text-button" data-coach-load-turns ${turnHistory.loading?'disabled':''}>${turnHistory.loading?'读取中…':turnHistory.loaded?'刷新目录':'读取目录'}</button></div><p class="coach-history-note">服务端保存 · 只读查看${localTurns.length?` · ${localTurns.length} 轮已完成记录`:''}</p>${turnHistory.error?`<p class="coach-saved-error" role="alert">${coachEscape(turnHistory.error)}</p>`:''}${completed.length?`<ol>${completed.map(item=>`<li><span>${coachEscape(coachModeLabel(item.mode))}${item.stale?' · 旧数据版本':''}</span><p>${coachEscape(item.question||item.summary||'已完成分析')}</p><button type="button" data-coach-open-turn="${coachEscape(item.turn_id)}" ${state.restoring?'disabled':''} ${viewed?.turn_id===item.turn_id?'aria-current="true"':''}>查看已保存报告与图表 ↗</button></li>`).join('')}</ol>`:turnHistory.loaded?'<p class="coach-history-note">当前目录暂无较早的已完成结果。</p>':''}${turnHistory.cursor?`<button type="button" class="coach-text-button coach-turn-more" data-coach-more-turns ${turnHistory.loading?'disabled':''}>更多历史结果</button>`:''}${viewed?`<div class="coach-history-view-note" role="status"><strong>正在只读查看历史结果</strong><p>${viewed.loading?'正在读取已保存的报告与图表…':coachEscape(viewed.error||viewed.question||'已完成分析')} </p><p>当前任务进度和继续范围保留在上方。</p><button type="button" class="button button-quiet" data-coach-return-current>返回当前任务</button></div>`:''}</section>`:'');
    const saved=state.savedConversations,savedStatus={running:'正在执行',awaiting_continuation:'等待继续',completed:'已完成',failed:'执行中断'};
    select('[data-coach-load-saved]').disabled=saved.loading;select('[data-coach-load-saved]').textContent=saved.loading?'读取中…':saved.loaded?'刷新列表':'读取';select('[data-coach-restore-note]').hidden=!state.restoring;select('[data-coach-restore-note]').textContent=state.restoring?'正在恢复会话状态…':'';
    setHtml('[data-coach-saved-list]',`${saved.error?`<p class="coach-saved-error" role="alert">${coachEscape(saved.error)}</p>`:''}${saved.conversations.length?saved.conversations.map(item=>`<div class="coach-history-item"><button type="button" data-coach-restore="${coachEscape(item.session.id)}" ${state.busy?'disabled':''} ${state.conversation?.id===item.session.id?'aria-current="true"':''}><span>${savedStatus[item.task.status]}<time>${coachEscape(coachTime(item.updated_at))}</time></span><strong>${coachEscape(item.task.goal||'分析任务')}</strong><small>恢复会话 ↗</small></button></div>`).join(''):saved.loaded?'<p class="coach-history-empty">暂无已保存会话。</p>':'<p class="coach-history-empty">读取服务端会话，找回已保存的任务进度与结果。</p>'}${saved.cursor?`<button type="button" class="button button-quiet coach-saved-more" data-coach-more-saved ${saved.loading?'disabled':''}>更多会话</button>`:''}`);
    for(const button of container.querySelectorAll('[data-coach-preset]')){button.disabled=state.busy||unfinished;button.setAttribute('aria-pressed',String(coachGoals[Number(button.dataset.coachPreset)]?.mode===mode));}select('[data-coach-new]').disabled=state.busy;
    const status=coachContextStatus(reportContext,dataScopeChoice?context:current),stale=status.sourceStale||viewed?.stale;
    setHtml('[data-coach-result-scope]',result?`<section class="coach-result-scope${stale||status.contextChanged?' changed':''}" role="status"><div><strong>${viewed?`历史结果 · 只读${stale?' · 旧数据版本':''}`:stale?'数据版本已更新':status.unknown?'历史任务未记录范围':status.contextChanged?'已选任务来自其他范围':'当前范围的共享分析'}</strong><p>${coachEscape(reportContext?coachContextLabel(reportContext):'原始范围未记录')} · ${coachEscape(coachSourceLabel(reportContext?.source))}</p>${stale?'<p>此结果保留原数据版本的结论；请按当前范围重新分析后用于最新数据。</p>':status.contextChanged?'<p>页面范围已变化，以下保留原任务的结果。</p>':''}</div><button type="button" class="button button-quiet" ${viewed?'data-coach-return-current':'data-coach-current'} ${!viewed&&state.busy?'disabled':''}>${viewed?'返回当前任务':'按当前范围重做'}</button></section>`:'');
    const resultHtml=coachResultHtml(result,{compact});setHtml('[data-coach-results]',viewed?resultHtml.replace(/<button\b([^>]*)>/g,(whole,attrs)=>attrs.includes('data-coach-evidence=')?whole:'<button disabled'+attrs+'>'):resultHtml);select('[data-coach-results]').setAttribute('aria-busy',String(viewed?viewed.loading:state.busy));renderVisuals();
    setHtml('[data-coach-followups]',state.result&&!viewed?`<div class="coach-followups"><span>继续同一会话</span><button type="button" data-coach-followup="evidence" ${state.busy||unfinished||!state.requestContext?'disabled':''}>深入证据</button><button type="button" data-coach-followup="training" ${state.busy||unfinished||!state.requestContext?'disabled':''}>制定复测计划</button><small>${state.conversation?'沿用已验证的会话记录与原任务范围':'历史结果可查看；重新执行将创建新会话'}</small></div>`:'');
    setHtml('[data-coach-history]',state.history.length?state.history.map(item=>{const match=coachContextStatus(item.context,current);return `<div class="coach-history-item${item.id===state.activeTaskId?' selected':''}"><button type="button" data-coach-history="${coachEscape(item.id)}" ${state.busy?'disabled':''} ${item.id===state.activeTaskId?'aria-current="true"':''}><span>${coachModeLabel(item.mode)}<time>${coachEscape(coachTime(item.created_at))}</time></span><strong>${coachEscape(item.question)}</strong><small>${match.sourceStale?'旧数据版本':match.unknown?'范围未记录':match.contextChanged?'其他范围':'当前范围'}</small></button><button type="button" class="coach-history-delete" data-coach-delete="${coachEscape(item.id)}" aria-label="删除任务：${coachEscape(item.question)}" ${state.busy?'disabled':''}>×</button></div>`;}).join(''):'<p class="coach-history-empty">完成任务后，可在所有页面重新查看结果。</p>');select('[data-coach-clear-history]').disabled=state.busy||!state.history.length;
  }
  function closeEvidence(){evidenceOpen=null;evidenceNumber++;select('[data-coach-panel]').hidden=true;}
  async function showEvidence(id){
    const ref=activityEvidence(id);if(!ref)return;const viewed=state.historyView,task=state.history.find(item=>item.id===state.activeTaskId),conversation=viewed?{id:state.conversation?.id,turn_id:viewed.turn_id}:task?.conversation??state.conversation,parsed=coachArchiveReference(ref.query_ref)||coachArchiveReference(ref.id);
    if(viewed&&!parsed)return;
    const identity=()=>JSON.stringify({id:state.conversation?.id,turn:state.conversation?.turn_id,view:state.historyView?.turn_id,active:state.activeTaskId}),active=++evidenceNumber,scope=identity();evidenceOpen=ref;select('[data-coach-panel]').hidden=false;select('[data-coach-evidence-title]').textContent=coachResourceNames[ref.resource]||'数据引用';setHtml('[data-coach-evidence-actions]',!viewed&&ref.match_id?'<button type="button" class="button button-quiet" data-coach-jump>打开对局 ↗</button>':'');select('[data-coach-evidence-data]').textContent='正在读取…';select('[data-coach-panel]').scrollIntoView({behavior:'smooth',block:'nearest'});
    try{let data;if(parsed){data=await fetchCoachArchivedEvidence({fetchImpl,conversationId:conversation?.id,turnId:conversation?.turn_id,currentTurnId:state.conversation?.id===conversation?.id?state.conversation?.turn_id:undefined,reference:parsed.reference,source:viewed?.source??task?.source??state.requestContext?.source??state.task?.source,query:ref.query});}
      else{if(viewed||ref.query?.section==='local_statistics'||ref.query?.section==='local_statistics_catalog')throw Error();const response=await fetchImpl('/api/query',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(ref.query)});if(!response.ok)throw Error();data=await response.json();}
      if(!destroyed&&active===evidenceNumber&&scope===identity())select('[data-coach-evidence-data]').textContent=JSON.stringify(data,null,2);}
    catch{if(!destroyed&&active===evidenceNumber&&scope===identity())select('[data-coach-evidence-data]').textContent='暂时无法读取该数据引用。';}
  }
  const ask=event=>{event?.preventDefault();return session.run({question:textarea.value,context:composerContext(),mode});};
  function click(event){
    const target=event.target;if(!target?.closest)return;const closest=selector=>target.closest(selector),preset=closest('[data-coach-preset]');
    if(compact&&closest('[data-coach-drawer-toggle]')){setExpanded(!surfaceExpanded);return;}
    if(compact&&closest('[data-coach-drawer-close]')){setExpanded(false);return;}
    const scopeChoice=closest('[data-coach-scope-choice]');if(scopeChoice&&!state.busy&&!state.restoring&&(!state.conversation?.can_resume||state.task?.status==='awaiting_continuation')&&state.task?.status!=='running'&&!state.pendingRequest&&['auto','all_matches','current_selection'].includes(scopeChoice.dataset.coachScopeChoice)){dataScopeChoice=scopeChoice.dataset.coachScopeChoice;render();return;}
    if(closest('[data-coach-new]')&&!state.busy){dataScopeChoice=null;draftContext=null;textarea.value='';closeEvidence();session.newTask();textarea.focus();return;}
    if(closest('[data-coach-resume]')&&!state.busy){session.resume();return;}
    if(closest('[data-coach-read-result]')&&!state.busy){session.readResult();return;}
    if(closest('[data-coach-refresh-task]')&&!state.busy){session.refreshTask();return;}
    if(closest('[data-coach-retry]')&&!state.busy){session.retry();return;}
    if(closest('[data-coach-load-saved]')){session.loadConversations();return;}
    if(closest('[data-coach-more-saved]')){session.loadConversations({more:true});return;}
    if(closest('[data-coach-load-turns]')){session.loadTurnHistory();return;}
    if(closest('[data-coach-more-turns]')){session.loadTurnHistory({more:true});return;}
    if(closest('[data-coach-return-current]')){closeEvidence();session.returnToCurrent();return;}
    const oldTurn=closest('[data-coach-open-turn]');if(oldTurn){closeEvidence();session.openHistoryTurn(oldTurn.dataset.coachOpenTurn);return;}
    const restore=closest('[data-coach-restore]');if(restore&&!state.busy){closeEvidence();draftContext=null;dataScopeChoice=null;session.restoreConversation(restore.dataset.coachRestore);return;}
    if(preset&&!state.busy){const goal=coachGoals[Number(preset.dataset.coachPreset)];if(goal){mode=goal.mode;draftContext=null;textarea.value=goal.question;render();textarea.focus();}return;}
    if(closest('[data-coach-stage-jump]')){select('[data-coach-stage-label]').scrollIntoView({behavior:'smooth',block:'start'});return;}
    const activityRef=closest('[data-coach-activity-ref]');if(activityRef){showEvidence(activityRef.dataset.coachActivityRef);return;}
    const ref=closest('[data-coach-evidence]');if(ref){showEvidence(ref.dataset.coachEvidence);return;}
    const actionNode=closest('[data-coach-action]');if(actionNode&&!state.busy){const action=state.result?.agent?.actions.find(item=>item.id===actionNode.dataset.coachAction);if(!action)return;if(action.kind==='open_evidence')showEvidence(action.evidence_ref);else session.act(action);return;}
    const saved=closest('[data-coach-history]');if(saved&&!state.busy){const task=state.history.find(item=>item.id===saved.dataset.coachHistory);if(!task)return;closeEvidence();if(task.conversation?.id===state.conversation?.id&&task.conversation?.turn_id!==state.conversation?.turn_id){session.selectTask(task.id);return;}mode=task.mode;textarea.value=task.question;session.selectTask(task.id);draftContext=task.context;render();return;}
    const remove=closest('[data-coach-delete]');if(remove){closeEvidence();session.removeTask(remove.dataset.coachDelete);return;}
    if(closest('[data-coach-clear-history]')){closeEvidence();draftContext=null;session.clearHistory();return;}
    if(closest('[data-coach-cancel]')){session.cancel();return;}if(closest('[data-coach-close]')){closeEvidence();return;}
    if(closest('[data-coach-jump]')&&evidenceOpen&&!state.busy){onEvidence(coachClone(evidenceOpen));return;}
    if(closest('[data-coach-current]')&&!state.busy){const question=state.history.find(item=>item.id===state.activeTaskId)?.question||coachGoals.find(goal=>goal.mode===mode).question;draftContext=null;session.newTask();textarea.value=question;render();textarea.focus();return;}
    const followup=closest('[data-coach-followup]');
    if(followup&&!state.busy&&state.requestContext){const task=state.history.find(item=>item.id===state.activeTaskId),training=followup.dataset.coachFollowup==='training';draftContext=coachClone(state.requestContext);mode=training?'training':task?.mode||'diagnose';textarea.value=training?'基于刚才的分析，制定具体训练与复测计划，引用可核查的指标和比赛证据。':'继续深入刚才的分析，补充关键回合、玩家和片段证据，并说明不确定之处。';render();textarea.focus();}
  }
  form.addEventListener('submit',ask);container.addEventListener('click',click);if(compact)container.addEventListener('keydown',drawerKeydown);
  let previousId=state.activeTaskId,previousView=state.historyView?.turn_id;
  const unsubscribe=session.subscribe((next,metadata={})=>{if(previousView!==next.historyView?.turn_id){closeEvidence();previousView=next.historyView?.turn_id;}if(previousId!==next.activeTaskId){closeEvidence();previousId=next.activeTaskId;draftContext=null;dataScopeChoice=null;}if(state.busy&&!next.busy&&next.task?.status==='awaiting_continuation'&&textarea.value.trim()===next.task.goal)textarea.value='';state=next;if(metadata.draftOnly)renderStreamText();else render();});
  return {session,open(options){setExpanded(true,options);},close(options){setExpanded(false,options);},isOpen(){return surfaceExpanded;},update(){render();},destroy(){if(destroyed)return;destroyed=true;evidenceNumber++;unsubscribe();for(const mounted of visualMounts)mounted.destroy();visualMounts=[];form.removeEventListener('submit',ask);container.removeEventListener('click',click);if(compact)container.removeEventListener('keydown',drawerKeydown);if(owned)session.destroy();}};
}
export function mountCoach(container,options={}){return mountCoachView(container,options);}
export function mountCoachSurface(container,options={}){return mountCoachView(container,{...options,compact:true});}
