// Provider-neutral, read-only queries over the reviewed personal snapshot.
// This module uses Web APIs so the identical contract runs on both hosts.
export const QUERY_VERSION = '1.0';
export const MAX_QUERY_BYTES = 16 * 1024;
export const MAX_QUERY_RESPONSE_BYTES = 256 * 1024;
export const QUERY_RESOURCES = ['catalog','status','overview','matches','match','players','player','compare','rounds','round','round_results','events','analysis','aim','replay_frames','native_captures','native_frames','grenades','effects','shots','bullet_impacts','damage_events','bomb','definitions','sync','inspect','raw_schema','raw_rows'];
const scopes = ['snapshot','match','round','player'];
const queryKeys = ['resource','match_id','player_id','player_ids','round_number','tick_from','tick_to','offset','limit','section','metric','clip_id','scope','path','raw_dataset','columns','filters','source_revision'];
const forbidden = new Set(['__proto__','prototype','constructor','toString','valueOf','hasOwnProperty']);
const snapshotRoots = ['aggregate','ai_coach','by_map','by_side','by_weapon','chronology','comparison','coverage','excluded','generated_at','limitations','profile','source','sync','training_plan','player_directory'];
const matchRoots = ['analysis','analysis_version','capabilities','capability_details','limitations','map_name','match_id','match_started_at','match_time_verified','parsed_at','provenance','source','summary','training_plan','players','coverage','ai_coach','replay'];
const roundRoots = ['aim','analysis','assists','damage','deaths','duels','economy','elapsed_seconds','end_tick','events','evidence_id','headshot_kills','kast','kills','movement','opening_death','opening_kill','positioning','positions','round_number','side','start_tick','survived','traded','utility','winner','won'];
const units = {tick:'server demo tick',tickrate:'ticks/s',seconds:'s',duration_seconds:'s',damage:'HP; see damage_context',damage_context:{statistics:'effective enemy HP',replay_damage_events:'reported dmg_health; may include overkill',shot_hurts:'reported event damage; see replay definitions'},health:'HP',armor:'armor points',speed:'world units/s',x:'world units',y:'world units',z:'world units',yaw:'degrees',pitch:'degrees',yaw_delta_degrees:'degrees',pitch_delta_degrees:'degrees',adr:'effective enemy HP/round',kd:'kills/deaths',headshot_pct:'%',kast_pct:'%',stop_before_fire_pct:'%',stop_to_shot_ms:'ms',suffixes:{_pct:'%',_degrees:'degrees',_ms:'ms',_seconds:'s'}};
export const QUERY_INPUT_SCHEMA = {
  type:'object',additionalProperties:false,required:['resource'],properties:{
    resource:{type:'string',enum:QUERY_RESOURCES},match_id:{type:'string',pattern:'^[a-f0-9]{24}$'},
    player_id:{type:'string',minLength:1,maxLength:80},player_ids:{type:'array',items:{type:'string',minLength:1,maxLength:80},minItems:1,maxItems:10,uniqueItems:true},
    round_number:{type:'integer',minimum:1,maximum:100},tick_from:{type:'integer',minimum:0},tick_to:{type:'integer',minimum:0},
    offset:{type:'integer',minimum:0,maximum:1000000},limit:{type:'integer',minimum:1,maximum:100},
    section:{type:'string',maxLength:80},metric:{type:'string',maxLength:80},clip_id:{type:'string',maxLength:100},
    scope:{type:'string',enum:scopes},path:{type:'array',maxItems:12,items:{type:'string',pattern:'^[A-Za-z0-9_:-]{1,100}$'}},
    raw_dataset:{type:'string',enum:['owner_rounds','player_rounds','owner_events','player_events','replay_frames','replay_kills','replay_shots','replay_damage','replay_impacts','grenades','effects','bomb_events','bomb_carrier_frames','aim_points','aim_camera','aim_target_points']},
    columns:{type:'array',minItems:1,maxItems:32,uniqueItems:true,items:{type:'string',maxLength:240}},
    filters:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['field','op','value'],properties:{field:{type:'string',maxLength:240},op:{type:'string',enum:['eq','ne','lt','lte','gt','gte','in','exists']},value:{anyOf:[{type:'string',maxLength:256},{type:'number'},{type:'boolean'},{type:'null'},{type:'array',maxItems:32,items:{anyOf:[{type:'string',maxLength:256},{type:'number'},{type:'boolean'},{type:'null'}]}}]}}}},
    source_revision:{type:'string',pattern:'^[a-f0-9]{40,64}$'},
  },
};
// Shared plan locators extend the read-only query fields with a statistics
// dataset. Keep this schema independent of the stateful session runtime.
export const AGENT_PLAN_SCOPE_PROPERTIES={...Object.fromEntries(Object.entries(QUERY_INPUT_SCHEMA.properties).filter(([key])=>!['resource','filters'].includes(key))),dataset:{type:'string',enum:['owner_rounds','player_rounds','technical']}};
const rawToolProperties=Object.fromEntries(['match_id','round_number','player_id','clip_id','raw_dataset','columns','filters','tick_from','tick_to','offset','limit','source_revision'].map(key=>[key,QUERY_INPUT_SCHEMA.properties[key]]));
const rawToolSchema={type:'object',properties:rawToolProperties,additionalProperties:false};
const readOnlyQueryAnnotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const QUERY_TOOLS = [
  {name:'read_data_catalog',description:'Read available personal CS2 data resources, units, source revision, coverage and read-only query limits. No model API is called.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:'query_dashboard_data',description:'Query bounded personal CS2 data: all players, comparisons, matches, rounds, mechanics, aim clips, observed bullets, utility, bomb events and verified uploaded native capture status/frame evidence. Use catalog first; follow next_offset and evidence references. Read-only; no SQL or code execution.',inputSchema:QUERY_INPUT_SCHEMA,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:'discover_raw_data',description:'Discover stored parsed row datasets and their actual fields, types, locators and missingness. These are original saved values, not aggregate statistics or an exhaustive unparsed .dem dump. Omit match_id for the dataset directory; specify match_id and raw_dataset for actual fields. Dense frame/aim datasets also require round_number. No model call.',inputSchema:rawToolSchema,annotations:readOnlyQueryAnnotations},
  {name:'query_raw_data',description:'Read exact stored parsed values without compacting nested objects: rounds, per-player events, decoded actor frames, shots, damage, impacts, utility, C4 and aim traces. One match per query; select columns using dot paths, filter scalar fields, and follow next_offset. Pin source_revision when paging. Frames/aim require round_number. Absent is distinct from null; no SQL, shell or model API.',inputSchema:{...rawToolSchema,required:['match_id','raw_dataset']},annotations:readOnlyQueryAnnotations},
  {name:'read_raw_data_batch',description:'Execute up to six independent raw schema/row queries. Each result keeps its own source, exact locator and pagination or error. Consecutive queries for the same immutable shard reuse one verified load; transport is bounded and completed pages do not imply the entire dataset was read. No model API.',inputSchema:{type:'object',additionalProperties:false,required:['queries'],properties:{queries:{type:'array',minItems:1,maxItems:6,items:{...rawToolSchema,properties:{...rawToolProperties,mode:{type:'string',enum:['rows','schema']}},required:['match_id','raw_dataset']}}}},annotations:readOnlyQueryAnnotations},
];
export class QueryError extends Error {
  constructor(code,status=400,details){super(code);this.code=code;this.status=status;this.details=details;}
}
const own = (value,key) => value != null && typeof value === 'object' && Object.hasOwn(value,key);
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(value) ? value : 0;
function validateInput(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!queryKeys.includes(key)))throw new QueryError('invalid_query');
  if(!QUERY_RESOURCES.includes(input.resource))throw new QueryError('unknown_resource');
  if(input.match_id != null && (typeof input.match_id!=='string' || !/^[a-f0-9]{24}$/.test(input.match_id)))throw new QueryError('invalid_match_id');
  for(const field of ['player_id','section','metric','clip_id'])if(input[field]!=null && (typeof input[field]!=='string' || !input[field] || input[field].length>(field==='clip_id'?100:80) || forbidden.has(input[field])))throw new QueryError('invalid_'+field);
  for(const [field,min,max] of [['offset',0,1000000],['limit',1,100],['round_number',1,100],['tick_from',0,Number.MAX_SAFE_INTEGER],['tick_to',0,Number.MAX_SAFE_INTEGER]])if(input[field]!=null && (!Number.isSafeInteger(input[field]) || input[field]<min || input[field]>max))throw new QueryError('invalid_'+field);
  if(input.player_ids!=null && (!Array.isArray(input.player_ids) || !input.player_ids.length || input.player_ids.length>10 || new Set(input.player_ids).size!==input.player_ids.length || input.player_ids.some(id=>typeof id!=='string' || !id || id.length>80 || forbidden.has(id))))throw new QueryError('invalid_player_ids');
  if(input.scope!=null && !scopes.includes(input.scope))throw new QueryError('invalid_scope');
  if(input.path!=null && (!Array.isArray(input.path) || input.path.length>12 || input.path.some(key=>typeof key!=='string' || !/^[A-Za-z0-9_:-]{1,100}$/.test(key) || forbidden.has(key) || /^(?:api_key|authorization|cookie|password|secret|access_token|refresh_token)$/i.test(key))))throw new QueryError('invalid_path');
  if(input.tick_from!=null && input.tick_to!=null && input.tick_to<input.tick_from)throw new QueryError('invalid_tick_window');
  const rawResource=['raw_schema','raw_rows'].includes(input.resource),rawKeys=['raw_dataset','columns','filters','source_revision'];
  if(!rawResource&&rawKeys.some(key=>input[key]!=null))throw new QueryError('raw_parameters_require_raw_resource');
  if(input.raw_dataset!=null&&!QUERY_INPUT_SCHEMA.properties.raw_dataset.enum.includes(input.raw_dataset))throw new QueryError('invalid_raw_dataset');
  if(input.source_revision!=null&&(typeof input.source_revision!=='string'||!/^[a-f0-9]{40,64}$/.test(input.source_revision)))throw new QueryError('invalid_source_revision');
  if(input.columns!=null&&(!Array.isArray(input.columns)||!input.columns.length||input.columns.length>32||new Set(input.columns).size!==input.columns.length||input.columns.some(field=>!validRawField(field))))throw new QueryError('invalid_raw_columns');
  if(input.filters!=null&&(!Array.isArray(input.filters)||input.filters.length>12||input.filters.some(filter=>!validRawFilter(filter))))throw new QueryError('invalid_raw_filters');
  if(input.resource==='raw_rows'&&(!input.match_id||!input.raw_dataset))throw new QueryError(!input.match_id?'match_id_required':'raw_dataset_required');
  if(rawResource&&input.match_id&&!input.raw_dataset)throw new QueryError('raw_dataset_required');
  if(rawResource&&new TextEncoder().encode(JSON.stringify(input)).byteLength>MAX_QUERY_BYTES)throw new QueryError('query_too_large',413);
  if(['native_captures','native_frames'].includes(input.resource)){
    if(!input.match_id)throw new QueryError('match_id_required');
    if(input.resource==='native_frames'&&!input.clip_id)throw new QueryError('clip_id_required');
    if(input.clip_id!=null&&!/^[A-Za-z0-9:_-]{1,100}$/.test(input.clip_id))throw new QueryError('invalid_clip_id');
  }
  return {...input,offset:input.offset??0,limit:input.limit??25};
}
function validRawField(field){return typeof field==='string'&&field.length<=240&&field.split('.').length<=12&&field.split('.').every(key=>/^[A-Za-z0-9_:-]{1,100}$/.test(key)&&!forbidden.has(key)&&!/^(?:api_key|authorization|cookie|password|secret|access_token|refresh_token|data)$/i.test(key));}
function rawPrimitive(value){return value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=256;}
function validRawFilter(filter){return filter&&typeof filter==='object'&&!Array.isArray(filter)&&Object.keys(filter).length===3&&['field','op','value'].every(key=>own(filter,key))&&validRawField(filter.field)&&['eq','ne','lt','lte','gt','gte','in','exists'].includes(filter.op)&&(filter.op==='in'?Array.isArray(filter.value)&&filter.value.length<=32&&filter.value.every(rawPrimitive):filter.op==='exists'?typeof filter.value==='boolean':rawPrimitive(filter.value));}
function source(snapshot,delivery={}) {
  return {generated_at:snapshot.generated_at??null,source_revision:delivery.source_revision??snapshot.delivery?.source_revision??null,ingested_at:delivery.ingested_at??snapshot.delivery?.ingested_at??null,repository:snapshot.source?.repository??null,analysis_versions:[...new Set(list(snapshot.matches).map(match=>match.analysis_version).filter(Boolean))]};
}
function ref(match,round,tail='') {
  return (match?`match:${match.match_id}`:'snapshot')+(round?`:r${round.round_number}`:'')+(tail?`:${tail}`:'');
}
function inspectLocator(path,location) {
  return location&&path.length<=12?{inspect_scope:location.scope,inspect_query:{resource:'inspect',...location,path}}:{};
}
function descriptor(value,path,location=null) {
  return {kind:Array.isArray(value)?'array':'object',...(Array.isArray(value)?{count:value.length}:{keys:Object.keys(value).filter(key=>!forbidden.has(key)).slice(0,100)}),inspect_path:path,...inspectLocator(path,location)};
}
function compact(value,path=[],depth=0,location=null) {
  if(value==null || typeof value==='boolean' || typeof value==='number')return typeof value==='number'&&!Number.isFinite(value)?null:value;
  if(typeof value==='string')return value.length<=2048?value:{kind:'text',length:value.length,preview:value.slice(0,512),truncated:true,inspect_path:path,...inspectLocator(path,location)};
  if(Array.isArray(value)) {
    if(value.length<=12 && value.every(item=>item==null || typeof item==='number' || typeof item==='boolean'))return value.map(item=>typeof item==='number'&&!Number.isFinite(item)?null:item);
    if(depth>=2 || value.length>20)return descriptor(value,path,location);
    return value.map((item,index)=>compact(item,[...path,String(index)],depth+1,location));
  }
  if(typeof value==='object') {
    if(depth>=3)return descriptor(value,path,location);
    const output={};
    for(const key of Object.keys(value)) {
      if(forbidden.has(key) || /^(?:api_key|authorization|cookie|password|secret|access_token|refresh_token)$/i.test(key))continue;
      if(key==='data' && value.encoding==='gzip-base64-json'){output.data={kind:'compressed_data',resource:path.at(-1)==='frames'?'replay_frames':'inspect',inspect_path:path,...(path.at(-1)==='frames'?{}:inspectLocator(path,location))};continue;}
      output[key]=compact(value[key],[...path,key],depth+1,location);
    }
    return output;
  }
  return null;
}
function matchFor(snapshot,input,required=true) {
  if(!input.match_id){if(required)throw new QueryError('match_id_required');return null;}
  const match=list(snapshot.matches).find(value=>value.match_id===input.match_id);
  if(!match)throw new QueryError('match_not_found',404);return match;
}
function roundFor(match,input,required=true) {
  if(input.round_number==null){if(required)throw new QueryError('round_number_required');return null;}
  const round=list(match.rounds).find(value=>value.round_number===input.round_number);
  if(!round)throw new QueryError('round_not_found',404);return round;
}
function replayRound(match,round) {return list(match.replay?.rounds).find(value=>value.round_number===round.round_number);}
function playerId(value) {return String(value?.player_id??value?.steamid64??value?.steamid??value?.id??'');}
function matchPlayers(match) {return Array.isArray(match.players)?match.players:list(match.players?.players);}
function directory(snapshot) {
  if(Array.isArray(snapshot.player_directory))return snapshot.player_directory;
  if(Array.isArray(snapshot.player_directory?.players))return snapshot.player_directory.players;
  const players=new Map();
  for(const match of list(snapshot.matches)) {
    const rich=matchPlayers(match),fallback=list(match.replay?.players);
    for(const value of rich.length?rich:fallback) {
      const id=playerId(value);if(!id || value.is_bot)continue;
      if(!players.has(id))players.set(id,{player_id:id,steamid:id,name:value.name??id,match_ids:[],coverage:{per_player_statistics:rich.length>0?'observed':'not_parsed'}});
      const found=players.get(id);if(!found.match_ids.includes(match.match_id))found.match_ids.push(match.match_id);
    }
  }
  return [...players.values()].map(value=>({...value,matches:value.match_ids.length}));
}
function playerFor(snapshot,input) {
  if(!input.player_id)throw new QueryError('player_id_required');
  const player=directory(snapshot).find(value=>playerId(value)===input.player_id);
  if(!player)throw new QueryError('player_not_found',404);return player;
}
function playerMatches(snapshot,id) {return list(snapshot.matches).filter(match=>matchPlayers(match).some(player=>playerId(player)===id) || list(match.replay?.players).some(player=>playerId(player)===id));}
function comparisonCohort(value) {return value?{basis:value.basis??null,shared_rounds:value.shared_rounds??null,match_ids:list(value.match_ids),player:compact(value.player),owner:compact(value.owner),deltas:compact(value.deltas)}:null;}
function matchSummary(match) {
  return {match_id:match.match_id,map_name:match.map_name,match_started_at:match.match_started_at??null,match_time_verified:match.match_time_verified??false,analysis_version:match.analysis_version??null,rounds:list(match.rounds).length,summary:compact(match.summary),player_count:matchPlayers(match).length||list(match.replay?.players).length,capabilities:compact(match.capabilities),coverage:compact(match.analysis?.coverage??match.coverage??{}),evidence_ref:ref(match)};
}
function page(items,input) {const rows=items.slice(input.offset,input.offset+input.limit);return {items:rows,pagination:{offset:input.offset,limit:input.limit,returned:rows.length,total:items.length,next_offset:input.offset+rows.length<items.length?input.offset+rows.length:null}};}
const matchLocation=match=>({scope:'match',match_id:match.match_id});
const roundLocation=(match,round)=>({scope:'round',match_id:match.match_id,round_number:round.round_number});
const playerPath=(match,index)=>Array.isArray(match.players)?['players',String(index)]:['players','players',String(index)];
function compactPlayer(match,player) {return compact(player,playerPath(match,matchPlayers(match).indexOf(player)),0,matchLocation(match));}
function compactRound(match,round,player=null) {return player?compact(round,[...playerPath(match,matchPlayers(match).indexOf(player)),'rounds',String(list(player.rounds).indexOf(round))],0,matchLocation(match)):compact(round,[],0,roundLocation(match,round));}
function withEvidence(value,match,round,tail='',path=[],location=null) {return {...compact(value,path,0,location),evidence_ref:value?.evidence_id??ref(match,round,value?.id??tail)};}
function selectedRounds(match,input) {const round=roundFor(match,input,false);return round?[round]:list(match.rounds);}
function filterTicks(items,input,tickOf=value=>value?.tick) {return items.filter(value=>{const tick=tickOf(value);return (input.tick_from==null || Number.isFinite(tick)&&tick>=input.tick_from) && (input.tick_to==null || Number.isFinite(tick)&&tick<=input.tick_to);});}
async function inspect(snapshot,input) {
  const scope=input.scope??'snapshot',path=input.path??[];let value,match,round;
  if(scope==='snapshot'){value=snapshot;if(path.length && !snapshotRoots.includes(path[0]))throw new QueryError('path_not_allowed');}
  else if(scope==='match'){match=matchFor(snapshot,input);value=match;if(path.length && !matchRoots.includes(path[0]))throw new QueryError('path_not_allowed');}
  else if(scope==='round'){match=matchFor(snapshot,input);round=roundFor(match,input);value=round;if(path.length && !roundRoots.includes(path[0]))throw new QueryError('path_not_allowed');}
  else value=playerFor(snapshot,input);
  const location={scope,...(match?{match_id:match.match_id}:{}),...(round?{round_number:round.round_number}:{}),...(scope==='player'?{player_id:input.player_id}:{})};
  if(!path.length) {
    const roots=scope==='snapshot'?snapshotRoots:scope==='match'?matchRoots:scope==='round'?roundRoots:Object.keys(value);
    return page(roots.filter(key=>own(value,key)).map(key=>({key,...(value[key]!=null&&typeof value[key]==='object'?descriptor(value[key],[key],location):{value:compact(value[key],[key],0,location)})})),input);
  }
  for(let index=0;index<path.length;index++) {
    const key=path[index];
    if(value?.encoding==='gzip-base64-json' && path[index-1]!=='frames')value=await decodePayload(value);
    if(!own(value,key) && ['points','targets','geometry'].includes(key) && value?.trajectory?.encoding==='gzip-base64-json')value={...value,...await decodePayload(value.trajectory,'object')};
    if(!own(value,key))throw new QueryError('path_not_found',404);
    if(key==='data' && value.encoding==='gzip-base64-json')throw new QueryError('use_replay_frames_resource');
    value=value[key];
  }
  if(value?.encoding==='gzip-base64-json' && path.at(-1)!=='frames')value=await decodePayload(value);
  if(Array.isArray(value)){
    const selected=page(value,input);
    return {...selected,items:selected.items.map((item,position)=>{const index=input.offset+position;return {index,value:compact(item,[...path,String(index)],0,location),evidence_ref:ref(match,round,'path:'+path.join('.')+'.'+index)};}),path};
  }
  if(value!=null&&typeof value==='object'){
    const selected=page(Object.keys(value).filter(key=>!forbidden.has(key)&&!/^(?:api_key|authorization|cookie|password|secret|access_token|refresh_token)$/i.test(key)),input);
    return {...selected,items:selected.items.map(key=>({key,value:key==='data'&&value.encoding==='gzip-base64-json'?{kind:'compressed_data',resource:'replay_frames'}:compact(value[key],[...path,key],0,location),evidence_ref:ref(match,round,'path:'+path.join('.')+'.'+key)})),path};
  }
  if(typeof value==='string'&&value.length>2048){const chunks=[];for(let index=0;index<value.length;index+=1024)chunks.push({character_offset:index,text:value.slice(index,index+1024)});return {...page(chunks,input),path,character_count:value.length,evidence_ref:ref(match,round,'path:'+path.join('.'))};}
  return {value:compact(value,path),path,evidence_ref:ref(match,round,'path:'+path.join('.'))};
}
async function decodePayload(encoded,kind) {
  if(encoded?.encoding!=='gzip-base64-json' || typeof encoded.data!=='string' || encoded.data.length>12*1024*1024 || encoded.data.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.data) || !Number.isSafeInteger(encoded.decoded_bytes) || encoded.decoded_bytes<2 || encoded.decoded_bytes>8*1024*1024 || encoded.count!=null&&(!Number.isSafeInteger(encoded.count)||encoded.count<0||encoded.count>1000000))throw new QueryError('encoded_data_unavailable',422);
  let reader;
  try {
    const bytes=Uint8Array.from(atob(encoded.data),value=>value.charCodeAt(0));
    reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
    while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>8*1024*1024){await reader.cancel();throw new Error('oversized');}text+=decoder.decode(next.value,{stream:true});}
    text+=decoder.decode();if(size!==encoded.decoded_bytes)throw new Error('invalid_length');
    const value=JSON.parse(text);
    if(value===null || typeof value!=='object' || kind==='array'&&!Array.isArray(value) || kind==='object'&&Array.isArray(value) || encoded.count!=null&&(!Array.isArray(value)||value.length!==encoded.count))throw new Error('invalid_payload');
    return value;
  } catch {if(reader)await reader.cancel().catch(()=>{});throw new QueryError('encoded_data_unavailable',422);}
}
async function shotRows(replay) {
  const value=replay?.shots;
  return Array.isArray(value)?value:value?.encoding==='gzip-base64-json'?await decodePayload(value,'array'):list(value?.items??value?.events);
}
async function decodeFrames(encoded,replay,round) {
  try {
    if(!Number.isSafeInteger(encoded?.count) || encoded.count<0 || encoded.count>40000)throw new Error('invalid_count');
    const frames=await decodePayload(encoded,'array');
    const fields=list(replay.player_fields),known=new Set(list(replay.players).map(player=>player.index));let prior=-1;
    const expected=['player_index','x','y','z','yaw','pitch','alive','team',...(['1.2','1.3'].includes(replay.version)?['health','armor']:[])];
    if(!['1.0','1.1','1.2','1.3'].includes(replay.version) || JSON.stringify(fields)!==JSON.stringify(expected))throw new Error('invalid_fields');
    for(const frame of frames) {
      if(!Array.isArray(frame) || frame.length!==2 || !Number.isSafeInteger(frame[0]) || frame[0]<round.start_tick || frame[0]>round.end_tick || frame[0]<=prior || !Array.isArray(frame[1]) || frame[1].length>32)throw new Error('invalid_frame');
      prior=frame[0];const seen=new Set();
      for(const row of frame[1]) {
        if(!Array.isArray(row) || row.length!==fields.length || !known.has(row[0]) || seen.has(row[0]) || !row.slice(1,4).every(Number.isFinite) || !row.slice(4,6).every(value=>value===null||Number.isFinite(value)) || ![0,1].includes(row[6]) || ![2,3].includes(row[7]) || !row.slice(8).every(value=>value===null||Number.isInteger(value)&&value>=0&&value<=100))throw new Error('invalid_player_frame');
        seen.add(row[0]);
      }
    }
    return frames;
  } catch {throw new QueryError('frames_unavailable',422);}
}
// Raw queries use the same verified match loader as the UI. They expose saved
// parsed observations, never a filesystem path or arbitrary .dem/SQL evaluator.
const RAW_QUERY_RESPONSE_BYTES=32*1024;
const rawDenseDatasets=new Set(['replay_frames','aim_points','aim_camera','aim_target_points']);
function rawGet(record,field){let value=record;for(const key of field.split('.')){if(!own(value,key))return {present:false};value=value[key];}return {present:true,value};}
function rawMatches(record,filter){const found=rawGet(record,filter.field);if(filter.op==='exists')return found.present===filter.value;if(!found.present)return false;const value=found.value,target=filter.value;if(filter.op==='eq')return value===target;if(filter.op==='ne')return value!==target;if(filter.op==='in')return filter.value.includes(value);if(typeof value!=='number'||typeof target!=='number')return false;return filter.op==='lt'?value<target:filter.op==='lte'?value<=target:filter.op==='gt'?value>target:value>=target;}
function rawSafeCopy(value,path=[],omitted=[]){
  if(value===null||typeof value!=='object')return typeof value==='number'&&!Number.isFinite(value)?null:value;
  if(path.length>24)throw new QueryError('raw_projection_too_deep',422,{hint:'Select a narrower column path.'});
  if(Array.isArray(value))return value.map((item,index)=>rawSafeCopy(item,[...path,String(index)],omitted));
  const output={};for(const key of Object.keys(value)){
    if(forbidden.has(key)||/^(?:api_key|authorization|cookie|password|secret|access_token|refresh_token)$/i.test(key)||key==='data'&&value.encoding==='gzip-base64-json'){omitted.push([...path,key].join('.'));continue;}
    output[key]=rawSafeCopy(value[key],[...path,key],omitted);
  }return output;
}
function rawTuple(row,fields){return Array.isArray(row)?Object.fromEntries(row.map((value,index)=>[Array.isArray(fields)&&fields.length===row.length&&new Set(fields).size===fields.length&&fields.every(validRawField)?fields[index]:String(index),value])):row;}
async function rawRecords(match,input){
  const dataset=input.raw_dataset,records=[],rounds=selectedRounds(match,input),replays=list(match.replay?.rounds),players=matchPlayers(match);
  if(rawDenseDatasets.has(dataset)&&input.round_number==null)throw new QueryError('round_number_required');
  const add=(record,round,path,extra={})=>records.push({record,round_number:round.round_number,locator:{path,...extra},tick:record?.tick??record?.start_tick??record?.['0']??null});
  if(dataset==='owner_rounds'||dataset==='owner_events'){
    for(const round of rounds){const ri=list(match.rounds).indexOf(round),path=['rounds',String(ri)];if(dataset==='owner_rounds')add(round,round,path);else list(round.events).forEach((event,index)=>add(event,round,[...path,'events',String(index)]));}
  }else if(dataset==='player_rounds'||dataset==='player_events'){
    const selected=players.filter(player=>!input.player_id||playerId(player)===input.player_id);if(input.player_id&&!selected.length)throw new QueryError('player_statistics_unavailable',422);
    for(const player of selected){const prefix=playerPath(match,players.indexOf(player));for(const round of list(player.rounds).filter(round=>input.round_number==null||round.round_number===input.round_number)){const path=[...prefix,'rounds',String(list(player.rounds).indexOf(round))];if(dataset==='player_rounds')add(round,round,path,{player_id:playerId(player)});else list(round.events).forEach((event,index)=>add(event,round,[...path,'events',String(index)],{player_id:playerId(player)}));}}
  }else if(dataset.startsWith('aim_')){
    for(const round of rounds){const playback=round.analysis?.level3?.mechanics?.aim_playback,windows=list(playback?.windows);for(let ci=0;ci<windows.length;ci++){
      const saved=windows[ci];if(input.clip_id&&saved.burst_id!==input.clip_id)continue;
      const compressed=saved.trajectory?.encoding==='gzip-base64-json',clip=compressed?{...saved,...await decodePayload(saved.trajectory,'object')}:saved;
      const prefix=['rounds',String(list(match.rounds).indexOf(round)),'analysis','level3','mechanics','aim_playback','windows',String(ci)];
      const emit=(values,fields,tail)=>list(values).forEach((row,index)=>add(rawTuple(row,fields),round,compressed?[...prefix,'trajectory']:[...prefix,...tail,String(index)],{clip_id:saved.burst_id,...(compressed?{decoded_path:[...tail,String(index)]}:{}),...(Array.isArray(fields)?{tuple_fields:fields}:{})}));
      if(dataset==='aim_points')emit(clip.points,playback?.point_fields,['points']);
      else if(dataset==='aim_camera')emit(clip.geometry?.camera,clip.geometry?.camera_fields,['geometry','camera']);
      else list(clip.targets).forEach((target,index)=>{if(!input.player_id||String(target.steamid??target.steamid64)===input.player_id)emit(target.points,target.point_fields??playback?.target_point_fields,['targets',String(index),'points']);});
    }}
  }else{
    const actor=input.player_id?list(match.replay?.players).find(player=>playerId(player)===input.player_id):null;if(input.player_id&&!actor)throw new QueryError('player_not_found',404);
    for(const round of rounds){const replay=replayRound(match,round);if(!replay)continue;const ri=replays.indexOf(replay),prefix=['replay','rounds',String(ri)];
      if(dataset==='replay_frames'){
        const end=replay.playback_end_tick??replay.end_tick??round.end_tick,tickrate=match.replay?.tickrate??64,start=input.tick_from??round.start_tick,finish=input.tick_to??Math.min(end,start+Math.floor(tickrate*30));
        if(!Number.isSafeInteger(end)||end<round.end_tick||replay.next_round_start_tick!=null&&end>=replay.next_round_start_tick)throw new QueryError('frames_unavailable',422);
        if(finish<start||finish-start>tickrate*30)throw new QueryError('frame_window_exceeds_30_seconds');
        const frames=await decodeFrames(replay.frames,match.replay,{...round,end_tick:end});frames.forEach((frame,fi)=>{if(frame[0]<start||frame[0]>finish)return;frame[1].forEach((row,ai)=>{if(actor&&row[0]!==actor.index)return;add({tick:frame[0],...rawTuple(row,match.replay.player_fields)},round,[...prefix,'frames'],{decoded_path:[String(fi),'1',String(ai)],frame_tick_path:[String(fi),'0'],tuple_fields:match.replay.player_fields});});});
      }else{
        let values=[],tail=[];
        if(dataset==='replay_kills'){values=list(replay.kills);tail=['kills'];}
        else if(dataset==='replay_shots'){values=await shotRows(replay);tail=['shots'];}
        else if(dataset==='replay_damage'){values=list(replay.damage_events);tail=['damage_events'];}
        else if(dataset==='replay_impacts'){values=list(replay.unassociated_impacts);tail=['unassociated_impacts'];}
        else if(dataset==='grenades'||dataset==='effects'){values=list(replay.tactical?.[dataset]);tail=['tactical',dataset];}
        else if(dataset==='bomb_events'||dataset==='bomb_carrier_frames'){const key=dataset==='bomb_events'?'events':'carrier_frames';values=list(replay.tactical?.bomb?.[key]);tail=['tactical','bomb',key];}
        values.forEach((value,index)=>{const fields=dataset==='bomb_carrier_frames'?['tick','player_index','x','y','z']:dataset==='replay_shots'?replay.shots?.fields??match.replay?.shot_fields:null,row=rawTuple(value,fields);if(actor&&!['attacker_index','victim_index','assister_index','shooter_index','player_index','thrower_index','owner_index'].some(key=>row?.[key]===actor.index))return;add(row,round,[...prefix,...tail,...(replay.shots?.encoding==='gzip-base64-json'&&dataset==='replay_shots'?[]:[String(index)])],{...(Array.isArray(fields)?{tuple_fields:fields}:{}),...(replay.shots?.encoding==='gzip-base64-json'&&dataset==='replay_shots'?{decoded_path:[String(index)]}:{})});});
        if(dataset==='replay_impacts'){
          const shots=await shotRows(replay);shots.forEach((shot,si)=>list(shot.impacts).forEach((impact,ii)=>{if(actor&&shot.shooter_index!==actor.index)return;add(impact,round,[...prefix,'shots',...(replay.shots?.encoding==='gzip-base64-json'?[]:[String(si),'impacts',String(ii)])],{...(replay.shots?.encoding==='gzip-base64-json'?{decoded_path:[String(si),'impacts',String(ii)]}:{}),shot_id:shot.id??null,shooter_index:shot.shooter_index??null});}));
        }
      }
    }
  }
  return records.filter(item=>(input.tick_from==null||Number.isFinite(item.tick)&&item.tick>=input.tick_from)&&(input.tick_to==null||Number.isFinite(item.tick)&&item.tick<=input.tick_to));
}
function rawFieldSummary(records){
  const fields=new Map();for(const {record} of records.slice(0,128))for(const key of Object.keys(record??{})){if(!validRawField(key))continue;if(!fields.has(key))fields.set(key,{field:key,types:new Set(),present:0,null_count:0});const entry=fields.get(key),value=record[key];entry.present++;if(value===null)entry.null_count++;entry.types.add(value===null?'null':Array.isArray(value)?'array':typeof value);}
  return [...fields.values()].map(entry=>({...entry,types:[...entry.types],missing_count:Math.min(records.length,128)-entry.present}));
}
async function rawQuery(snapshot,input){
  const datasets=QUERY_INPUT_SCHEMA.properties.raw_dataset.enum;
  if(!input.match_id||!input.raw_dataset)return {datasets:datasets.map(name=>({raw_dataset:name,match_id_required:true,round_number_required:rawDenseDatasets.has(name),stored_values:true,unparsed_demo:false})),limits:{max_columns:32,max_filters:12,max_page_size:100,max_response_bytes:RAW_QUERY_RESPONSE_BYTES,max_batch_queries:6,max_frame_window_seconds:30},semantics:{columns:'Dot paths into exact saved parsed rows; default is scalar fields. Array tuple indices are numeric when source field names are unavailable.',missing:'Absent fields are listed in missing_fields; JSON null remains null.',filters:'AND scalar predicates; numeric ordering requires finite numeric operands.',provenance:'Each row includes the immutable detail shard, source revision and original or decoded array locator.',availability:'Only already parsed and stored observations are available. Empty rows are not proof that the source .dem had no event.'}};
  if(input.raw_dataset?.startsWith('aim_')&&input.raw_dataset!=='aim_target_points'&&input.player_id&&input.player_id!==snapshot.profile?.steamid64)throw new QueryError('mechanics_not_parsed_for_player',422);
  const match=matchFor(snapshot,input),records=await rawRecords(match,input),fields=rawFieldSummary(records),filtered=records.filter(item=>(input.filters??[]).every(filter=>rawMatches(item.record,filter)));
  if(input.resource==='raw_schema')return {...page(fields,input),raw_dataset:input.raw_dataset,records_in_window:records.length,field_sample_rows:Math.min(records.length,128),field_discovery_complete:records.length<=128,tuple_fields:records.find(item=>item.locator.tuple_fields)?.locator.tuple_fields??null};
  const selected=page(filtered,input),columns=input.columns??fields.filter(field=>field.types.every(type=>!['object','array'].includes(type))).slice(0,32).map(field=>field.field);
  const items=selected.items.map(item=>{const record={},missing=[],omitted=[];for(const field of columns){const found=rawGet(item.record,field);if(found.present)record[field]=rawSafeCopy(found.value,[field],omitted);else missing.push(field);}const path=item.locator.path.join('.')+(item.locator.decoded_path?':decoded:'+item.locator.decoded_path.join('.'):'');return {record,round_number:item.round_number,locator:item.locator,evidence_ref:ref(match,{round_number:item.round_number},'raw:'+input.raw_dataset+':'+path),...(missing.length?{missing_fields:missing}:{}),...(omitted.length?{omitted_fields:omitted}:{})};});
  const result={...selected,items,raw_dataset:input.raw_dataset,columns,scanned_rows:records.length,selected_rows:filtered.length,granularity:'stored_parsed_rows',unparsed_demo:false,provenance:{match_id:match.match_id,detail_content_sha256:match.detail_ref?.content_sha256??null,detail_source_revision:match.detail_ref?.source_revision??null,analysis_version:match.analysis_version??null},window:{round_number:input.round_number??null,tick_from:input.tick_from??null,tick_to:input.tick_to??null},response_byte_limit:RAW_QUERY_RESPONSE_BYTES};
  while(new TextEncoder().encode(JSON.stringify(result)).byteLength>RAW_QUERY_RESPONSE_BYTES&&result.items.length){result.items.pop();result.pagination.returned=result.items.length;result.pagination.next_offset=result.pagination.offset+result.items.length<result.pagination.total?result.pagination.offset+result.items.length:null;result.response_limited=true;}
  if(!result.items.length&&filtered.length>input.offset)throw new QueryError('raw_item_too_large',422,{hint:'Select narrower columns or use a deeper dot path; do not increase the response cap.'});
  return result;
}
function catalog(snapshot,coach={}) {
  return {resources:QUERY_RESOURCES,scopes,match_ids:list(snapshot.matches).map(match=>match.match_id),limits:{default_page_size:25,max_page_size:100,max_response_bytes:MAX_QUERY_RESPONSE_BYTES,max_frame_window_seconds:30,max_path_depth:12},capabilities:{read_only:true,sql:false,code_execution:false,model_api:coach.status??'not_configured',all_player_statistics:list(snapshot.matches).some(match=>matchPlayers(match).length>0),frame_player_fields:[...new Set(list(snapshot.matches).flatMap(match=>list(match.replay?.player_fields)))],native_captures:{match_id_required:true,completed_current_owner_only:true},native_frames:{match_id_required:true,clip_id:'existing aim burst_id',source:'verified private uploaded native engine evidence',media_bytes:false}},inspect_roots:{snapshot:snapshotRoots,match:matchRoots,round:roundRoots},examples:[{resource:'matches',limit:10},{resource:'players',limit:25},{resource:'inspect',scope:'snapshot',path:['aggregate']},{resource:'analysis',match_id:'<match_id>',section:'level3',metric:'mechanics'},{resource:'replay_frames',match_id:'<match_id>',round_number:1,tick_from:0,tick_to:640,limit:50},{resource:'native_captures',match_id:'<match_id>',limit:10},{resource:'native_frames',match_id:'<match_id>',clip_id:'<burst_id>',limit:25}],evidence_format:'match:<id>:r<round>:<event or data path>'};
}
function bounded(result) {
  const size=()=>new TextEncoder().encode(JSON.stringify(result)).byteLength;
  let bytes=size();
  if(bytes<=MAX_QUERY_RESPONSE_BYTES)return result;
  if(!Array.isArray(result.items) || !result.pagination)throw new QueryError('query_result_too_large',422,{hint:'Use inspect with a deeper path or a smaller query window.'});
  while(result.items.length && bytes>MAX_QUERY_RESPONSE_BYTES) {
    result.items.pop();result.pagination.returned=result.items.length;
    result.pagination.next_offset=result.pagination.offset+result.items.length<result.pagination.total?result.pagination.offset+result.items.length:null;
    result.response_limited=true;bytes=size();
  }
  if(!result.items.length && result.pagination.total>result.pagination.offset)throw new QueryError('query_item_too_large',422,{hint:'Use inspect with a deeper path.'});
  if(bytes>MAX_QUERY_RESPONSE_BYTES)throw new QueryError('query_result_too_large',422,{hint:'Use inspect with a deeper path.'});
  return result;
}
export async function runQuery(snapshot,raw,delivery={},options={}) {
  const input=validateInput(raw);
  if(!snapshot || !Array.isArray(snapshot.matches))throw new QueryError('snapshot_unavailable',503);
  if(input.source_revision!=null&&input.source_revision!==source(snapshot,delivery).source_revision)throw new QueryError('source_revision_mismatch',409);
  if(input.resource==='raw_schema'&&!input.match_id)return bounded({query_version:QUERY_VERSION,resource:input.resource,source:source(snapshot,delivery),...await rawQuery(snapshot,input)});
  const indexResources=new Set(['catalog','status','overview','matches','players','player','compare','sync']);
  if(input.resource==='player' && snapshot._cs2_storage?.statistics_refs) {
    playerFor(snapshot,input);
    const selected=playerMatches(snapshot,input.player_id).slice(input.offset,input.offset+input.limit),loaded=new Map();
    for(const match of selected) {
      if(typeof options.loadStatistics!=='function' || !match.statistics_ref)throw new QueryError('statistics_unavailable',503);
      const statistics=await options.loadStatistics(match.statistics_ref);
      if(statistics?.match_id!==match.match_id || !Array.isArray(statistics.rounds) || statistics.detail_ref?.content_sha256!==match.detail_ref?.content_sha256 || (statistics.player?.steamid && statistics.player.steamid!==snapshot.profile?.steamid64))throw new QueryError('statistics_unavailable',503);
      loaded.set(match.match_id,statistics);
    }
    snapshot={...snapshot,matches:snapshot.matches.map(match=>loaded.get(match.match_id)??match)};
  }
  const needsDetail=!indexResources.has(input.resource) && !(input.resource==='inspect' && !['match','round'].includes(input.scope??'snapshot'));
  if(needsDetail && snapshot._cs2_storage?.kind==='match_index') {
    const projected=matchFor(snapshot,input);
    if(typeof options.loadMatch!=='function' || !projected.detail_ref)throw new QueryError('match_detail_unavailable',503);
    const full=await options.loadMatch(projected.detail_ref);
    if(full?.match_id!==projected.match_id || !Array.isArray(full.rounds) || (full.player?.steamid && full.player.steamid!==snapshot.profile?.steamid64))throw new QueryError('match_detail_unavailable',503);
    const current=['native_captures','native_frames','raw_schema','raw_rows'].includes(input.resource)?{...full,detail_ref:projected.detail_ref}:full;
    snapshot={...snapshot,matches:snapshot.matches.map(match=>match===projected?current:match)};
  }
  let data={},coverage=compact(snapshot.coverage??{});
  const base={query_version:QUERY_VERSION,resource:input.resource,source:source(snapshot,delivery),units};
  if(input.resource==='catalog')data={...catalog(snapshot,options.coach),raw_data:await rawQuery(snapshot,{resource:'raw_schema'})};
  else if(['raw_schema','raw_rows'].includes(input.resource))data=await rawQuery(snapshot,input);
  else if(input.resource==='status')data={matches:snapshot.matches.length,rounds:snapshot.rounds_analyzed??snapshot.matches.reduce((sum,match)=>sum+list(match.rounds).length,0),players:directory(snapshot).length,sync:compact(snapshot.sync),ai_coach:options.coach?.status??'not_configured'};
  else if(input.resource==='overview') {
    const section=input.section??'aggregate';if(!['aggregate','by_map','by_side','by_weapon','chronology','comparison','training_plan','limitations','excluded'].includes(section))throw new QueryError('unknown_section');
    const value=snapshot[section];data={section,...(Array.isArray(value)?page(value.map(item=>compact(item)),input):{value:compact(value,[section])})};
  }
  else if(input.resource==='matches')data=page(snapshot.matches.filter(match=>!input.player_id || playerMatches(snapshot,input.player_id).includes(match)).map(matchSummary),input);
  else if(input.resource==='players'){matchFor(snapshot,input,false);data=page(directory(snapshot).filter(player=>!input.match_id || playerMatches(snapshot,playerId(player)).some(match=>match.match_id===input.match_id)).map(player=>({...compact(player),player_id:playerId(player)})),input);}
  else if(input.resource==='player') {
    const player=playerFor(snapshot,input);data={player:compact(player),...page(playerMatches(snapshot,input.player_id).map(match=>({match:matchSummary(match),player:compact(matchPlayers(match).find(value=>playerId(value)===input.player_id)??{player_id:input.player_id,coverage:{statistics:'not_parsed'}})})),input)};
  }
  else if(input.resource==='compare') {
    const ids=input.player_ids??[snapshot.profile?.steamid64,input.player_id].filter(Boolean);if(ids.length<2 || ids.length>10 || new Set(ids).size!==ids.length)throw new QueryError('comparison_requires_2_to_10_distinct_players');
    const players=directory(snapshot);data={comparison_scope:'stored shared-round cohorts against owner',items:ids.map(id=>{const player=players.find(value=>playerId(value)===id);if(!player)throw new QueryError('player_not_found',404);return {player_id:id,name:player.name??id,all_match_summary:compact(player.summary),comparison:comparisonCohort(player.comparison),teammate_comparison:comparisonCohort(player.teammate_comparison),coverage:compact(player.coverage),evidence_refs:playerMatches(snapshot,id).map(match=>ref(match))};})};
  }
  else if(input.resource==='inspect')data=await inspect(snapshot,input);
  else if(input.resource==='sync')data={value:compact(snapshot.sync,['sync']),excluded:compact(snapshot.excluded,['excluded'])};
  else {
    const match=matchFor(snapshot,input);coverage=compact(match.analysis?.coverage??match.coverage??{});
    if(['native_captures','native_frames'].includes(input.resource)){
      if(typeof options.loadNativeCapture!=='function')data={state:'unavailable',reason:'native_storage_unavailable',items:[],pagination:{offset:input.offset,limit:input.limit,returned:0,total:0,next_offset:null}};
      else try{data=await options.loadNativeCapture(match,input);}catch(error){if(['invalid_native_query','native_clip_not_found','native_frame_window_exceeds_30_seconds'].includes(error?.code))throw new QueryError(error.code,error.status);throw new QueryError('native_capture_unavailable',503);}
      coverage={...coverage,native_captures:{source:'private_completed_uploads',current_source_required:true,current_analysis_required:true,state:data.state}};
    }
    else if(input.resource==='match')data={match:matchSummary(match),players:matchPlayers(match).map(player=>({...compactPlayer(match,player),player_id:playerId(player)})),provenance:compact(match.provenance),limitations:compact(match.limitations),training_plan:compact(match.training_plan),evidence_ref:ref(match)};
    else if(input.resource==='rounds'){
      const player=input.player_id?matchPlayers(match).find(value=>playerId(value)===input.player_id):null;
      if(input.player_id&&!player)throw new QueryError('player_statistics_unavailable',422);
      const rounds=player?list(player.rounds):list(match.rounds);
      data=page(rounds.map(round=>({...compactRound(match,round,player),replay_result:compact(replayRound(match,round)?.result??null),evidence_ref:round.evidence_id??ref(match,round,player?'player:'+input.player_id:'')})),input);
    }
    else if(input.resource==='round') {const ownerRound=roundFor(match,input),player=input.player_id?matchPlayers(match).find(value=>playerId(value)===input.player_id):null;if(input.player_id&&!player)throw new QueryError('player_statistics_unavailable',422);const round=player?list(player.rounds).find(value=>value.round_number===input.round_number):ownerRound;if(!round)throw new QueryError('round_not_found',404);data={round:compactRound(match,round,player),replay_result:compact(replayRound(match,round)?.result??null),evidence_ref:round.evidence_id??ref(match,round,player?'player:'+input.player_id:'')};}
    else if(input.resource==='round_results')data=page(selectedRounds(match,input).map(round=>({round_number:round.round_number,start_tick:round.start_tick,end_tick:round.end_tick,result:compact(replayRound(match,round)?.result??null),evidence_ref:ref(match,round,'replay:result')})),input);
    else if(input.resource==='analysis') {
      if(input.player_id && input.player_id!==snapshot.profile?.steamid64)throw new QueryError('mechanics_not_parsed_for_player',422);
      const round=roundFor(match,input,false),analysis=round?.analysis??match.analysis??{},section=input.section??'level3';
      if(!['level2','level3','coverage','definitions'].includes(section))throw new QueryError('unknown_section');
      let value=analysis[section];if(input.metric){if(!own(value,input.metric))throw new QueryError('metric_not_found',404);value=value[input.metric];}
      data={section,metric:input.metric??null,value:compact(value,['analysis',section,...(input.metric?[input.metric]:[])]),evidence_ref:ref(match,round,'analysis:'+section+(input.metric?':'+input.metric:''))};
    }
    else if(input.resource==='definitions') {
      const round=roundFor(match,input,false);data={analysis:compact((round?.analysis??match.analysis)?.definitions),replay:compact(match.replay?.definitions),mechanics:compact((round?.analysis??match.analysis)?.level3?.mechanics?.definitions),provenance:compact(match.provenance),evidence_ref:ref(match,round,'definitions')};
    }
    else if(input.resource==='events') {
      let events=selectedRounds(match,input).flatMap(round=>list(round.events).map((event,index)=>({...withEvidence(event,match,round,'event:'+index),round_number:round.round_number})));
      if(input.player_id){
        const statisticPlayer=matchPlayers(match).find(value=>playerId(value)===input.player_id);
        const playerRounds=list(statisticPlayer?.rounds);
        if(playerRounds.some(value=>Array.isArray(value.events))){
          events=playerRounds.filter(value=>input.round_number==null||value.round_number===input.round_number).flatMap(round=>list(round.events).map((event,eventIndex)=>({...withEvidence(event,match,round,'player:'+input.player_id+':event:'+eventIndex),round_number:round.round_number})));
        }else{
        const player=list(match.replay?.players).find(value=>playerId(value)===input.player_id);if(!player)throw new QueryError('player_not_found',404);
        events=[];
        for(const round of selectedRounds(match,input)){
          const replay=replayRound(match,round),index=player.index;
          const related=(event)=>['attacker_index','victim_index','assister_index','shooter_index','player_index'].some(key=>event[key]===index);
          events.push(...[...list(replay?.kills).map(event=>({...event,type:'kill'})),...list(replay?.damage_events).map(event=>({...event,type:'damage'})),...(await shotRows(replay)).map(event=>({...event,type:'shot'}))].filter(related).map((event,eventIndex)=>({...withEvidence(event,match,round,'player:'+input.player_id+':event:'+eventIndex),round_number:round.round_number})));
        }
        }
      }
      data=page(filterTicks(events,input).sort((a,b)=>number(a.tick)-number(b.tick)),input);
    }
    else if(input.resource==='aim') {
      if(input.player_id && input.player_id!==snapshot.profile?.steamid64)throw new QueryError('mechanics_not_parsed_for_player',422);
      const clips=selectedRounds(match,input).flatMap(round=>list(round.analysis?.level3?.mechanics?.aim_playback?.windows).map((clip,index)=>({clip,round,index}))).filter(({clip})=>!input.clip_id||clip.burst_id===input.clip_id);
      const selected=page(filterTicks(clips,input,value=>value.clip.reference?.tick??value.clip.start_tick),input);
      data={...selected,items:await Promise.all(selected.items.map(async({clip,round,index})=>{
        const path=['analysis','level3','mechanics','aim_playback','windows',String(index)];
        const hydrated=input.clip_id&&clip.trajectory?.encoding==='gzip-base64-json'?{...clip,...await decodePayload(clip.trajectory,'object')}:clip;
        return {...compact(hydrated,path,0,roundLocation(match,round)),evidence_ref:clip.evidence_id??ref(match,round,'aim:'+clip.burst_id),round_number:round.round_number};
      }))};
      coverage={...coverage,aim_playback:compact(match.analysis?.level3?.mechanics?.aim_playback),legacy_crosshair_available:list(match.rounds).some(round=>list(round.analysis?.level3?.crosshair?.windows).length>0)};
    }
    else {
      const round=roundFor(match,input),replay=replayRound(match,round);if(!replay)throw new QueryError('replay_unavailable',422);
      coverage={...compact(match.replay?.coverage),tactical:compact(replay.tactical?.coverage),version:match.replay?.version};
      if(input.resource==='replay_frames') {
        const playbackEnd=replay.playback_end_tick??replay.end_tick??round.end_tick;
        if(!Number.isSafeInteger(playbackEnd) || playbackEnd<round.end_tick || replay.next_round_start_tick!=null&&(!Number.isSafeInteger(replay.next_round_start_tick)||playbackEnd>=replay.next_round_start_tick))throw new QueryError('frames_unavailable',422);
        const tickrate=match.replay?.tickrate??match.provenance?.tickrate??64,start=input.tick_from??round.start_tick,end=input.tick_to??Math.min(playbackEnd,start+Math.floor(tickrate*30));
        if(end<start || end-start>tickrate*30)throw new QueryError('frame_window_exceeds_30_seconds');
        const player=input.player_id?list(match.replay.players).find(value=>playerId(value)===input.player_id):null;if(input.player_id&&!player)throw new QueryError('player_not_found',404);
        const frames=await decodeFrames(replay.frames,match.replay,{...round,end_tick:playbackEnd});data={...page(filterTicks(frames,{...input,tick_from:start,tick_to:end},frame=>frame[0]).map(frame=>({tick:frame[0],players:player?list(frame[1]).filter(row=>row[0]===player.index):frame[1],evidence_ref:ref(match,round,'frame:'+frame[0])})),input),player_fields:match.replay.player_fields,players:compact(player?[player]:match.replay.players),tickrate,window:{tick_from:start,tick_to:end}};
      }
      else if(input.resource==='grenades' || input.resource==='effects'){
        const prefix=['replay','rounds',String(list(match.replay?.rounds).indexOf(replay)),'tactical',input.resource];
        const entries=list(replay.tactical?.[input.resource]).map((value,index)=>({value,index}));
        data=page(filterTicks(entries,input,entry=>entry.value.tick??entry.value.start_tick??entry.value.throw_tick).map(({value,index})=>withEvidence(value,match,round,input.resource+':'+(value.id??index),[...prefix,String(index)],matchLocation(match))),input);
      }
      else if(input.resource==='shots') {const shotData=replay.shots;let shots=await shotRows(replay);if(input.player_id){const player=list(match.replay.players).find(value=>playerId(value)===input.player_id);if(!player)throw new QueryError('player_not_found',404);shots=shots.filter(shot=>shot.shooter_index===player.index);}data={...page(filterTicks(shots,input,value=>Array.isArray(value)?value[0]:value.tick).map((value,index)=>Array.isArray(value)?{row:value,evidence_ref:ref(match,round,'shot:'+index)}:withEvidence(value,match,round,'shot:'+index)),input),fields:shotData?.fields??match.replay?.shot_fields??null,definitions:compact(match.replay?.definitions),coverage:compact(shotData?.coverage??match.replay?.coverage?.shots),kills:page(filterTicks(list(replay.kills),input).map((value,index)=>withEvidence(value,match,round,'kill:'+index)),input)};}
      else if(input.resource==='damage_events' || input.resource==='bullet_impacts') {
        let values=input.resource==='damage_events'?list(replay.damage_events):[...(await shotRows(replay)).flatMap(shot=>list(shot.impacts).map(impact=>({...impact,shooter_index:shot.shooter_index,shot_id:shot.id}))),...list(replay.unassociated_impacts)];
        if(input.player_id){const player=list(match.replay.players).find(value=>playerId(value)===input.player_id);if(!player)throw new QueryError('player_not_found',404);values=values.filter(value=>input.resource==='damage_events'?value.attacker_index===player.index||value.victim_index===player.index:value.shooter_index===player.index);}
        data=page(filterTicks(values,input).sort((a,b)=>number(a.tick)-number(b.tick)||number(a.sequence)-number(b.sequence)).map((value,index)=>withEvidence(value,match,round,input.resource+':'+index)),input);
      }
      else if(input.resource==='bomb') {const section=input.section??'events';if(!['events','carrier_frames'].includes(section))throw new QueryError('unknown_section');const values=list(replay.tactical?.bomb?.[section]);data={...page(filterTicks(values,input,value=>Array.isArray(value)?value[0]:value.tick).map((value,index)=>Array.isArray(value)?{row:value,evidence_ref:ref(match,round,'bomb:'+section+':'+index)}:withEvidence(value,match,round,'bomb:'+section+':'+index)),input),section,carrier_fields:['tick','player_index','x','y','z'],coverage:compact(replay.tactical?.bomb?.coverage)};}
    }
  }
  return bounded({...base,...data,coverage});
}
export async function parseQueryRequest(request) {
  const url=new URL(request.url),origin=request.headers.get('origin');
  if(origin && origin!==url.origin)throw new QueryError('origin_rejected',403);
  if(request.method==='GET') {
    const input={};for(const [key,value] of url.searchParams) {
      if(own(input,key))throw new QueryError('duplicate_query_parameter');
      if(['round_number','tick_from','tick_to','offset','limit'].includes(key))input[key]=/^\d+$/.test(value)?Number(value):NaN;
      else if(key==='path'||key==='player_ids'||key==='columns')input[key]=value?value.split(','):[];
      else input[key]=value;
    }
    return validateInput(input);
  }
  if(request.method!=='POST')throw new QueryError('method_not_allowed',405);
  if(origin!==url.origin)throw new QueryError('origin_rejected',403);
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))throw new QueryError('json_required',415);
  if(Number(request.headers.get('content-length')??0)>MAX_QUERY_BYTES)throw new QueryError('query_too_large',413);
  const reader=request.body?.getReader();if(!reader)throw new QueryError('invalid_json');let text='',size=0;const decoder=new TextDecoder();
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_QUERY_BYTES){await reader.cancel();throw new QueryError('query_too_large',413);}text+=decoder.decode(next.value,{stream:true});}
  try{return validateInput(JSON.parse(text+decoder.decode()));}catch(error){if(error instanceof QueryError)throw error;throw new QueryError('invalid_json');}
}
export function queryError(error) {return {error:error instanceof QueryError?error.code:'query_unavailable',...(error instanceof QueryError&&error.details?{details:error.details}:{})};}
