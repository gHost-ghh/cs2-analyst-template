import {normalizeQueryInput,QUERY_RESOURCES,AGENT_PLAN_SCOPE_PROPERTIES} from './query.mjs';
import {validateBoundAgentVisualization,projectAgentVisualBindingData} from '../shared/agent-visual.mjs';
import {projectAgentWorkflow} from './agent-workflow.mjs';
import {appendProviderReasoning,publicProviderReasoning} from './agent-reasoning.mjs';
// Private, owner-scoped agent memory and observable execution checkpoints.
// Stores validated observations/reports and bounded, explicitly untrusted
// visualization repair candidates; never provider messages or reasoning items.
export const AGENT_RUNTIME_VERSION='1.0';
export const AGENT_EXECUTION_WINDOW=Object.freeze({api_calls:8,tool_calls:24,timeout_ms:120000});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPERATIONS=['read_data','validate_visual','present'];
const PLAN_ACTIONS=['set','append','revise','reorder','activate','defer','cancel'];
const STEP=/^[a-z][a-z0-9_-]{0,39}$/;
const LEASE_MS=150000,MAX_RECORD_BYTES=768*1024,RECENT_TURNS=8,MAX_PLAN_REVISIONS=16;
// These failures may be fixed outside the task. Recovery still requires an
// explicit resume of the current unfinished turn; GET never retries a model.
const MANUAL_PROVIDER_FAILURES=new Set(['provider_request_failed','provider_auth_failed','provider_quota_exceeded','provider_rate_limited']);
const canResumeProviderFailure=turn=>turn.status==='failed'&&turn.result==null&&turn.presentation_validated!==true&&MANUAL_PROVIDER_FAILURES.has(turn.error);
const statisticsSection=value=>['local_statistics','local_statistics_catalog'].includes(value);
const FORBIDDEN_SCOPE_KEYS=new Set(['__proto__','prototype','constructor','toString','valueOf','hasOwnProperty','api_key','authorization','cookie','password','secret','access_token','refresh_token']);
const encoder=new TextEncoder();
const clone=value=>structuredClone(value);
const ownKeys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const ACTIVITY_LIMIT=160;
const ACTIVITY_PHASES=['plan','finding','revision','reading','planning','presenting','repairing','validating','generating'];
const ACTIVITY_STATUSES=['started','completed','failed'];
const plainValues=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(Object.getOwnPropertyDescriptors(value)).every(item=>Object.hasOwn(item,'value'));
function publicQuery(value){
  // Archived queries and public activity locators share the data contract,
  // not the narrower task-plan scope. Keep omitted pagination omitted so old
  // query hashes and exact archive lookup remain stable.
  try{return normalizeQueryInput(value,{defaults:false,partial:true});}catch{throw new AgentRuntimeError('invalid_activity',400);}
}
function activityPayload(value){
  if(!plainValues(value)||!ownKeys(value,['kind','phase','message','name','call_id','attempt','status','resource','query','summary','evidence_refs'])||!['commentary','tool','phase','plan'].includes(value.kind))throw new AgentRuntimeError('invalid_activity',400);
  const result={kind:value.kind};
  if(value.phase!=null){if(!ACTIVITY_PHASES.includes(value.phase))throw new AgentRuntimeError('invalid_activity',400);result.phase=value.phase;}
  if(value.message!=null){if(typeof value.message!=='string'||!value.message.trim()||value.message.length>800||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.message))throw new AgentRuntimeError('invalid_activity',400);result.message=value.message.trim();}
  for(const field of ['name','call_id','resource','status'])if(value[field]!=null){const item=value[field],valid=field==='resource'?QUERY_RESOURCES.includes(item):field==='status'?ACTIVITY_STATUSES.includes(item):typeof item==='string'&&(field==='name'?/^[a-z][a-z0-9_]{0,127}$/:/^[A-Za-z0-9_:-]{1,200}$/).test(item);if(!valid)throw new AgentRuntimeError('invalid_activity',400);result[field]=item;}
  if(value.attempt!=null){if(!Number.isSafeInteger(value.attempt)||value.attempt<0||value.attempt>1e9)throw new AgentRuntimeError('invalid_activity',400);result.attempt=value.attempt;}
  if(value.query!=null)result.query=publicQuery(value.query);
  if(value.summary!=null){if(!plainValues(value.summary)||!ownKeys(value.summary,['rows','available','state','next_offset']))throw new AgentRuntimeError('invalid_activity',400);result.summary={};for(const [key,item]of Object.entries(value.summary)){if(key==='available'?typeof item!=='boolean':key==='state'?typeof item!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(item):key==='next_offset'&&item===null?false:!Number.isSafeInteger(item)||item<0||item>1e9)throw new AgentRuntimeError('invalid_activity',400);result.summary[key]=item;}}
  if(value.evidence_refs!=null){if(!Array.isArray(value.evidence_refs)||value.evidence_refs.length>8||new Set(value.evidence_refs).size!==value.evidence_refs.length||value.evidence_refs.some(ref=>typeof ref!=='string'||!ref||ref.length>240))throw new AgentRuntimeError('invalid_activity',400);result.evidence_refs=[...value.evidence_refs];}
  if(result.kind==='commentary'&&(!result.message||!['plan','finding','revision'].includes(result.phase)||result.phase==='finding'&&!result.evidence_refs?.length))throw new AgentRuntimeError('invalid_activity',400);
  if(result.kind==='tool'&&(!result.name||!result.call_id||!result.status||result.attempt==null))throw new AgentRuntimeError('invalid_activity',400);
  return result;
}
function currentEvidence(turn){
  const references=new Map();for(const entry of turn.work?.queries??[]){if(typeof entry.reference!=='string'||!entry.result||entry.result.error)continue;references.set(entry.reference,entry);let visits=0;const todo=[entry.result];while(todo.length&&visits++<10000){const value=todo.pop();if(!value||typeof value!=='object')continue;for(const [key,item]of Object.entries(value)){if(['evidence_ref','evidence_id'].includes(key)&&typeof item==='string'&&item.length<=240)references.set(item,entry);else if(key==='evidence_refs'&&Array.isArray(item)){for(const ref of item)if(typeof ref==='string'&&ref.length<=240)references.set(ref,entry);}else if(item&&typeof item==='object')todo.push(item);}}}return references;
}
function appendActivity(turn,value,stamp,archivedEvidence=[]){
  const clean=activityPayload(value),known=currentEvidence(turn);
  for(const ref of archivedEvidence)known.set(ref,true);
  if(clean.evidence_refs?.some(ref=>!known.has(ref)))throw new AgentRuntimeError('activity_evidence_invalid',400);
  turn.activity_sequence=(turn.activity_sequence??0)+1;const entry={id:`${turn.id}:activity:${turn.activity_sequence}`,at:new Date(stamp).toISOString(),...clean};turn.activity=[...(turn.activity??[]),entry];if(turn.activity.length>ACTIVITY_LIMIT){turn.activity=turn.activity.slice(-ACTIVITY_LIMIT);turn.activity_truncated=true;}return clone(entry);
}
export class AgentRuntimeError extends Error{constructor(code,status=409,details){super(code);this.code=code;this.status=status;if(details)this.details=details;}}
function safeSource(source={}){return {source_revision:source.source_revision??null,generated_at:source.generated_at??null,content_sha256:source.content_sha256??null};}
function sameSource(a,b){return a.source_revision===b.source_revision&&a.generated_at===b.generated_at&&a.content_sha256===b.content_sha256;}
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
async function dataHash(value){const bytes=await crypto.subtle.digest('SHA-256',encoder.encode(typeof value==='string'?value:JSON.stringify(value)));return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');}
function queryEvidenceIds(result){const refs=new Set(),todo=[result];while(todo.length){const value=todo.pop();if(!value||typeof value!=='object')continue;for(const [key,item]of Object.entries(value)){if(['evidence_ref','evidence_id'].includes(key)&&typeof item==='string'&&item.length<=240)refs.add(item);else if(key==='evidence_refs'&&Array.isArray(item)){for(const ref of item)if(typeof ref==='string'&&ref.length<=240)refs.add(ref);}else if(item&&typeof item==='object')todo.push(item);}}return [...refs];}
function archiveSummary(entry){const result=entry.result;return {reference:entry.reference,query:clone(entry.query),bytes:entry.bytes,...(Array.isArray(result.items)?{rows:result.items.length}:{}),...(result.pagination?{pagination:clone(result.pagination)}:{}),...(result.window?{window:clone(result.window)}:{}),...(typeof result.state==='string'?{state:result.state}:{}),...(typeof result.available==='boolean'?{available:result.available}:{})};}
function repairMilestones(turn){
  const stage=value=>Number.isSafeInteger(value)?Math.max(0,Math.min(2,value)):0,formal={};
  for(const category of ['schema','evidence','visual'])if(turn.repair_milestones?.formal_feedback?.[category]===true)formal[category]=true;
  for(const item of Array.isArray(turn.work?.presentation_feedback)?turn.work.presentation_feedback:[]){
    if(item?.stage!=null&&item.stage!=='final')continue;
    const category=item?.error==='analysis_schema_invalid'?'schema':item?.error==='analysis_evidence_invalid'?'evidence':item?.error==='analysis_visual_invalid'?'visual':null;
    if(category)formal[category]=true;
  }
  return {preflight_failures:Math.max(stage(turn.repair_milestones?.preflight_failures),stage(turn.work?.preflight_failures)),entered_final:turn.repair_milestones?.entered_final===true||turn.work?.force_final===true,...(Object.keys(formal).length?{formal_feedback:formal}:{})};
}
function progressSignature(turn){const coverage=turn.work?.coverage,repair=repairMilestones(turn),formal=repair.formal_feedback,mask=(formal?.schema?1:0)|(formal?.evidence?2:0)|(formal?.visual?4:0),base=`${turn.generation??0}:${turn.query_success_sequence??0}:${turn.stage_revision??0}:${coverage?.matches_discovered??0}:${coverage?.detail_matches??0}:${coverage?.rounds_read??0}`;return repair.preflight_failures||repair.entered_final||mask?`${base}:repair:${repair.preflight_failures}:${repair.entered_final?1:0}${mask?`:feedback:${mask}`:''}`:base;}
function recoveryState(turn){const reason=turn.pause_reason??'',signature=progressSignature(turn),eligible=['execution_window_complete','execution_window_timeout','provider_timeout','provider_unreachable','provider_stream_interrupted','provider_transient','analysis_incomplete','provider_response_invalid','analysis_repair_pending','visual_repair_pending','format_repair_pending'].includes(reason),progressed=signature!==turn.window_progress_start;return {can_auto_continue:turn.status==='awaiting_continuation'&&eligible&&progressed,progress_signature:signature,reason,stalled:turn.status==='awaiting_continuation'&&eligible&&!progressed,retry_after_ms:Math.max(0,turn.retry_after_ms??0)};}
function coverageState(turn){const value=turn.work?.coverage;return value?clone(value):{scope:'selected',matches_total:0,matches_discovered:0,match_ids_discovered:[],match_ids_detailed:[],detail_matches:0,queries_completed:turn.query_success_sequence??turn.work?.queries?.length??0,pages_completed:0,pending:[],complete:false,granularity:'round_statistics',note:'Only explicitly completed pages are covered. Raw event/frame windows remain individually addressable.'};}
function providerState(turn){const value=turn.work?.provider_status;if(!value||!['deepseek','openai'].includes(value.provider)||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value.model)||!['completed','incomplete','interrupted'].includes(value.status)||!['reading','presentation','repair'].includes(value.stage))return null;const count=item=>Number.isSafeInteger(item)&&item>=0?item:null;return {provider:value.provider,model:value.model,status:value.status,reason:value.status==='completed'?null:['max_output_tokens','content_filter'].includes(value.reason)?value.reason:'unknown',stage:value.stage,last:value.last===true,presentation_started:value.presentation_started===true,input_tokens:count(value.input_tokens),output_tokens:count(value.output_tokens)};}
function root(owner){if(typeof owner!=='string'||!/^\d{17}$/.test(owner))throw new AgentRuntimeError('session_owner_unavailable',503);return `coach/v3/${owner}/`;}
function validateRecord(value,owner,id){if(!value||value.version!==AGENT_RUNTIME_VERSION||value.owner!==owner||value.id!==id||!Number.isInteger(value.revision)||!Array.isArray(value.recent_turns)||!value.turn||!UUID.test(value.turn.id))throw new AgentRuntimeError('conversation_invalid',503);return value;}
export function parseAgentConversation(value){
  if(value==null)return {action:'message'};
  if(!ownKeys(value,['id','turn_id','action','create'])||value.create!=null&&typeof value.create!=='boolean'||value.id!=null&&!UUID.test(value.id)||value.turn_id!=null&&!UUID.test(value.turn_id)||!['message','resume'].includes(value.action??'message')||(value.action==='resume'&&(!value.id||!value.turn_id||value.create===true)))throw new AgentRuntimeError('invalid_conversation',400);
  return {...value,action:value.action??'message'};
}
export function createMemoryAgentStore(){
  const records=new Map();let serial=0;
  return {kind:'memory',async load(key){const record=records.get(key);return record?clone(record):null;},async write(key,value,etag){const previous=records.get(key);if((previous?.etag??null)!==(etag??null))return null;const result={value:clone(value),etag:String(++serial)};records.set(key,result);return clone(result);},async list(prefix,{limit,cursor}={}){if(cursor!=null&&!/^m:\d{1,7}$/.test(cursor))throw new AgentRuntimeError('invalid_conversation_cursor',400);const offset=cursor?Number(cursor.slice(2)):0,keys=[...records.keys()].filter(key=>key.startsWith(prefix)&&!key.slice(prefix.length).includes('/')).sort(),selected=keys.slice(offset,offset+limit),truncated=offset+selected.length<keys.length;return {keys:selected,cursor:truncated?`m:${offset+selected.length}`:null,truncated};}};
}
export function createR2AgentStore(bucket){return {kind:'r2',async load(key){const object=await bucket.get(key);if(!object)return null;if(object.size>MAX_RECORD_BYTES)throw new AgentRuntimeError('conversation_too_large',503);return {value:await object.json(),etag:object.etag};},async write(key,value,etag){const text=JSON.stringify(value);if(encoder.encode(text).byteLength>MAX_RECORD_BYTES)throw new AgentRuntimeError('conversation_too_large',503);const result=await bucket.put(key,text,{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},customMetadata:{kind:'private-agent-session',owner:String(value.owner??'')}});return result?{value:clone(value),etag:result.etag}:null;},async list(prefix,{limit,cursor}={}){if(typeof bucket.list!=='function')throw new AgentRuntimeError('conversation_list_unavailable',503);const page=await bucket.list({prefix,delimiter:'/',limit,...(cursor?{cursor}:{})});return {keys:(page.objects??[]).map(object=>object.key).filter(key=>typeof key==='string'&&key.startsWith(prefix)&&!key.slice(prefix.length).includes('/')).slice(0,limit),cursor:page.truncated&&typeof page.cursor==='string'?page.cursor:null,truncated:page.truncated===true};}};}
function defaultPlan(){return [
  {id:'scope',label:'确认当前数据与分析范围',resources:['catalog','status'],operation:'read_data',depends_on:[]},
  {id:'read',label:'读取问题所需证据',resources:[],operation:'read_data',depends_on:['scope']},
  {id:'present',label:'提交可复查的分析结果',resources:[],operation:'present',depends_on:['read']},
].map(step=>({...step,internal:true,status:'pending',detail:'',evidence_refs:[]}));}
function normalizeScope(value){
  if(value==null)return null;if(!ownKeys(value,Object.keys(AGENT_PLAN_SCOPE_PROPERTIES)))throw new AgentRuntimeError('invalid_task_plan',400);
  const result={};for(const [key,item] of Object.entries(value)){
    if(item==null)continue;const schema=AGENT_PLAN_SCOPE_PROPERTIES[key];
    if(schema.type==='string'&&(typeof item!=='string'||!item.length||item.length>(schema.maxLength??100)||schema.enum&&!schema.enum.includes(item)||schema.pattern&&!new RegExp(schema.pattern).test(item)||FORBIDDEN_SCOPE_KEYS.has(item)))throw new AgentRuntimeError('invalid_task_plan',400);
    if(schema.type==='integer'&&(!Number.isSafeInteger(item)||item<(schema.minimum??0)||item>(schema.maximum??Number.MAX_SAFE_INTEGER)))throw new AgentRuntimeError('invalid_task_plan',400);
    if(schema.type==='array'&&(!Array.isArray(item)||item.length>(schema.maxItems??12)||item.length<(schema.minItems??0)||schema.uniqueItems&&new Set(item).size!==item.length||item.some(entry=>typeof entry!=='string'||!entry.length||entry.length>(schema.items.maxLength??100)||schema.items.pattern&&!new RegExp(schema.items.pattern).test(entry)||FORBIDDEN_SCOPE_KEYS.has(entry))))throw new AgentRuntimeError('invalid_task_plan',400);
    result[key]=clone(item);
  }
  if(result.tick_from!=null&&result.tick_to!=null&&result.tick_to<result.tick_from)throw new AgentRuntimeError('invalid_task_plan',400);
  return Object.keys(result).length?result:null;
}
const planDefinition=step=>({id:step.id,label:step.label,resources:clone(step.resources),operation:step.operation??'read_data',depends_on:clone(step.depends_on??[]),scope:normalizeScope(step.scope)});
function planReadResources(step,index){
  if((step.operation??'read_data')!=='read_data'||step.resources.length)return step.resources;
  // Older statistics plans used [] as though computations had no resource.
  // Their declared section has exactly one server-side resource; preserve all
  // target fields and require a real, sealed computation to prove that read.
  if(statisticsSection(step.scope?.section))return ['analysis'];
  throw new AgentRuntimeError('invalid_task_plan',400,{issues:[{code:'read_resources_required',path:`steps.${index}.resources`,expected:'At least one read resource; statistics steps may use analysis.'}]});
}
function normalizedSteps(steps){
  if(Array.isArray(steps))for(const [index,item]of steps.entries())if(Array.isArray(item?.resources)){const resourceIndex=item.resources.findIndex(resource=>!QUERY_RESOURCES.includes(resource));if(resourceIndex>=0)throw new AgentRuntimeError('invalid_task_plan',400,{issues:[{code:'unknown_read_resource',path:`steps.${index}.resources.${resourceIndex}`,expected:'Use a declared query resource; statistics computations use analysis.'}]});}
  if(!Array.isArray(steps)||steps.length>10||steps.some(item=>!ownKeys(item,['id','label','resources','operation','depends_on','scope'])||!STEP.test(item.id??'')||typeof item.label!=='string'||!item.label.trim()||item.label.length>100||!Array.isArray(item.resources)||item.resources.some(resource=>!QUERY_RESOURCES.includes(resource))||new Set(item.resources).size!==item.resources.length||item.operation!=null&&!OPERATIONS.includes(item.operation)||item.operation!=null&&item.operation!=='read_data'&&(item.resources.length>0||item.scope!=null)||item.depends_on!=null&&(!Array.isArray(item.depends_on)||item.depends_on.length>9||item.depends_on.some(id=>typeof id!=='string'||!STEP.test(id))||new Set(item.depends_on).size!==item.depends_on.length))||new Set(steps.map(item=>item.id)).size!==steps.length)throw new AgentRuntimeError('invalid_task_plan',400);
  return steps.map((item,index)=>{const definition=planDefinition(item);definition.resources=clone(planReadResources(definition,index));if(statisticsSection(definition.scope?.section)&&(definition.resources.length!==1||definition.resources[0]!=='analysis'))throw new AgentRuntimeError('invalid_task_plan',400,{issues:[{code:'statistics_resource_required',path:`steps.${index}.resources`,expected:'Statistics computations use only the analysis resource.'}]});if(definition.scope?.dataset&&!statisticsSection(definition.scope.section))throw new AgentRuntimeError('invalid_task_plan',400,{issues:[{code:'statistics_section_required',path:`steps.${index}.scope.dataset`,expected:'dataset requires local_statistics or local_statistics_catalog.'}]});return {...definition,definition_revision:1,status:'pending',detail:'',evidence_refs:[]};});
}
function validateDependencies(plan){
  const byId=new Map(plan.map(step=>[step.id,step])),visiting=new Set(),visited=new Set();
  function visit(id){if(visiting.has(id))throw new AgentRuntimeError('task_plan_cycle',400);if(visited.has(id))return;const item=byId.get(id);if(!item)throw new AgentRuntimeError('task_plan_dependency_missing',400);visiting.add(id);for(const dependency of item.depends_on??[])visit(dependency);visiting.delete(id);visited.add(id);}
  for(const step of plan)visit(step.id);
}
function editedPlan(previous,args){
  if(!plainValues(args)||!ownKeys(args,['action','step_id','steps'])||!PLAN_ACTIONS.includes(args.action)||!Array.isArray(args.steps)||args.steps.length>10||args.step_id!=null&&!STEP.test(args.step_id))throw new AgentRuntimeError('invalid_task_plan',400);
  const steps=normalizedSteps(args.steps);let next=clone(previous),changed=[];
  if(['set','append','revise','reorder'].includes(args.action)){
    if(!steps.length||args.step_id!=null)throw new AgentRuntimeError('invalid_task_plan',400);
    const byId=new Map(previous.map(step=>[step.id,step]));changed=steps.map(step=>step.id);
    if(args.action==='set')next=steps.map(step=>({...step,definition_revision:(byId.get(step.id)?.definition_revision??0)+1}));
    else if(args.action==='append'){if(steps.some(step=>byId.has(step.id))||previous.length+steps.length>10)throw new AgentRuntimeError('invalid_task_plan',400);next.push(...steps);}
    else if(args.action==='revise'){if(steps.some(step=>!byId.has(step.id)))throw new AgentRuntimeError('invalid_task_plan',400);const replacements=new Map(steps.map(step=>[step.id,{...step,definition_revision:(byId.get(step.id).definition_revision??0)+1}]));next=next.map(step=>replacements.get(step.id)??step);}
    else{if(steps.length!==previous.length||steps.some(step=>!byId.has(step.id)||JSON.stringify(planDefinition(step))!==JSON.stringify(planDefinition(byId.get(step.id)))))throw new AgentRuntimeError('invalid_task_plan',400);next=steps.map(step=>clone(byId.get(step.id)));}
  }else{
    if(steps.length)throw new AgentRuntimeError('invalid_task_plan',400);const step=next.find(step=>step.id===args.step_id);if(!step)throw new AgentRuntimeError('invalid_task_plan',400);changed=[step.id];
    if(args.action==='activate'){delete step.disposition;step.requested_active=true;}
    else{if(step.status==='complete')throw new AgentRuntimeError('task_plan_step_complete',400);step.disposition=args.action==='defer'?'deferred':'cancelled';delete step.requested_active;}
  }
  return {plan:next,changed};
}
function statisticsObservation(turn,{query,result}){
  if(query?.resource!=='analysis'||!statisticsSection(query.section)||!/^[a-f0-9]{64}$/.test(query.metric??'')||!result||result.error||result.available===false||['unavailable','not_rendered'].includes(result.state)||result.resource!==(query.section==='local_statistics'?'statistics_compute':'statistics_catalog')||result.statistics_request_sha256!==query.metric||canonical(result.query_input??{})!==canonical(query)||!plainValues(result.source)||!sameSource(safeSource(result.source),turn.source))return null;
  const spec=result.statistics_query;if(!plainValues(spec)||!AGENT_PLAN_SCOPE_PROPERTIES.dataset.enum.includes(spec.dataset)||spec.scope!=null&&!['round','match'].includes(spec.scope)||spec.path!=null&&(typeof spec.path!=='string'||!/^[$A-Za-z0-9_:-]+(?:\.[$A-Za-z0-9_:-]+)*$/.test(spec.path)))return null;
  try{return normalizeScope({dataset:spec.dataset,...(spec.scope!=null?{scope:spec.scope}:{}),...(spec.path!=null?{path:spec.path.split('.')}:{} )});}catch{return null;}
}
function noteObservedRead(turn,query,reference,statistics=null){
  if(typeof reference!=='string'||!reference.length||reference.length>240)return;
  const clean=publicQuery(query);
  if(!Array.isArray(turn.plan_observations))turn.plan_observations=[];
  const previous=turn.plan_observations.find(entry=>entry.reference===reference);if(previous){if(statistics&&canonical(previous.query)===canonical(clean))previous.statistics=clone(statistics);return;}
  turn.plan_observation_sequence=(turn.plan_observation_sequence??0)+1;
  turn.plan_observations.push({query:clean,reference,sequence:turn.plan_observation_sequence,...(statistics?{statistics:clone(statistics)}:{})});
  if(turn.plan_observations.length>128){const recent=[...turn.plan_observations].reverse(),keep=new Set();for(const resource of QUERY_RESOURCES){const found=recent.find(entry=>entry.query.resource===resource);if(found)keep.add(found);}for(const step of turn.plan??[])for(const resource of step.resources??[]){const found=recent.find(entry=>entry.query.resource===resource&&matchesScope(entry.query,step.scope,entry.statistics));if(found)keep.add(found);}for(const entry of recent.slice(0,128))if(keep.size<384)keep.add(entry);turn.plan_observations=turn.plan_observations.filter(entry=>keep.has(entry));}
}
function replayObservedReads(turn){
  // A late plan may acknowledge a successful current-source read. Failed
  // outputs are never observations; resource completion is not full pagination.
  for(const entry of (turn.work.queries??[]).slice(-128))if(entry.result&&typeof entry.result==='object'&&!entry.result.error)noteObservedRead(turn,entry.query??entry.input,entry.reference);
}
function matchesScope(query,scope,statistics){
  if(statisticsSection(query.section)&&!statistics)return false;
  const target={...(statistics??{}),...query};
  // The global raw dataset directory always returns its entire fixed catalog;
  // offset/limit do not page this operation. They must not block a truthful
  // dependency merely because the model chose a different unused page size.
  // Match-specific field discovery and all row reads retain exact targets.
  const directory=query.resource==='raw_schema'&&!query.match_id&&!query.raw_dataset&&!scope?.match_id&&!scope?.raw_dataset;
  return !scope||Object.entries(scope).every(([key,value])=>directory&&['offset','limit'].includes(key)||JSON.stringify(target[key])===JSON.stringify(value));
}
function dependencySignature(step,turn,byId){
  const ids=new Set();function visit(item){for(const id of item.depends_on??[])if(!ids.has(id)){ids.add(id);visit(byId.get(id));}}visit(step);
  return JSON.stringify({generation:turn.generation??0,definition_revision:step.definition_revision??0,dependencies:[...ids].sort().map(id=>{const item=byId.get(id);return {id,revision:item.definition_revision??0,observed:item.observation_sequence??0,visual_check:turn.visual_proofs?.[id]?.check_sequence??0};})});
}
function refreshPlan(turn,{terminal=false}={}){
  // Derive states topologically from evidence and explicit disposition. A
  // submitted report cannot fill missing reads or bypass an unmet dependency.
  const observations=Array.isArray(turn.plan_observations)?turn.plan_observations:[],byId=new Map(turn.plan.map(step=>[step.id,step])),visited=new Set();
  function refresh(item){
    if(visited.has(item.id))return;for(const id of item.depends_on??[])refresh(byId.get(id));visited.add(item.id);
    item.operation??='read_data';item.depends_on??=[];
    const resources=item.internal===true&&item.id==='read'?[...new Set(observations.map(entry=>entry.query.resource))].filter(resource=>!['catalog','status'].includes(resource)):item.resources;
    const matches=item.operation==='read_data'?observations.filter(entry=>resources.includes(entry.query.resource)&&matchesScope(entry.query,item.scope,entry.statistics)):[];
    item.read_resources=[...new Set(matches.map(entry=>entry.query.resource))];item.evidence_refs=matches.map(entry=>entry.reference).slice(-8);item.observation_sequence=matches.reduce((highest,entry)=>Math.max(highest,entry.sequence),0);
    item.failure_codes=item.operation==='read_data'?(Array.isArray(turn.plan_failures)?turn.plan_failures:[]).filter(entry=>resources.includes(entry.resource)&&!item.read_resources.includes(entry.resource)&&(!item.scope||entry.query&&matchesScope(entry.query,item.scope))).map(({resource,code})=>({resource,code})):[];
    item.blocked_by=item.depends_on.filter(id=>byId.get(id).status!=='complete');
    const proven=item.operation==='read_data'?resources.length>0&&resources.every(resource=>item.read_resources.includes(resource)):item.operation==='validate_visual'?turn.visual_proofs?.[item.id]?.signature===dependencySignature(item,turn,byId):turn.presentation_validated===true;
    if(['deferred','cancelled'].includes(item.disposition)){item.status=item.disposition;item.readiness=item.disposition;item.detail=item.disposition==='deferred'?'此步骤已暂缓，尚未作为完成操作':'此步骤已取消，未将其计入完成操作';}
    else if(item.blocked_by.length){item.status='blocked';item.readiness='blocked';item.detail='等待依赖步骤完成';}
    else if(proven){item.status='complete';item.readiness='complete';item.detail=item.operation==='read_data'?`已实际读取 ${item.evidence_refs.length} 项证据`:item.operation==='validate_visual'?'交互文档已通过实际校验':'已提交通过校验的分析';}
    else if(terminal){item.status='blocked';item.readiness='blocked';item.detail='本轮结果仅覆盖已完成操作，此步骤仍缺少实际执行证据';}
    else if(item.failure_codes.length){item.status='blocked';item.readiness='ready';item.detail='所需数据读取失败；可在可用时重新尝试，未计入完成';}
    else{item.status=item.requested_active===true||item.read_resources.length>0||item.operation==='validate_visual'&&turn.visual_check_attempted===true?'active':'pending';item.readiness='ready';item.detail=item.read_resources.length?`已读取 ${item.read_resources.length}/${resources.length} 类所需数据`:item.operation==='validate_visual'&&turn.visual_check_attempted===true?'文档预检未通过，待修复':'';}
  }
  for(const step of turn.plan)refresh(step);
}
function recordVisualCheck(turn,valid){
  refreshPlan(turn);turn.visual_validated=valid===true;turn.visual_check_attempted=true;turn.visual_check_sequence=(turn.visual_check_sequence??0)+1;turn.visual_proofs??={};
  const byId=new Map(turn.plan.map(step=>[step.id,step])),ordered=[],visited=new Set();
  function visit(step){if(visited.has(step.id))return;visited.add(step.id);for(const id of step.depends_on??[])visit(byId.get(id));ordered.push(step);}for(const step of turn.plan)visit(step);
  const eligible=ordered.filter(step=>step.operation==='validate_visual'&&!step.blocked_by.length&&!step.disposition);
  if(!valid)turn.visual_proofs={};else for(const step of eligible)turn.visual_proofs[step.id]={signature:dependencySignature(step,turn,byId),check_sequence:turn.visual_check_sequence};
  refreshPlan(turn);
}
function planOverview(turn){const plan=turn.plan??[];return {total:plan.length,completed:plan.filter(step=>step.status==='complete').length,ready_step_ids:plan.filter(step=>step.readiness==='ready').map(step=>step.id),blocked_step_ids:plan.filter(step=>step.status==='blocked').map(step=>step.id),deferred_step_ids:plan.filter(step=>step.status==='deferred').map(step=>step.id),cancelled_step_ids:plan.filter(step=>step.status==='cancelled').map(step=>step.id),partial:turn.status==='completed'&&plan.some(step=>step.status!=='complete')};}
function planRevision(turn,action,ids,stamp){turn.plan_revision=(turn.plan_revision??0)+1;turn.plan_revisions=[...(turn.plan_revisions??[]),{revision:turn.plan_revision,action,step_ids:clone(ids),generation:turn.generation??0,at:new Date(stamp).toISOString(),steps:turn.plan.map(planDefinition)}].slice(-MAX_PLAN_REVISIONS);}
function summarize(turn){return {id:turn.id,question:turn.question,context:clone(turn.context??{}),source:turn.source,status:turn.status,observed_queries:(turn.work?.queries??[]).slice(-24).map(entry=>({query:clone(entry.query),reference:entry.reference})),summary:turn.result?{headline:turn.result.analysis?.headline??'',summary:turn.result.analysis?.summary??'',findings:(turn.result.analysis?.findings??[]).map(item=>({title:item.title,assessment:item.assessment,evidence_refs:item.evidence_refs})),limitations:turn.result.analysis?.limitations??[]}:null};}
function turnPublic(record,{sourceChanged=false,currentSource=null,storage='memory',stamp=Date.now()}={}){const turn=record.turn;return {
  session:{id:record.id,turn_id:turn.id,revision:record.revision,source_changed:sourceChanged,can_resume:turn.status==='awaiting_continuation'||turn.status==='running'&&turn.lease_until<=stamp||canResumeProviderFailure(turn),storage},
  task:{id:turn.id,status:turn.status,goal:turn.question,mode:turn.task?.mode,context:clone(turn.context),source:clone(turn.source),plan:clone(turn.plan),plan_revision:turn.plan_revision??0,plan_revisions:clone(turn.plan_revisions??[]),plan_overview:planOverview(turn),workflow:projectAgentWorkflow(turn),provider_trace:publicProviderReasoning(turn.provider_trace),events:clone(turn.events??[]),activity:clone(turn.activity??[]),activity_truncated:turn.activity_truncated===true,stage_artifact:currentSource&&!sameSource(turn.source,safeSource(currentSource))?null:clone(turn.stage_artifact??null),coverage:coverageState(turn),provider_status:providerState(turn),recovery:recoveryState(turn),progress:{model_calls:turn.progress.model_calls,reads:turn.progress.reads,windows:turn.progress.windows},checkpoint:{sequence:turn.sequence,generation:turn.generation??0},...(turn.pause_reason?{pause_reason:turn.pause_reason}:{}),...(turn.error?{error:turn.error}:{})},
};}
export function createAgentRuntime({store=createMemoryAgentStore(),owner,now=()=>Date.now(),newId=()=>crypto.randomUUID()}={}){
  const backing=store;let storageOperations=0;const storageCall=async(method,args)=>{storageOperations++;try{return await backing[method](...args);}catch(error){if(error instanceof AgentRuntimeError)throw error;throw new AgentRuntimeError('conversation_storage_unavailable',503);}};store={...backing,load:(...args)=>storageCall('load',args),write:(...args)=>storageCall('write',args),...(backing.list?{list:(...args)=>storageCall('list',args)}:{})};
  const prefix=root(owner),key=id=>`${prefix}sessions/${id}.json`,archive=(id,turnId)=>`${prefix}sessions/${id}/turns/${turnId}.json`;
  async function load(id){if(!UUID.test(id??''))throw new AgentRuntimeError('invalid_conversation',400);const found=await store.load(key(id));if(!found)throw new AgentRuntimeError('conversation_not_found',404);validateRecord(found.value,owner,id);return found;}
  async function archivedTurn(record,turnId){
    if(!UUID.test(turnId??''))throw new AgentRuntimeError('invalid_turn',400);
    const found=await store.load(archive(record.id,turnId));if(!found)throw new AgentRuntimeError('turn_not_found',404);const value=found.value,turn=value?.turn;
    // Older archives predate session_id; their exact owner/session path and
    // requested turn identity remain authoritative. New writes bind both IDs.
    if(value?.version!==AGENT_RUNTIME_VERSION||value.owner!==owner||value.session_id!=null&&value.session_id!==record.id||turn?.id!==turnId||!UUID.test(turn?.id??'')||!plainValues(turn.source)||!ownKeys(turn.source,['source_revision','generated_at','content_sha256'])||!plainValues(turn.progress)||!['running','awaiting_continuation','completed','failed'].includes(turn.status))throw new AgentRuntimeError('conversation_invalid',503);
    if(turn.status==='completed'&&(turn.result?.session?.id!==record.id||turn.result.session.turn_id!==turnId||turn.result.task?.id!==turnId||!sameSource(safeSource(turn.result.task?.source),safeSource(turn.source))))throw new AgentRuntimeError('conversation_invalid',503);
    return turn;
  }
  async function read(id,currentSource,{turnId}={}){
    const found=await load(id),record=found.value;
    if(turnId!=null&&!UUID.test(turnId))throw new AgentRuntimeError('invalid_turn',400);
    const historical=turnId!=null&&turnId!==record.turn.id,turn=historical?await archivedTurn(record,turnId):record.turn,status=turn.status;
    const state=turnPublic({...record,turn},{sourceChanged:currentSource?!sameSource(turn.source,safeSource(currentSource)):false,currentSource,storage:store.kind,stamp:now()});
    if(historical){state.session.current_turn_id=record.turn.id;state.session.can_resume=false;state.task.recovery.can_auto_continue=false;}
    return {version:AGENT_RUNTIME_VERSION,status:status==='completed'?'complete':status,...state,...(historical?{historical:true,read_only:true}:{}),...(status==='completed'&&turn.result?{result:clone(turn.result)}:{})};
  }
  const cacheableStatistics=(ref,detail)=>/^[a-f0-9]{64}$/.test(ref?.content_sha256??'')&&/^[a-f0-9]{40,64}$/.test(ref?.source_revision??'')&&ref.match_id===detail?.match_id&&ref.source_revision===detail?.source_revision&&/^[a-f0-9]{64}$/.test(detail?.content_sha256??'');
  const statisticsCachePath=async(ref,detail)=>prefix+'statistics/v1/'+await dataHash({statistics_ref:ref,detail_ref:detail})+'.json';
  async function loadStatisticsPack(ref,detail){
    if(!cacheableStatistics(ref,detail))return null;const found=await store.load(await statisticsCachePath(ref,detail));if(!found)return null;const {sha256,...value}=found.value;
    if(value.version!==AGENT_RUNTIME_VERSION||value.owner!==owner||canonical(value.statistics_ref??{})!==canonical(ref)||canonical(value.detail_ref??{})!==canonical(detail)||sha256!==await dataHash(value)||value.pack?.match_id!==ref.match_id||canonical(value.pack.statistics_ref??{})!==canonical(ref)||canonical(value.pack.detail_ref??{})!==canonical(detail))throw new AgentRuntimeError('statistics_cache_invalid',503);return clone(value.pack);
  }
  async function readQuery(id,currentSource,{turnId,reference}={}){
    const record=(await load(id)).value;if(!UUID.test(turnId??''))throw new AgentRuntimeError('invalid_turn',400);
    const historical=turnId!==record.turn.id,turn=historical?await archivedTurn(record,turnId):record.turn,generation=turn.generation??0,refPrefix=`turn:${turn.id}:g${generation}:query:`;
    // Only an exact immutable query reference may select a storage object.
    // Entity aliases and old source generations require their archived turn;
    // viewing evidence never acquires a lease or replays a data/model query.
    if(typeof reference!=='string'||reference.length>240||!reference.startsWith(refPrefix)||!/^[1-9]\d*$/.test(reference.slice(refPrefix.length))||!Number.isSafeInteger(Number(reference.slice(refPrefix.length))))throw new AgentRuntimeError('invalid_query_reference',400);
    const found=await store.load(`${prefix}sessions/${record.id}/reads/${turn.id}/g${generation}/${reference.slice(refPrefix.length)}.json`);if(!found)throw new AgentRuntimeError('query_archive_not_found',404);if(!plainValues(found.value))throw new AgentRuntimeError('query_archive_invalid',503);
    const {sha256,...entry}=found.value;
    if(entry.version!==AGENT_RUNTIME_VERSION||entry.owner!==owner||entry.session_id!==record.id||entry.turn_id!==turn.id||entry.generation!==generation||!plainValues(entry.source)||!sameSource(safeSource(entry.source),safeSource(turn.source))||sha256!==await dataHash(entry)||entry.reference!==reference||!plainValues(entry.result))throw new AgentRuntimeError('query_archive_invalid',503);
    if(entry.result.source!=null&&!sameSource(safeSource(entry.result.source),safeSource(turn.source)))throw new AgentRuntimeError('query_archive_invalid',503);
    if(entry.result.statistics_pack?.statistics_cache){const {statistics_cache}=entry.result.statistics_pack;if(entry.query?.resource!=='rounds'||entry.query.match_id!==statistics_cache.statistics_ref?.match_id)throw new AgentRuntimeError('query_archive_invalid',503);const pack=await loadStatisticsPack(statistics_cache.statistics_ref,statistics_cache.detail_ref);if(!pack)throw new AgentRuntimeError('query_archive_invalid',503);entry.result.statistics_pack=pack;}
    if(entry.result_sha256!==await dataHash(JSON.stringify(entry.result)))throw new AgentRuntimeError('query_archive_invalid',503);
    let query;try{query=publicQuery(entry.query);}catch{throw new AgentRuntimeError('query_archive_invalid',503);}
    const stale=currentSource?!sameSource(safeSource(turn.source),safeSource(currentSource)):false;
    return {version:AGENT_RUNTIME_VERSION,status:'complete',read_only:true,historical,stale,session:{id:record.id,turn_id:turn.id,current_turn_id:record.turn.id,generation,source_changed:stale,can_resume:false,storage:store.kind},source:clone(turn.source),query,query_ref:reference,result:{...clone(entry.result),query_evidence_ref:reference}};
  }
  function historyItem(turn,record,currentSource){const historical=turn.id!==record.turn.id;return {turn_id:turn.id,question:turn.question,status:turn.status,source:clone(turn.source),context:clone(turn.context??{}),mode:turn.task?.mode??turn.mode??null,summary:clone(turn.summary??summarize(turn).summary),stale:currentSource?!sameSource(turn.source,safeSource(currentSource)):false,historical,read_only:historical};}
  const historyCursor=value=>btoa(JSON.stringify(value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  function parseHistoryCursor(value,id){
    try{
      if(typeof value!=='string'||!value.length||value.length>8192||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
      const cursor=JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')));
      if(!ownKeys(cursor,['id','phase','offset','exclude','archive_cursor'])||cursor.id!==id||!['recent','archive'].includes(cursor.phase)||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>RECENT_TURNS+1||!Array.isArray(cursor.exclude)||cursor.exclude.length>RECENT_TURNS+1||cursor.exclude.some(item=>!UUID.test(item))||new Set(cursor.exclude).size!==cursor.exclude.length||cursor.archive_cursor!=null&&(typeof cursor.archive_cursor!=='string'||!cursor.archive_cursor.length||cursor.archive_cursor.length>4096||!/^[\x21-\x7e]+$/.test(cursor.archive_cursor)))throw Error();
      return cursor;
    }catch{throw new AgentRuntimeError('invalid_history_cursor',400);}
  }
  async function history(id,{limit=9,cursor=null}={},currentSource){
    if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new AgentRuntimeError('invalid_history_limit',400);
    const record=(await load(id)).value,recent=[...record.recent_turns,record.turn].reverse(),state=cursor==null?{id,phase:'recent',offset:0,exclude:recent.map(turn=>turn.id),archive_cursor:null}:parseHistoryCursor(cursor,id);let items=[],next=null;
    if(state.phase==='recent'){
      // Freeze the recent IDs in the cursor: another browser may advance this
      // conversation while its history is being paged. Resolve shifted entries
      // by their exact archive instead of repeating or losing a turn.
      for(const turnId of state.exclude.slice(state.offset,state.offset+limit)){const turn=recent.find(item=>item.id===turnId)??await archivedTurn(record,turnId);items.push(historyItem(turn,record,currentSource));}const offset=state.offset+items.length;
      if(offset<state.exclude.length)next=historyCursor({...state,offset});
      else if(typeof store.list==='function')next=historyCursor({...state,phase:'archive',offset:0});
    }else{
      if(typeof store.list!=='function')throw new AgentRuntimeError('conversation_list_unavailable',503);
      const turnsPrefix=`${prefix}sessions/${id}/turns/`,page=await store.list(turnsPrefix,{limit,...(state.archive_cursor?{cursor:state.archive_cursor}:{})});
      // Read at most one bounded archive page, skipping the recent window
      // already returned. Do not scan raw report/query storage to fill a page.
      for(const path of page.keys.slice(0,limit)){if(!path.startsWith(turnsPrefix)||!path.endsWith('.json'))continue;const turnId=path.slice(turnsPrefix.length,-5);if(!UUID.test(turnId)||state.exclude.includes(turnId))continue;const turn=await archivedTurn(record,turnId);items.push(historyItem(turn,record,currentSource));}
      if(page.truncated&&typeof page.cursor==='string')next=historyCursor({...state,archive_cursor:page.cursor});
    }
    return {version:AGENT_RUNTIME_VERSION,session:{id:record.id,current_turn_id:record.turn.id,revision:record.revision,storage:store.kind},history:{items,pagination:{limit,cursor:next,truncated:next!==null},ordering:'recent_then_archive_pages'}};
  }
  async function list({limit=20,cursor=null}={},currentSource){
    if(!Number.isInteger(limit)||limit<1||limit>20)throw new AgentRuntimeError('invalid_conversation_limit',400);
    if(cursor!=null&&(typeof cursor!=='string'||!cursor.length||cursor.length>4096||!/^[\x21-\x7e]+$/.test(cursor)))throw new AgentRuntimeError('invalid_conversation_cursor',400);
    if(typeof store.list!=='function')throw new AgentRuntimeError('conversation_list_unavailable',503);
    const sessionsPrefix=`${prefix}sessions/`,page=await store.list(sessionsPrefix,{limit,cursor}),conversations=[];
    for(const entry of page.keys.slice(0,limit)){
      if(!entry.startsWith(sessionsPrefix)||!entry.endsWith('.json'))continue;const id=entry.slice(sessionsPrefix.length,-5);if(!UUID.test(id))continue;
      // Read no more than one metadata object per listed session. Never scan
      // turn archives or project data, and never include an unvalidated result.
      let found;try{found=await load(id);}catch{continue;}const record=found.value,{session,task}=turnPublic(record,{sourceChanged:currentSource?!sameSource(record.turn.source,safeSource(currentSource)):false,storage:store.kind,stamp:now()});
      conversations.push({session,task:{id:task.id,status:task.status,goal:task.goal,mode:task.mode,context:task.context,source:task.source},updated_at:record.updated_at??record.created_at});
    }
    conversations.sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))||a.session.id.localeCompare(b.session.id));
    return {version:AGENT_RUNTIME_VERSION,conversations,cursor:page.cursor??null,truncated:page.truncated===true,ordering:'page_updated_desc'};
  }
  async function begin({conversation,question,context={},task={},source={}}){
    storageOperations=0;
    const spec=parseAgentConversation(conversation),stamp=now(),currentSource=safeSource(source);let record,etag=null,sourceChanged=false,existing=false,manualProviderRetry=null;
    if(spec.id){let found;try{found=await load(spec.id);}catch(error){if(error.code!=='conversation_not_found'||spec.create!==true||spec.action!=='message')throw error;}if(found){record=found.value;etag=found.etag;
      if(spec.turn_id&&spec.turn_id!==record.turn.id){
        const old=await store.load(archive(record.id,spec.turn_id));if(old){if(old.value.owner!==owner||old.value.version!==AGENT_RUNTIME_VERSION||old.value.turn?.id!==spec.turn_id)throw new AgentRuntimeError('conversation_invalid',503);if(spec.action==='message'&&old.value.turn.question!==question)throw new AgentRuntimeError('turn_id_conflict');if(old.value.turn.status==='failed')throw new AgentRuntimeError('turn_failed');const archivedPublic=()=>{const value=turnPublic({...record,turn:old.value.turn},{sourceChanged:!sameSource(old.value.turn.source,currentSource),storage:store.kind,stamp:now()});value.session.can_resume=false;value.task.recovery.can_auto_continue=false;return value;};return {existing:true,result:clone(old.value.turn.result??{status:old.value.turn.status,analysis:null}),public:archivedPublic};}
        if(spec.action==='resume')throw new AgentRuntimeError('turn_not_found',404);
      }
      const sameTurn=spec.turn_id===record.turn.id;
      if(sameTurn&&spec.action==='message'&&question!==record.turn.question)throw new AgentRuntimeError('turn_id_conflict');
      if(sameTurn&&record.turn.status==='completed')return {existing:true,result:clone(record.turn.result),public:()=>turnPublic(record,{sourceChanged:!sameSource(record.turn.source,currentSource),storage:store.kind,stamp:now()})};
      if(record.turn.status==='running'&&record.turn.lease_until>stamp)throw new AgentRuntimeError('analysis_in_progress');
      if(spec.action==='resume'||sameTurn){
        if(record.turn.status==='failed'){
          if(spec.action!=='resume'||!canResumeProviderFailure(record.turn))throw new AgentRuntimeError('turn_failed');
          manualProviderRetry={code:record.turn.error,failed_at:record.updated_at??null,resumed_at:new Date(stamp).toISOString(),generation:record.turn.generation??0,progress:clone(record.turn.progress)};
        }
        existing=true;
      }
      else{
        if(record.turn.status==='running')throw new AgentRuntimeError('continuation_required');
        const archived={version:AGENT_RUNTIME_VERSION,owner,session_id:record.id,turn:clone(record.turn)};
        const archivedWrite=await store.write(archive(record.id,record.turn.id),archived,null);if(!archivedWrite){const existingArchive=await store.load(archive(record.id,record.turn.id)),old=existingArchive?.value;if(old?.version!==archived.version||old.owner!==owner||old.session_id!=null&&old.session_id!==record.id||JSON.stringify(old.turn)!==JSON.stringify(archived.turn))throw new AgentRuntimeError('conversation_archive_unavailable',503);}
        record.recent_turns.push(summarize(record.turn));record.recent_turns=record.recent_turns.slice(-RECENT_TURNS);record.turn=null;
      }
    }}
    if(!record){if(spec.action==='resume')throw new AgentRuntimeError('invalid_conversation',400);record={version:AGENT_RUNTIME_VERSION,owner,id:spec.id??newId(),revision:0,created_at:new Date(stamp).toISOString(),recent_turns:[],turn:null};}
    if(!record.turn){record.turn={id:spec.turn_id??newId(),question,context:clone(context),task:clone(task),source:currentSource,status:'running',sequence:0,generation:0,events:[],progress:{model_calls:0,reads:0,windows:0},plan:defaultPlan(),plan_revision:0,plan_revisions:[],plan_observations:[],work:{queries:[],tool_errors:[],visual_repair_used:false,format_repair_used:false,force_final:false},result:null};}
    else if(!sameSource(record.turn.source,currentSource)){
      sourceChanged=true;const previousUsage=record.turn.work.usage;record.turn.work={queries:[],tool_errors:[],visual_repair_used:false,format_repair_used:false,force_final:false,...(previousUsage?{usage:{...previousUsage,tool_bytes:0}}:{})};record.turn.source=currentSource;record.turn.generation=(record.turn.generation??0)+1;record.turn.events=[];record.turn.visual_validated=false;record.turn.visual_check_attempted=false;record.turn.visual_proofs={};record.turn.presentation_validated=false;record.turn.plan_observations=[];record.turn.plan_failures=[];record.turn.plan=(record.turn.plan??defaultPlan()).map(step=>({...planDefinition(step),definition_revision:step.definition_revision??0,...(step.internal?{internal:true}:{}),...(['deferred','cancelled'].includes(step.disposition)?{disposition:step.disposition}:{}),status:'pending',detail:'来源已更新，需要重新读取或验证',evidence_refs:[],read_resources:[],blocked_by:[],readiness:'ready'}));planRevision(record.turn,'source_changed',record.turn.plan.map(step=>step.id),stamp);record.turn.sequence++;record.turn.source_changed=true;
    }
    if(sourceChanged){record.turn.activity=[];record.turn.activity_truncated=(record.turn.activity_sequence??0)>0;record.turn.stage_artifact=null;delete record.turn.repair_milestones;delete record.turn.provider_trace;delete record.turn.last_activity_phase;delete record.turn.last_activity_plan_revision;}
    record.turn.plan??=defaultPlan();const migrated=[];for(const step of record.turn.plan){step.depends_on??=[];step.operation??=step.id==='verify'?'validate_visual':step.id==='present'?'present':'read_data';if(step.operation==='read_data'&&!step.resources.length&&statisticsSection(step.scope?.section)){step.resources=['analysis'];step.definition_revision=(step.definition_revision??0)+1;migrated.push(step.id);}}if(migrated.length)planRevision(record.turn,'revise',migrated,stamp);validateDependencies(record.turn.plan);replayObservedReads(record.turn);refreshPlan(record.turn);
    record.turn.query_sequence??=Math.max(0,...(record.turn.work?.queries??[]).map(entry=>Number(/:query:(\d+)$/.exec(entry.reference??'')?.[1])||0));record.turn.query_success_sequence??=record.turn.work?.queries?.length??0;
    if(sourceChanged){record.turn.query_sequence=0;record.turn.query_success_sequence=0;record.turn.stage_revision=0;delete record.turn.last_stage_signature;delete record.turn.bulk_query_cache;delete record.turn.bulk_source_refs;}
    if(manualProviderRetry){
      // Keep the original failure as well as bounded recent attempts. Static
      // metadata only: no upstream body, provider messages, or reasoning.
      const previous=record.turn.provider_retry_audit??{count:0,recent:[]},count=previous.count+1;
      record.turn.provider_retry_audit={count,first:previous.first??clone(manualProviderRetry),recent:[...previous.recent,manualProviderRetry].slice(-8),truncated:count>8};
      appendActivity(record.turn,{kind:'phase',phase:'repairing',name:'manual_provider_resume',status:'started',message:'已按用户操作继续原任务，提供方失败记录已保留。'},stamp);
    }
    record.turn.window_progress_start=progressSignature(record.turn);record.turn.window_activity_start=record.turn.activity_sequence??0;record.turn.retry_after_ms=0;record.turn.status='running';record.turn.pause_reason=null;record.turn.error=null;record.turn.lease_until=stamp+LEASE_MS;record.turn.progress.windows++;record.revision++;record.updated_at=new Date(stamp).toISOString();
    let written=await store.write(key(record.id),record,etag);if(!written)throw new AgentRuntimeError('analysis_in_progress');etag=written.etag;
    async function save(){record.revision++;record.updated_at=new Date(now()).toISOString();const written=await store.write(key(record.id),record,etag);if(!written)throw new AgentRuntimeError('conversation_conflict');etag=written.etag;}
    const publicState=()=>turnPublic(record,{sourceChanged:sourceChanged||record.turn.source_changed===true,currentSource,storage:store.kind,stamp:now()});
    const readBase=`${prefix}sessions/${record.id}/reads/${record.turn.id}/g${record.turn.generation??0}/`;
    const archiveScope={version:AGENT_RUNTIME_VERSION,owner,session_id:record.id,turn_id:record.turn.id,generation:record.turn.generation??0,source:clone(record.turn.source)};
    const validScope=value=>value?.version===AGENT_RUNTIME_VERSION&&value.owner===owner&&value.session_id===record.id&&value.turn_id===record.turn.id&&value.generation===(record.turn.generation??0)&&sameSource(safeSource(value.source),record.turn.source);
    async function sealedWrite(path,payload,etag=null){const value={...archiveScope,...payload},digest=await dataHash(value);return store.write(path,{...value,sha256:digest},etag);}
    async function sealedLoad(path){const found=await store.load(path);if(!found)return null;const {sha256,...value}=found.value;if(!validScope(value)||sha256!==await dataHash(value))throw new AgentRuntimeError('query_archive_invalid',503);return {...found,value};}
    // Four hash branches batch every page's aliases into a handful of writes.
    // Split growing branches before they can grow into another session-sized
    // object. An entity alias keeps its first page and records ambiguity; it
    // can never silently move a visualization from its old page to a new one.
    const refBranch=(hash,depth)=>String(parseInt(hash.slice(depth,depth+1),16)%4);
    async function indexAliases(entries,path='refs/',depth=0){
      let newFacts=0;
      const groups=new Map();for(const entry of entries){const branch=refBranch(entry.hash,depth);if(!groups.has(branch))groups.set(branch,[]);groups.get(branch).push(entry);}
      for(const [branch,items]of groups){const indexPath=readBase+path+branch+'.json',old=await sealedLoad(indexPath),node=old?.value;
        if(node?.split){newFacts+=await indexAliases(items,path+branch+'/',depth+1);continue;}
        const aliases={...(node?.aliases??{})};for(const {hash,ref,reference,ambiguous=false,fact=false}of items){const previous=aliases[hash];if(previous&&previous.ref!==ref)throw new AgentRuntimeError('query_archive_conflict',503);if(fact&&!previous)newFacts++;aliases[hash]=previous?{...previous,ambiguous:ambiguous||previous.ambiguous||previous.reference!==reference}:{ref,reference,ambiguous};}
        if(encoder.encode(JSON.stringify(aliases)).byteLength>64*1024&&depth<31){const all=Object.entries(aliases).map(([hash,item])=>({hash,...item}));await indexAliases(all,path+branch+'/',depth+1);if(!await sealedWrite(indexPath,{split:true},old?.etag??null))throw new AgentRuntimeError('query_archive_conflict',503);}
        else if(!await sealedWrite(indexPath,{aliases},old?.etag??null))throw new AgentRuntimeError('query_archive_conflict',503);
      }
      return newFacts;
    }
    async function aliasPointer(ref){const hash=await dataHash(ref);let path='refs/';for(let depth=0;depth<32;depth++){const branch=refBranch(hash,depth),found=await sealedLoad(readBase+path+branch+'.json');if(!found)return null;if(found.value.split){path+=branch+'/';continue;}const pointer=found.value.aliases?.[hash];if(pointer&&pointer.ref!==ref)throw new AgentRuntimeError('query_archive_invalid',503);return pointer??null;}throw new AgentRuntimeError('query_archive_invalid',503);}
    async function replayStatisticsObservations(){
      if(!record.turn.plan.some(step=>step.operation==='read_data'&&statisticsSection(step.scope?.section)))return false;
      // Legacy sessions retain query locators while the bounded working set may
      // have evicted their contents. Restore only sealed current-source results,
      // without providers or recomputation. Older unvisited locators stay pending.
      let changed=false;const candidates=(record.turn.plan_observations??[]).filter(entry=>statisticsSection(entry.query?.section)&&!entry.statistics).slice(-128);
      for(const observation of candidates){const entry=await controller.restoreQuery(observation.reference);if(!entry||canonical(entry.query)!==canonical(observation.query))continue;const statistics=statisticsObservation(record.turn,entry);if(statistics){noteObservedRead(record.turn,entry.query,entry.reference,statistics);changed=true;}}
      return changed;
    }
    const controller={existing:false,resumed:existing,record,turn:record.turn,
      storageOperations:()=>storageOperations,
      public:publicState,
      history:()=>record.recent_turns.map(turn=>({...clone(turn),stale:!sameSource(turn.source,currentSource),trust:'server_validated_report_not_new_measurement'})),
      cachedStatisticsPack:loadStatisticsPack,
      async rememberStatisticsPack(ref,detail,pack){
        if(!cacheableStatistics(ref,detail))return;const value={version:AGENT_RUNTIME_VERSION,owner,statistics_ref:clone(ref),detail_ref:clone(detail),pack:clone(pack)},path=await statisticsCachePath(ref,detail),saved=await store.write(path,{...value,sha256:await dataHash(value)},null);
        if(!saved){const old=await loadStatisticsPack(ref,detail);if(JSON.stringify(old)!==JSON.stringify(pack))throw new AgentRuntimeError('statistics_cache_invalid',503);}
      },
      // Bulk source loads may run concurrently. Reservation, alias publication
      // and the session CAS remain serialized once per bounded batch.
      async rememberQueryBatch(values){
        if(!Array.isArray(values)||!values.length||values.length>3)throw new AgentRuntimeError('invalid_query_archive',400);
        const entries=[],aliases=[];let sequence=record.turn.query_sequence??0;
        for(const {query,result}of values){const clean=publicQuery(query),text=JSON.stringify(result),size=encoder.encode(text).byteLength;if(size>400*1024)throw new AgentRuntimeError('query_archive_too_large',422);const reference=`turn:${record.turn.id}:g${record.turn.generation??0}:query:${++sequence}`;entries.push({query:clean,reference,result:clone(result),result_sha256:await dataHash(text),bytes:size});}
        record.turn.query_sequence=sequence;await save();
        await Promise.all(entries.map(async entry=>{const number=entry.reference.split(':').at(-1),path=readBase+number+'.json',pack=entry.result.statistics_pack;let payload=entry;if(pack&&cacheableStatistics(pack.statistics_ref,pack.detail_ref)){payload={...entry,result:{...entry.result,statistics_pack:{statistics_cache:{statistics_ref:pack.statistics_ref,detail_ref:pack.detail_ref}}}};}const saved=await sealedWrite(path,payload);if(!saved){const old=await sealedLoad(path);if(old?.value?.result_sha256!==entry.result_sha256)throw new AgentRuntimeError('query_archive_conflict',503);}}));
        let newBulkSources=0;record.turn.bulk_source_refs??={};
        for(const entry of entries){const pack=entry.result.statistics_pack;if(pack&&cacheableStatistics(pack.statistics_ref,pack.detail_ref)){if(!record.turn.bulk_source_refs[pack.match_id])newBulkSources++;record.turn.bulk_source_refs[pack.match_id]=entry.reference;continue;}for(const ref of queryEvidenceIds(entry.result))aliases.push({hash:await dataHash(ref),ref,reference:entry.reference});const result=entry.result,usable=!result.error&&!['unavailable','not_rendered'].includes(result.state)&&result.available!==false&&(!Array.isArray(result.items)||result.items.length>0),factScope=Object.fromEntries(Object.entries(entry.query).filter(([key])=>!['offset','limit','tick_from','tick_to'].includes(key))),values=usable?(Array.isArray(result.items)?result.items:[Object.fromEntries(Object.entries(result).filter(([key])=>!['query_input','pagination','window'].includes(key)))]):[];for(const value of values){const fact='@fact:'+await dataHash({scope:factScope,value});aliases.push({hash:await dataHash(fact),ref:fact,reference:entry.reference,fact:true});}}
        const newFacts=await indexAliases(aliases)+newBulkSources;if(newFacts)record.turn.query_success_sequence=(record.turn.query_success_sequence??0)+Math.min(newFacts,entries.length);
        record.turn.bulk_query_cache??={};for(const entry of entries){record.turn.bulk_query_cache[await dataHash(canonical(entry.query))]={reference:entry.reference,result_sha256:entry.result_sha256};noteObservedRead(record.turn,entry.query,entry.reference);}await save();return entries.map(({query,reference,result})=>({query,reference,result}));
      },
      async cachedQuery(query){const clean=publicQuery(query),hash=await dataHash(canonical(clean)),bulk=record.turn.bulk_query_cache?.[hash],cached=bulk?{value:{...bulk,query_hash:hash}}:await sealedLoad(readBase+'cache/'+hash+'.json');if(!cached)return null;if(cached.value.query_hash!==hash)throw new AgentRuntimeError('query_archive_invalid',503);const entry=await controller.restoreQuery(cached.value.reference);if(!entry||canonical(entry.query)!==canonical(clean)||cached.value.result_sha256!==await dataHash(entry.result))throw new AgentRuntimeError('query_archive_invalid',503);return entry;},
      async rememberQuery(query,result,reference=null){
        const clean=publicQuery(query),refPrefix=`turn:${record.turn.id}:g${record.turn.generation??0}:query:`;
        let sequence;if(reference){if(!reference.startsWith(refPrefix)||!/^\d+$/.test(reference.slice(refPrefix.length)))throw new AgentRuntimeError('query_archive_invalid',400);sequence=Number(reference.slice(refPrefix.length));record.turn.query_sequence=Math.max(record.turn.query_sequence??0,sequence);}else{sequence=(record.turn.query_sequence??0)+1;record.turn.query_sequence=sequence;reference=refPrefix+sequence;await save();}
        const text=JSON.stringify(result);if(encoder.encode(text).byteLength>300*1024)throw new AgentRuntimeError('query_archive_too_large',422);
        const entry={query:clean,reference,result:clone(result),result_sha256:await dataHash(text),bytes:encoder.encode(text).byteLength},path=readBase+sequence+'.json';
        const saved=await sealedWrite(path,entry);if(!saved){const existing=await sealedLoad(path);if(!existing||existing.value.result_sha256!==entry.result_sha256||canonical(existing.value.query)!==canonical(clean))throw new AgentRuntimeError('query_archive_conflict',503);}
        // Cache failures and empty reads too, but only a distinct, usable page
        // advances progress. Repeating unavailable/[] cannot fund auto loops.
        const usable=!result.error&&!['unavailable','not_rendered'].includes(result.state)&&result.available!==false&&(!Array.isArray(result.items)||result.items.length>0);
        const refs=await Promise.all(queryEvidenceIds(result).map(async ref=>({hash:await dataHash(ref),ref,reference}))),factScope=Object.fromEntries(Object.entries(clean).filter(([key])=>!['offset','limit','tick_from','tick_to'].includes(key)));
        const values=usable?(Array.isArray(result.items)?result.items:[Object.fromEntries(Object.entries(result).filter(([key])=>!['query_input','pagination','window'].includes(key)))]):[];
        const facts=await Promise.all(values.map(async value=>{const ref='@fact:'+await dataHash({scope:factScope,value});return {hash:await dataHash(ref),ref,reference,fact:true};}));
        const newFacts=await indexAliases([...refs,...facts]),queryHash=await dataHash(canonical(clean)),cachePath=readBase+'cache/'+queryHash+'.json',old=await sealedLoad(cachePath);
        if(!await sealedWrite(cachePath,{reference,query_hash:queryHash,result_sha256:entry.result_sha256},old?.etag??null))throw new AgentRuntimeError('query_archive_conflict',503);
        if(newFacts>0)record.turn.query_success_sequence=(record.turn.query_success_sequence??0)+1;const statistics=statisticsObservation(record.turn,entry);if(statistics)noteObservedRead(record.turn,clean,reference,statistics);await save();return {query:clean,reference,result:clone(result)};
      },
      async restoreQuery(reference,{requireUnique=false}={}){
        if(typeof reference!=='string'||!reference||reference.length>240)return null;const refPrefix=`turn:${record.turn.id}:g${record.turn.generation??0}:query:`;
        const loadCurrent=async actual=>{
          if(typeof actual!=='string'||!actual.startsWith(refPrefix)||!/^\d+$/.test(actual.slice(refPrefix.length)))return null;const found=await sealedLoad(readBase+actual.slice(refPrefix.length)+'.json');if(!found)return null;const entry=found.value;
          if(entry.result?.statistics_pack?.statistics_cache){const {statistics_cache}=entry.result.statistics_pack;if(entry.query?.resource!=='rounds'||entry.query.match_id!==statistics_cache.statistics_ref?.match_id)throw new AgentRuntimeError('query_archive_invalid',503);const pack=await loadStatisticsPack(statistics_cache.statistics_ref,statistics_cache.detail_ref);if(!pack)throw new AgentRuntimeError('query_archive_invalid',503);entry.result.statistics_pack=pack;}
          if(entry.reference!==actual||entry.result_sha256!==await dataHash(JSON.stringify(entry.result)))throw new AgentRuntimeError('query_archive_invalid',503);return entry;
        };
        let entry,ambiguous=false;
        if(reference.startsWith(refPrefix))entry=await loadCurrent(reference);
        else{
          const bulkMatch=/^match:([a-f0-9]{24})(?::r[1-9][0-9]*(?::[A-Za-z0-9_:-]+)?)?$/.exec(reference),bulkReference=bulkMatch&&record.turn.bulk_source_refs?.[bulkMatch[1]],pointer=await aliasPointer(reference);
          if(bulkReference&&(typeof bulkReference!=='string'||!bulkReference.startsWith(refPrefix)))throw new AgentRuntimeError('query_archive_invalid',503);
          let bulk=bulkReference?await loadCurrent(bulkReference):null;if(bulk&&!queryEvidenceIds(bulk.result).includes(reference))bulk=null;
          const indexed=pointer?(pointer.reference===bulk?.reference?bulk:await loadCurrent(pointer.reference)):null;
          if(indexed&&!queryEvidenceIds(indexed.result).includes(reference))throw new AgentRuntimeError('query_archive_invalid',503);
          // A complete statistics pack is only a candidate for its actual
          // members. Detailed aim/event aliases still use their own archive;
          // two different successful pages retain the strict uniqueness rule.
          ambiguous=pointer?.ambiguous===true||Boolean(bulk&&indexed&&bulk.reference!==indexed.reference);
          if(requireUnique&&ambiguous)throw new AgentRuntimeError('query_archive_ambiguous',422);
          entry=bulk&&indexed?(Number(bulk.reference.slice(refPrefix.length))<Number(indexed.reference.slice(refPrefix.length))?bulk:indexed):bulk??indexed;
        }
        if(!entry)return null;return {query:publicQuery(entry.query),reference:entry.reference,result:clone(entry.result),...(ambiguous?{ambiguous:true}:{})};
      },
      async queryArchive({offset=0,limit=20}={}){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)throw new AgentRuntimeError('invalid_query_archive',400);const total=record.turn.query_sequence??0,items=[];for(let index=offset+1;index<=Math.min(total,offset+limit);index++){const entry=await controller.restoreQuery(`turn:${record.turn.id}:g${record.turn.generation??0}:query:${index}`);if(entry)items.push(archiveSummary({...entry,bytes:encoder.encode(JSON.stringify(entry.result)).byteLength}));}return {source:clone(record.turn.source),items,pagination:{offset,limit,total_slots:total,next_offset:offset+limit<total?offset+limit:null},note:'Metadata indexes actual saved pages; a page or replay window ending never implies all raw match data was read.'};},
      async rememberSurveySummary(matchId,value){if(!/^[a-f0-9]{24}$/.test(matchId)||!plainValues(value))throw new AgentRuntimeError('invalid_query_archive',400);const path=readBase+'survey/'+matchId+'.json',payload={match_id:matchId,value:clone(value)},saved=await sealedWrite(path,payload);if(!saved){const old=await sealedLoad(path);if(JSON.stringify(old?.value?.value)!==JSON.stringify(value))throw new AgentRuntimeError('query_archive_conflict',503);}},
      async surveySummaries(matchIds,{offset=0,limit=20}={}){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AgentRuntimeError('invalid_query_archive',400);const items=[];for(const matchId of matchIds.slice(offset,offset+limit)){if(!/^[a-f0-9]{24}$/.test(matchId))throw new AgentRuntimeError('invalid_query_archive',400);const bulk=record.turn.work?.survey?.bulk_summaries?.[matchId];if(bulk){items.push({match_id:matchId,...clone(bulk)});continue;}const found=await sealedLoad(readBase+'survey/'+matchId+'.json');if(!found)continue;if(found.value.match_id!==matchId)throw new AgentRuntimeError('query_archive_invalid',503);items.push({match_id:matchId,...clone(found.value.value)});}return {items,pagination:{offset,limit,total:matchIds.length,next_offset:offset+limit<matchIds.length?offset+limit:null}};},
      async activity(value){const clean=activityPayload(value),known=currentEvidence(record.turn),archived=[];for(const ref of clean.evidence_refs??[])if(!known.has(ref)&&(Object.values(record.turn.bulk_query_cache??{}).some(entry=>entry.reference===ref)||await controller.restoreQuery(ref)))archived.push(ref);const entry=appendActivity(record.turn,clean,now(),archived);record.turn.sequence++;await save();return entry;},
      async providerTrace(value){const entry=appendProviderReasoning(record.turn,value,now());record.turn.sequence++;await save();return entry;},
      async stageArtifact(value){
        if(value===null){record.turn.stage_artifact=null;record.turn.sequence++;await save();return {clear:true,source:clone(record.turn.source)};}
        if(!plainValues(value)||!ownKeys(value,['source','visualizations','evidence'])||!plainValues(value.source)||!ownKeys(value.source,['source_revision','generated_at','content_sha256'])||!sameSource(safeSource(value.source),record.turn.source)||!Array.isArray(value.visualizations)||!value.visualizations.length||value.visualizations.length>2||!value.visualizations.every(validateBoundAgentVisualization))throw new AgentRuntimeError('invalid_stage_artifact',400);
        const known=currentEvidence(record.turn),refs=new Set(),prefix=`turn:${record.turn.id}:g${record.turn.generation??0}:query:`;for(const visual of value.visualizations){for(const ref of visual.evidence_refs){if(!known.has(ref))throw new AgentRuntimeError('activity_evidence_invalid',400);refs.add(ref);}for(const proof of visual.provenance){let query=(record.turn.work?.queries??[]).find(entry=>entry.reference===proof.query_ref);if(!proof.query_ref.startsWith(prefix)||!/^\d+$/.test(proof.query_ref.slice(prefix.length))||!query)throw new AgentRuntimeError('invalid_stage_artifact',400);if(proof.path!=null){query=await controller.restoreQuery(proof.query_ref,{requireUnique:true});if(!query)throw new AgentRuntimeError('invalid_stage_artifact',400);}let expected;try{expected=projectAgentVisualBindingData(query.result,proof.path);if(proof.path!=null||Object.hasOwn(proof,'source')){const originalSource=projectAgentVisualBindingData(query.result,['source']);if(Object.hasOwn(proof,'source')&&!sameSource(proof.source,safeSource(originalSource)))throw Error();for(const key of ['source_revision','generated_at','content_sha256'])if(record.turn.source[key]&&(key!=='content_sha256'||originalSource[key]!=null)&&originalSource[key]!==record.turn.source[key])throw Error();}}catch{throw new AgentRuntimeError('invalid_stage_artifact',400);}if(JSON.stringify(visual.data[proof.name])!==JSON.stringify(expected))throw new AgentRuntimeError('invalid_stage_artifact',400);}}
        const evidence=[...refs].map(id=>{const entry=known.get(id),query=publicQuery(entry.query);return {id,resource:query.resource,query,query_ref:entry.reference,label:id,...(query.match_id?{match_id:query.match_id}:{}),...(query.round_number?{round_number:query.round_number}:{})};});
        const artifact={source:clone(record.turn.source),visualizations:clone(value.visualizations),evidence};if(encoder.encode(JSON.stringify(artifact)).byteLength>256*1024)throw new AgentRuntimeError('invalid_stage_artifact',400);const signature=await dataHash(artifact);if(signature!==record.turn.last_stage_signature){record.turn.stage_revision=(record.turn.stage_revision??0)+1;record.turn.last_stage_signature=signature;}record.turn.stage_artifact=artifact;record.turn.sequence++;await save();return clone(artifact);
      },
      async checkpoint(work,progress={}){
        // Only first preflight/escalation, entry into final repair, and first
        // formal schema/evidence/visual feedback count as repair progress. Keep a
        // per-source high-water mark so resetting a candidate or alternating
        // invalid documents cannot manufacture endless continuation credit.
        const previous=repairMilestones(record.turn);record.turn.work=clone(work);const current=repairMilestones(record.turn);
        const formal={...previous.formal_feedback,...current.formal_feedback};record.turn.repair_milestones={preflight_failures:Math.max(previous.preflight_failures,current.preflight_failures),entered_final:previous.entered_final||current.entered_final,...(Object.keys(formal).length?{formal_feedback:formal}:{})};
        record.turn.sequence++;record.turn.lease_until=now()+LEASE_MS;record.turn.progress={...record.turn.progress,...progress};await save();
      },
      // Reserve ownership before dispatching one potentially long provider
      // response. This CAS is metadata-only; provider chunks never write R2.
      // The next ordinary checkpoint returns to the normal short lease.
      async reserveProviderLease(durationMs){if(record.turn.status!=='running'||!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>630000)throw new AgentRuntimeError('invalid_provider_lease',400);record.turn.lease_until=Math.max(record.turn.lease_until,now()+durationMs);await save();},
      async plan(args){
        const {plan:next,changed}=editedPlan(record.turn.plan,args);validateDependencies(next);record.turn.plan=next;
        if(['set','append','revise'].includes(args.action)&&record.turn.visual_proofs)for(const id of changed)delete record.turn.visual_proofs[id];
        replayObservedReads(record.turn);await replayStatisticsObservations();refreshPlan(record.turn);planRevision(record.turn,args.action,changed,now());
        record.turn.sequence++;await save();const state=publicState().task;return {plan:state.plan,plan_revision:state.plan_revision,plan_revisions:state.plan_revisions,plan_overview:state.plan_overview,workflow:state.workflow,status:'recorded',note:'Plan changes alone do not complete any data operation; dependencies require actual completed operations.'};
      },
      async planTransaction(args){
        if(!plainValues(args)||!ownKeys(args,['expected_revision','edits'])||!Number.isSafeInteger(args.expected_revision)||args.expected_revision<0||!Array.isArray(args.edits)||args.edits.length<1||args.edits.length>6)throw new AgentRuntimeError('invalid_task_plan_transaction',400);
        if(args.expected_revision!==(record.turn.plan_revision??0))throw new AgentRuntimeError('task_plan_revision_conflict',409,{current_revision:record.turn.plan_revision??0});
        // Build the final graph in isolation. Dependencies may refer to nodes
        // created later in this transaction, but the entire final DAG must pass.
        let next=clone(record.turn.plan);const changed=new Set(),invalidated=new Set();
        for(const edit of args.edits){const value=editedPlan(next,edit);next=value.plan;for(const id of value.changed){changed.add(id);if(['set','append','revise'].includes(edit.action))invalidated.add(id);}}
        validateDependencies(next);const previous=clone(record.turn),previousRevision=record.revision,previousUpdated=record.updated_at;
        try{
          record.turn.plan=next;if(record.turn.visual_proofs)for(const id of invalidated)delete record.turn.visual_proofs[id];
          replayObservedReads(record.turn);await replayStatisticsObservations();refreshPlan(record.turn);planRevision(record.turn,'transaction',[...changed],now());record.turn.sequence++;
          await save();
        }catch(error){for(const key of Object.keys(record.turn))delete record.turn[key];Object.assign(record.turn,previous);record.revision=previousRevision;record.updated_at=previousUpdated;throw error;}
        const state=publicState().task;return {plan:state.plan,plan_revision:state.plan_revision,plan_revisions:state.plan_revisions,plan_overview:state.plan_overview,workflow:state.workflow,status:'recorded',edits_applied:args.edits.length,note:'One atomic graph revision; ready steps still require successful evidence-backed operations.'};
      },
      async observed(query,reference){const clean=publicQuery(query);record.turn.events=[...(record.turn.events??[]),{type:'query',resource:clean.resource,status:'complete',reference}].slice(-12);noteObservedRead(record.turn,clean,reference);refreshPlan(record.turn);},
      async reportFailure(category,values){const issues=(Array.isArray(values)?values:[]).slice(0,8).filter(issue=>/^[a-z_]{1,40}$/.test(issue?.code??'')&&/^analysis(?:\.(?:headline|summary|findings|training|limitations|visualizations|title|assessment|priority|evidence_refs|skill|exercise|target|minutes|[0-9]{1,3}))*$/.test(issue?.path??'')).map(issue=>({code:issue.code,path:issue.path}));record.turn.events=[...(record.turn.events??[]),{type:'validation',status:'failed',label:'分析报告校验',category,...(issues.length?{issues}:{})}].slice(-12);},
      async visualCheck(valid,category,details={}){recordVisualCheck(record.turn,valid);const issues=(Array.isArray(details.issues)?details.issues:[]).slice(0,8).filter(issue=>/^[a-z_]{1,40}$/.test(issue?.code??'')&&/^visualizations(?:\.[01])?(?:\.(?:document|data|path|title|description|evidence_refs|dataBindings|params|lets|nodes|actions|assumptions|version|kind|name|type|label|value|min|max|step|options|expr|id|parent|tag|attrs|style|text|bindings|when|repeat|action|target|as|index|evidence_ref|[0-9]{1,3}))*$/.test(issue?.path??'')).map(issue=>({code:issue.code,path:issue.path}));record.turn.events=[...(record.turn.events??[]),{type:'validation',status:valid?'complete':'failed',label:details.stage==='final'?'交互文档校验':'交互文档预检',...(category?{category}:{}),...(issues.length?{issues}:{})}].slice(-12);},
      async toolFailure(resource,code,query){record.turn.events=[...(record.turn.events??[]),{type:'query',resource,status:'failed',code}].slice(-12);if(QUERY_RESOURCES.includes(resource)){if(!Array.isArray(record.turn.plan_failures))record.turn.plan_failures=[];record.turn.plan_failures.push({resource,code:typeof code==='string'&&/^[a-z_]{1,64}$/.test(code)?code:'data_not_available',...(query?{query:clone(query)}:{})});record.turn.plan_failures=record.turn.plan_failures.slice(-16);refreshPlan(record.turn);}},
      async pause(reason='execution_window_complete',retryAfterMs=0){record.turn.status='awaiting_continuation';record.turn.pause_reason=reason;record.turn.retry_after_ms=Math.max(0,Math.min(3600000,retryAfterMs));record.turn.lease_until=0;record.turn.sequence++;await save();return {status:'awaiting_continuation',analysis:null,...publicState()};},
      async complete(result){
        if(result.agent?.visualizations?.length>0)recordVisualCheck(record.turn,true);
        record.turn.stage_artifact=null;
        record.turn.status='completed';record.turn.lease_until=0;record.turn.presentation_validated=true;
        refreshPlan(record.turn,{terminal:true});
        const visualVerified=result.agent?.visualizations?.length>0||record.turn.plan.some(step=>step.operation==='validate_visual'&&step.status==='complete');
        record.turn.events=[...(record.turn.events??[]),{type:'validation',status:'complete',label:visualVerified?'引用与交互文档已通过校验':'引用已通过校验'},{type:'presentation',status:'complete',label:'已提交通过校验的分析'}].slice(-12);record.turn.sequence++;
        const final={...result,...publicState()};final.session.revision=record.revision+1;record.turn.result=clone(final);
        // One conditional publication makes completion and its immutable result
        // visible together. A successor must archive this exact result before
        // replacing it; no follow-up completion write can race the next turn.
        await save();return final;
      },
      async fail(code){record.turn.status='failed';record.turn.stage_artifact=null;record.turn.error=typeof code==='string'&&/^[a-z_]{1,64}$/.test(code)?code:'analysis_failed';record.turn.lease_until=0;record.turn.sequence++;await save();},
    };
    if(await replayStatisticsObservations()){refreshPlan(record.turn);await save();}
    return controller;
  }
  return {begin,read,readQuery,list,history,storage:store.kind};
}
