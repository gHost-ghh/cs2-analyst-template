import {validateBoundAgentVisualization} from '../shared/agent-visual.mjs';
// Provider SSE stays private. Only explicitly typed application events cross
// this boundary. Documented DeepSeek reasoning text is opt-in at the adapter;
// encrypted/unknown reasoning, raw tool arguments and provider errors stay private.
export const AGENT_STREAM_VERSION=1;
export const AGENT_STREAM_TYPES=Object.freeze(['status','plan','tool','activity','artifact','provider_trace','draft_delta','draft_reset','validated','paused','completed','error','snapshot']);
const encoder=new TextEncoder();
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_CODE=/^[a-z][a-z0-9_]{0,63}$/;
const TERMINAL=new Set(['response.completed','response.incomplete','response.failed']);
export class AgentStreamError extends Error{constructor(code='provider_stream_invalid'){super(code);this.name='AgentStreamError';this.code=code;this.status=code==='agent_stream_cursor_invalid'?400:502;}}
function aborted(signal){if(signal?.aborted)throw new AgentStreamError('request_cancelled');}

// SSE framing is line based, not chunk based. In particular, CRLF and UTF-8
// codepoints may be split at any byte, and an event can have many data lines.
export async function* readSseEvents(body,{signal,maxEventBytes=512*1024,maxLineBytes=maxEventBytes}={}){
  if(!body?.getReader)throw new AgentStreamError('provider_stream_invalid');
  const reader=body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let lineParts=[],lineBytes=0,skipLf=false,data=[],event='',id='',bytes=0,ended=false;
  const cancel=()=>{reader.cancel().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  function line(value){
    if(encoder.encode(value).byteLength>maxLineBytes)throw new AgentStreamError('provider_stream_buffer_exceeded');
    if(value===''){const result=data.length?{event:event||'message',data:data.join('\n'),id}:null;data=[];event='';bytes=0;return result;}
    if(value.startsWith(':'))return null;
    const split=value.indexOf(':'),field=split<0?value:value.slice(0,split);let content=split<0?'':value.slice(split+1);if(content.startsWith(' '))content=content.slice(1);
    if(field==='data'){bytes+=encoder.encode(content).byteLength+1;if(bytes>maxEventBytes)throw new AgentStreamError('provider_stream_buffer_exceeded');data.push(content);}
    else if(field==='event')event=content;
    else if(field==='id'&&!content.includes('\0'))id=content;
    return null;
  }
  try{
    const append=value=>{if(!value)return;lineBytes+=encoder.encode(value).byteLength;if(lineBytes>maxLineBytes)throw new AgentStreamError('provider_stream_buffer_exceeded');lineParts.push(value);};
    while(true){aborted(signal);let next;try{next=await reader.read();}catch{throw new AgentStreamError(signal?.aborted?'request_cancelled':'provider_stream_interrupted');}aborted(signal);const chunk=next.done?decoder.decode():decoder.decode(next.value,{stream:true});ended=next.done;
      let offset=0;
      for(let index=0;index<chunk.length;index++){
        const char=chunk.charCodeAt(index);
        if(skipLf){skipLf=false;if(char===10){offset=index+1;continue;}}
        if(char!==10&&char!==13)continue;
        append(chunk.slice(offset,index));const result=line(lineParts.join(''));lineParts=[];lineBytes=0;skipLf=char===13;offset=index+1;if(result)yield result;
      }
      append(chunk.slice(offset));
      // The SSE spec discards an unfinished last event. A provider response
      // without an actual terminal event will be rejected by the caller.
      if(ended)break;
    }
  }catch(error){if(signal?.aborted)throw new AgentStreamError('request_cancelled');if(error instanceof AgentStreamError)throw error;throw new AgentStreamError('provider_stream_invalid');}
  finally{signal?.removeEventListener('abort',cancel);if(!ended)await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export function createPresentationDraftDecoder(){
  // One forward scan per argument delta. Only root headline/summary JSON
  // strings are decoded; incomplete escapes and UTF-16 pairs remain private.
  let phase='root',depth=0,inString=false,role=null,key='',field=null,escape=false,unicode='',high='',disabled=false;
  const started=new Set(),escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
  return {feed(fragment){
    const output=[];let pending='';const flush=()=>{if(pending){output.push({field,text:pending,unverified:true});pending='';}};
    const decoded=char=>{
      if(role==='key'){key+=char;if(key.length>256)disabled=true;return;}
      if(!field)return;
      const code=char.charCodeAt(0);
      if(high){if(code>=0xdc00&&code<=0xdfff){pending+=high+char;high='';return;}disabled=true;return;}
      if(code>=0xd800&&code<=0xdbff){high=char;return;}
      if(code>=0xdc00&&code<=0xdfff){disabled=true;return;}
      pending+=char;
    };
    for(let index=0;index<fragment.length&&!disabled;index++){
      const char=fragment[index];
      if(inString){
        if(unicode){if(!/^[a-f0-9]$/i.test(char)){disabled=true;break;}unicode+=char;if(unicode.length===5){decoded(String.fromCharCode(parseInt(unicode.slice(1),16)));unicode='';}continue;}
        if(escape){escape=false;if(char==='u')unicode='u';else if(Object.hasOwn(escapes,char))decoded(escapes[char]);else disabled=true;continue;}
        if(char==='\\'){escape=true;continue;}
        if(char==='"'){if(high){disabled=true;break;}flush();inString=false;if(role==='key')phase='colon';else if(depth===1)phase='comma';role=null;field=null;continue;}
        if(char.charCodeAt(0)<32){disabled=true;break;}decoded(char);continue;
      }
      if(/\s/.test(char))continue;
      if(phase==='root'){if(char!=='{'){disabled=true;break;}depth=1;phase='key';continue;}
      if(depth>1){if(char==='"'){inString=true;role='nested';}else if(char==='{'||char==='[')depth++;else if(char==='}'||char===']'){depth--;if(depth===1)phase='comma';}continue;}
      if(phase==='key'){if(char==='}'){phase='done';continue;}if(char!=='"'){disabled=true;break;}key='';inString=true;role='key';continue;}
      if(phase==='colon'){if(char!==':'){disabled=true;break;}phase='value';continue;}
      if(phase==='value'){
        if(char==='"'){inString=true;role='value';field=['headline','summary'].includes(key)&&!started.has(key)?key:null;if(field)started.add(field);continue;}
        if(char==='{'||char==='['){depth++;phase='nested';continue;}phase='primitive';
      }
      if(phase==='primitive'){if(char===','){phase='key';continue;}if(char==='}'){phase='done';continue;}continue;}
      if(phase==='comma'){if(char===',')phase='key';else if(char==='}')phase='done';else disabled=true;continue;}
      if(phase==='done')disabled=true;
    }
    // Decoded prefixes are visibly unverified. Bad trailing syntax cannot
    // publish a report; the complete final JSON still faces all validators.
    flush();return output;
  }};
}

// DeepSeek's documented semantic stream terminates with a full response, not
// [DONE]. Do not reconstruct a trusted final report from argument deltas.
export async function readResponsesStream(response,{signal,maxEventBytes=512*1024,maxResponseBytes=2*1024*1024,maxTransportBytes=64*1024*1024,onDraft=()=>{},onLifecycle=()=>{},onReasoning}={}){
  if(!/\btext\/event-stream\b/i.test(response?.headers?.get('content-type')??''))throw new AgentStreamError('provider_stream_invalid');
  const items=new Map(),traces=new Map();let lastSequence=-1,total=0,traceBytes=0;
  const emitTrace=async(index,text)=>{if(typeof onReasoning!=='function'||typeof text!=='string')return;traceBytes+=encoder.encode(text).byteLength;if(traceBytes>maxResponseBytes)throw new AgentStreamError('provider_stream_buffer_exceeded');traces.set(index,(traces.get(index)??'')+text);for(let start=0;start<text.length;){let end=Math.min(text.length,start+8192);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;await onReasoning({text:text.slice(start,end)});start=end;}};
  for await(const frame of readSseEvents(response.body,{signal,maxEventBytes})){
    // Framing can dwarf the report with tiny deltas. The generous transport
    // guard is separate from the live event/argument/final-response bounds.
    total+=encoder.encode(frame.data).byteLength;if(total>maxTransportBytes)throw new AgentStreamError('provider_stream_transport_exceeded');
    let event;try{event=JSON.parse(frame.data);}catch{throw new AgentStreamError('provider_stream_invalid');}
    if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'||frame.event!=='message'&&frame.event!==event.type)throw new AgentStreamError('provider_stream_invalid');
    if(event.sequence_number!=null){if(!Number.isSafeInteger(event.sequence_number)||event.sequence_number<0||event.sequence_number<=lastSequence)throw new AgentStreamError('provider_stream_sequence_invalid');lastSequence=event.sequence_number;}
    if(['response.created','response.in_progress'].includes(event.type))await onLifecycle({phase:'generating'});
    if(event.type==='response.reasoning_text.delta'&&typeof onReasoning==='function'){
      if(!Number.isInteger(event.output_index)||event.output_index<0||event.output_index>=32||typeof event.delta!=='string')continue;
      await emitTrace(event.output_index,event.delta);
    }
    if(event.type==='response.output_item.added'&&event.item?.type==='function_call'){
      if(!Number.isInteger(event.output_index)||event.output_index<0||event.output_index>=32||items.size>=32||items.has(event.output_index))throw new AgentStreamError('provider_stream_invalid');
      const item={id:event.item.id,name:event.item.name,bytes:0,draft:createPresentationDraftDecoder()};items.set(event.output_index,item);
      if(item.name==='present_coach_analysis')await onLifecycle({phase:'presenting'});
      if(item.name==='present_coach_analysis'&&typeof event.item.arguments==='string')for(const draft of item.draft.feed(event.item.arguments))await onDraft(draft);
    }
    if(event.type==='response.function_call_arguments.delta'){
      const item=items.get(event.output_index);if(item?.id!=null&&event.item_id!=null&&item.id!==event.item_id)throw new AgentStreamError('provider_stream_invalid');if(item&&item.name==='present_coach_analysis'&&typeof event.delta==='string'){
        item.bytes+=encoder.encode(event.delta).byteLength;if(item.bytes>maxResponseBytes)throw new AgentStreamError('provider_stream_buffer_exceeded');
        for(const draft of item.draft.feed(event.delta))await onDraft(draft);
      }
    }
    if(TERMINAL.has(event.type)){
      const data=event.response;if(!data||typeof data!=='object'||Array.isArray(data)||data.status!==event.type.slice(9)||!Array.isArray(data.output))throw new AgentStreamError('provider_stream_invalid');
      if(encoder.encode(JSON.stringify(data)).byteLength>maxResponseBytes)throw new AgentStreamError('provider_stream_buffer_exceeded');
      if(typeof onReasoning==='function')for(const [index,item]of data.output.entries())if(item?.type==='reasoning'){
        const text=Array.isArray(item.content)?item.content.filter(part=>part?.type==='reasoning_text'&&typeof part.text==='string').map(part=>part.text).join(''):'';
        const sent=traces.get(index)??'';if(text&&text.startsWith(sent)&&text.length>sent.length)await emitTrace(index,text.slice(sent.length));
      }
      return data;
    }
    // All other provider events, including encrypted/summary/unknown reasoning
    // and raw answer text, remain private even if new event types appear.
  }
  throw new AgentStreamError('provider_stream_interrupted');
}

function safeBinding(value){
  if(!value||!UUID.test(value.session?.id??'')||!UUID.test(value.session?.turn_id??'')||!Number.isSafeInteger(value.attempt)||value.attempt<0)throw new AgentStreamError('agent_stream_binding_invalid');
  const source=value.source??{};return {session:{id:value.session.id,turn_id:value.session.turn_id,...(Number.isSafeInteger(value.session.revision)?{revision:value.session.revision}:{})},source:{source_revision:source.source_revision??null,generated_at:source.generated_at??null,content_sha256:source.content_sha256??null},attempt:value.attempt};
}
const ACTIVITY_FIELDS=['id','at','kind','phase','message','name','call_id','status','resource','query','summary','evidence_refs','attempt'];
const ACTIVITY_PHASES=['plan','finding','revision','reading','planning','generating','validating','presenting','repairing'];
const ACTIVITY_RESOURCES=['catalog','status','overview','matches','match','players','player','compare','rounds','round','round_results','events','analysis','aim','replay_frames','native_captures','native_frames','grenades','effects','shots','bullet_impacts','damage_events','bomb','definitions','sync','inspect','raw_schema','raw_rows'];
const ACTIVITY_QUERY_FIELDS=['resource','match_id','player_id','player_ids','round_number','tick_from','tick_to','offset','limit','section','metric','clip_id','scope','path'];
const PRIVATE_KEYS=new Set(['__proto__','prototype','constructor','caller','callee','arguments','reasoning','reasoning_content','encrypted_content','api_key','authorization','cookie','password','secret','access_token','refresh_token']);
const invalidEvent=()=>{throw new AgentStreamError('agent_stream_event_invalid');};
function publicJson(value,depth=0,seen=new Set()){
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))invalidEvent();return value;}
  if(typeof value==='string')return value;
  if(!value||typeof value!=='object'||depth>32||seen.has(value))invalidEvent();
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null&&!Array.isArray(value))invalidEvent();
  const descriptors=Object.getOwnPropertyDescriptors(value);seen.add(value);let result;
  if(Array.isArray(value)){
    if(value.length>20000||Reflect.ownKeys(descriptors).some(key=>key!=='length'&&!/^(?:0|[1-9]\d*)$/.test(String(key))))invalidEvent();
    result=[];for(let index=0;index<value.length;index++){const item=descriptors[index];if(!item||!Object.hasOwn(item,'value'))invalidEvent();result.push(publicJson(item.value,depth+1,seen));}
  }else{
    result={};for(const key of Reflect.ownKeys(descriptors)){if(typeof key!=='string'||PRIVATE_KEYS.has(key.toLowerCase())||!Object.hasOwn(descriptors[key],'value'))invalidEvent();result[key]=publicJson(descriptors[key].value,depth+1,seen);}
  }
  seen.delete(value);return result;
}
function publicRecord(value,fields,{project=false}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))invalidEvent();const clean=publicJson(value);
  if(!project&&Object.keys(clean).some(key=>!fields.includes(key)))invalidEvent();
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(clean,key)).map(key=>[key,clean[key]]));
}
function safeActivityQuery(value){
  const query=publicRecord(value,ACTIVITY_QUERY_FIELDS);if(!ACTIVITY_RESOURCES.includes(query.resource))invalidEvent();
  for(const field of ['match_id','player_id','section','metric','clip_id'])if(Object.hasOwn(query,field)&&query[field]!==null){const size=field==='match_id'?24:field==='clip_id'?100:80;if(typeof query[field]!=='string'||!query[field].length||query[field].length>size||PRIVATE_KEYS.has(query[field])||field==='match_id'&&!/^[a-f0-9]{24}$/.test(query[field]))invalidEvent();}
  for(const [field,min,max] of [['round_number',1,100],['tick_from',0,Number.MAX_SAFE_INTEGER],['tick_to',0,Number.MAX_SAFE_INTEGER],['offset',0,1000000],['limit',1,100]])if(query[field]!=null&&(!Number.isSafeInteger(query[field])||query[field]<min||query[field]>max))invalidEvent();
  if(query.tick_from!=null&&query.tick_to!=null&&query.tick_to<query.tick_from)invalidEvent();
  if(query.scope!=null&&!['snapshot','match','round','player'].includes(query.scope))invalidEvent();
  if(query.player_ids!=null&&(!Array.isArray(query.player_ids)||!query.player_ids.length||query.player_ids.length>10||new Set(query.player_ids).size!==query.player_ids.length||query.player_ids.some(value=>typeof value!=='string'||!value.length||value.length>80||PRIVATE_KEYS.has(value))))invalidEvent();
  if(query.path!=null&&(!Array.isArray(query.path)||query.path.length>12||query.path.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_:-]{1,100}$/.test(value)||PRIVATE_KEYS.has(value.toLowerCase()))))invalidEvent();
  return query;
}
function publicSource(value){
  const clean=publicRecord(value,['source_revision','generated_at','content_sha256']);
  if(Object.keys(clean).length!==3||Object.values(clean).some(value=>value!==null&&(typeof value!=='string'||value.length>240)))invalidEvent();return clean;
}
const sameStreamSource=(a,b)=>['source_revision','generated_at','content_sha256'].every(key=>(a[key]??null)===(b[key]??null));
function safeActivity(value,bound){
  const result=publicRecord(value,ACTIVITY_FIELDS),match=/^([a-f0-9-]{36}):activity:([1-9]\d{0,11})$/i.exec(result.id??'');
  if(!match||!UUID.test(match[1])||match[1]!==bound.session.turn_id||typeof result.at!=='string'||result.at.length>40||!Number.isFinite(Date.parse(result.at))||!['commentary','tool','phase','plan'].includes(result.kind))invalidEvent();
  if(result.phase!=null&&!ACTIVITY_PHASES.includes(result.phase))invalidEvent();
  if(result.message!=null&&(typeof result.message!=='string'||!result.message.trim()||result.message.length>800))invalidEvent();
  if(result.name!=null&&(typeof result.name!=='string'||!/^[a-z][a-z0-9_]{0,127}$/.test(result.name)))invalidEvent();
  if(result.call_id!=null&&(typeof result.call_id!=='string'||!/^[A-Za-z0-9_:-]{1,200}$/.test(result.call_id)))invalidEvent();
  if(result.status!=null&&!['started','completed','failed'].includes(result.status))invalidEvent();
  if(result.attempt!=null&&(!Number.isSafeInteger(result.attempt)||result.attempt<0||result.attempt>1000000000))invalidEvent();
  if(result.resource!=null&&!ACTIVITY_RESOURCES.includes(result.resource))invalidEvent();
  if(result.query!=null)result.query=safeActivityQuery(result.query);
  if(result.summary!=null){result.summary=publicRecord(result.summary,['rows','available','state','next_offset']);for(const field of ['rows','next_offset'])if(Object.hasOwn(result.summary,field)&&!(field==='next_offset'&&result.summary[field]===null)&&(!Number.isSafeInteger(result.summary[field])||result.summary[field]<0||result.summary[field]>1e9))invalidEvent();if(Object.hasOwn(result.summary,'available')&&typeof result.summary.available!=='boolean'||Object.hasOwn(result.summary,'state')&&(typeof result.summary.state!=='string'||!SAFE_CODE.test(result.summary.state)))invalidEvent();}
  if(result.evidence_refs!=null&&(!Array.isArray(result.evidence_refs)||result.evidence_refs.length>8||result.evidence_refs.some(ref=>typeof ref!=='string'||!ref.length||ref.length>240||/[\s\u0000-\u001f]/.test(ref))))invalidEvent();
  if(result.kind==='tool'&&(!result.name||!result.call_id||!result.status||result.attempt==null))invalidEvent();
  if(result.kind==='commentary'&&(!result.message||!['plan','finding','revision'].includes(result.phase)||result.phase==='finding'&&!result.evidence_refs?.length))invalidEvent();
  return result;
}
function safeArtifact(value,bound){
  const plain=publicJson(value),fields=plain?.clear===true?['clear','source']:['source','visualizations','evidence'],result=publicRecord(plain,fields);result.source=publicSource(result.source);
  if(!sameStreamSource(result.source,bound.source))invalidEvent();if(result.clear===true)return result;
  if(!Array.isArray(result.visualizations)||!result.visualizations.length||result.visualizations.length>2||!result.visualizations.every(validateBoundAgentVisualization)||!Array.isArray(result.evidence)||result.evidence.length>32)invalidEvent();
  const prefix=`turn:${bound.session.turn_id}:g`;for(const visual of result.visualizations)if(visual.provenance.some(proof=>!proof.query_ref.startsWith(prefix)||!/^\d+:query:[1-9]\d*$/.test(proof.query_ref.slice(prefix.length))))invalidEvent();
  for(const visual of result.visualizations)for(const name of Object.keys(visual.data)){const observed=visual.data[name]?.source;if(!observed||['source_revision','generated_at'].some(key=>result.source[key]!=null&&observed[key]!==result.source[key]))invalidEvent();}
  result.evidence=result.evidence.map(value=>{const item=publicRecord(value,['id','resource','query','query_ref','match_id','round_number','label'],{project:true});if(typeof item.id!=='string'||!item.id.length||item.id.length>240||!ACTIVITY_RESOURCES.includes(item.resource))invalidEvent();if(item.query!=null)item.query=safeActivityQuery(item.query);if(item.query_ref!=null&&(typeof item.query_ref!=='string'||!item.query_ref.length||item.query_ref.length>240))invalidEvent();if(item.match_id!=null&&!/^[a-f0-9]{24}$/.test(item.match_id)||item.round_number!=null&&(!Number.isSafeInteger(item.round_number)||item.round_number<1||item.round_number>100)||item.label!=null&&(typeof item.label!=='string'||item.label.length>240))invalidEvent();return item;});
  const refs=new Set(result.evidence.map(item=>item.id));if(result.visualizations.some(visual=>visual.evidence_refs.some(ref=>!refs.has(ref))))invalidEvent();
  return result;
}
function safePayload(type,payload,bound){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new AgentStreamError('agent_stream_event_invalid');
  if(type==='draft_delta'){if(!['headline','summary'].includes(payload.field)||typeof payload.text!=='string')throw new AgentStreamError('agent_stream_event_invalid');return {field:payload.field,text:payload.text,unverified:true};}
  if(type==='draft_reset')return {unverified:true};
  if(type==='provider_trace'){
    const clean=publicRecord(payload,['provider','model','text','status','reset','truncated']);
    if(clean.provider!=='deepseek'||typeof clean.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(clean.model)||typeof clean.text!=='string'||clean.text.length>8192||!['streaming','completed','interrupted'].includes(clean.status)||clean.reset!=null&&typeof clean.reset!=='boolean'||clean.truncated!=null&&typeof clean.truncated!=='boolean'||bound.attempt<1)invalidEvent();
    return clean;
  }
  if(type==='activity')return safeActivity(payload,bound);
  if(type==='artifact')return safeArtifact(payload,bound);
  if(type==='status'){if(!['reading','planning','presenting','repairing','validating','generating'].includes(payload.phase))throw new AgentStreamError('agent_stream_event_invalid');return {phase:payload.phase};}
  if(type==='tool'){
    if(typeof payload.name!=='string'||!/^[a-z][a-z0-9_]{0,127}$/.test(payload.name)||!['started','completed','failed'].includes(payload.status)||typeof payload.call_id!=='string'||!/^[A-Za-z0-9_:-]{1,200}$/.test(payload.call_id))throw new AgentStreamError('agent_stream_event_invalid');
    return {name:payload.name,call_id:payload.call_id,status:payload.status,...(typeof payload.resource==='string'&&SAFE_CODE.test(payload.resource)?{resource:payload.resource}:{}),...(typeof payload.reference==='string'&&/^[A-Za-z0-9_:.:-]{1,240}$/.test(payload.reference)?{reference:payload.reference}:{}),...(typeof payload.error==='string'&&SAFE_CODE.test(payload.error)?{error:payload.error}:{})};
  }
  if(type==='error')return {error:typeof payload.error==='string'&&SAFE_CODE.test(payload.error)?payload.error:'coach_unavailable',...(payload.session?{session:payload.session}:{}),...(payload.task?{task:payload.task}:{})};
  if(type==='plan')return {plan:payload.plan,...(Number.isSafeInteger(payload.plan_revision)?{plan_revision:payload.plan_revision}:{}),...(Array.isArray(payload.plan_revisions)?{plan_revisions:payload.plan_revisions}:{}),...(payload.plan_overview?{plan_overview:payload.plan_overview}:{}),...(payload.progress?{progress:Object.fromEntries(['model_calls','reads','windows'].filter(key=>Number.isSafeInteger(payload.progress[key])&&payload.progress[key]>=0&&payload.progress[key]<=1000000000).map(key=>[key,payload.progress[key]]))}:{})};
  if(type==='validated'&&(payload.status!=='complete'||!payload.analysis||!payload.agent))throw new AgentStreamError('agent_stream_event_invalid');
  return payload;
}
export function agentStreamId(turnId,streamId,sequence){if(!UUID.test(turnId??'')||!UUID.test(streamId??'')||!Number.isSafeInteger(sequence)||sequence<0)throw new AgentStreamError('agent_stream_cursor_invalid');return `${turnId}:${streamId}:${sequence}`;}
export function parseAgentStreamId(value,turnId){if(value==null||value==='')return null;const [id,streamId,digits,...rest]=value.split(':');if(rest.length||!UUID.test(id??'')||id!==turnId||!UUID.test(streamId??'')||!/^\d{1,12}$/.test(digits??'')||!Number.isSafeInteger(Number(digits)))throw new AgentStreamError('agent_stream_cursor_invalid');return {stream_id:streamId,seq:Number(digits)};}

// Every connection has its own delivery cursor. A reconnect reads the stored
// task/snapshot on a new stream; transient draft deltas are not replayed.
// waitUntil pins the running task in Workers after returning the Response.
export function createAgentStreamResponse({binding,execute,checkpoint,sequence=0,streamId=crypto.randomUUID(),signal,waitUntil,now=()=>Date.now(),heartbeatMs=10000,maxQueuedBytes=512*1024,maxEventBytes=384*1024}={}){
  const abort=new AbortController(),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;let controller,closed=false,queued=0,tail=Promise.resolve(),timer;
  const readBinding=()=>safeBinding(typeof binding==='function'?binding():binding);
  const write=text=>{if(closed)return;const bytes=encoder.encode(text);if(queued+bytes.byteLength>maxQueuedBytes){abort.abort();throw new AgentStreamError('agent_stream_slow_consumer');}queued+=bytes.byteLength;controller.enqueue(bytes);};
  const body=new ReadableStream({start(value){controller=value;},pull(){queued=0;},cancel(){closed=true;clearInterval(timer);abort.abort();}});
  const emit=(type,payload={})=>{const work=tail.then(async()=>{
    if(closed||combined.aborted)return null;if(!AGENT_STREAM_TYPES.includes(type))throw new AgentStreamError('agent_stream_event_invalid');
    const bound=readBinding(),clean=safePayload(type,payload,bound),next=sequence+1,envelope={version:AGENT_STREAM_VERSION,id:agentStreamId(bound.session.turn_id,streamId,next),stream_id:streamId,seq:next,type,...bound,at:new Date(now()).toISOString(),payload:clean};
    const data=JSON.stringify(envelope);if(encoder.encode(data).byteLength>maxEventBytes)throw new AgentStreamError('agent_stream_event_too_large');
    if(checkpoint)await checkpoint(envelope);sequence=next;write(`id: ${envelope.id}\nevent: agent.${type}\ndata: ${data}\n\n`);return envelope;
  });tail=work.catch(()=>{});return work;};
  const stop=()=>{clearInterval(timer);if(!closed){closed=true;try{controller.close();}catch{}}};
  timer=setInterval(()=>{try{if(!closed&&!combined.aborted)write(`: heartbeat ${Math.floor(now()/1000)}\n\n`);}catch{abort.abort();}},Math.max(10,heartbeatMs));
  const completion=Promise.resolve().then(async()=>{try{readBinding();await execute({emit,signal:combined});await tail;}catch(error){if(!closed&&!combined.aborted)try{await emit('error',{error:SAFE_CODE.test(error?.code??'')?error.code:'coach_unavailable'});}catch{}}finally{stop();}});
  if(waitUntil)waitUntil(completion);
  return {response:new Response(body,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'private, no-store, no-transform','x-content-type-options':'nosniff','referrer-policy':'same-origin','x-robots-tag':'noindex, nofollow','x-accel-buffering':'no'}}),completion,abort:()=>abort.abort()};
}
