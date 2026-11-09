import {MAX_MATCH_BYTES, isMatchIndex, validMatchRef, validStatisticsRef, validMatchIndex, matchKey, statisticsKey, sha256Bytes, verifyMatchBytes, verifyStatisticsBytes, sameMatchRef} from './storage.mjs';
import {createCoachHandler, coachStatus} from './coach.mjs';
import {createR2AgentStore,createMemoryAgentStore} from './agent-runtime.mjs';
import {createSyncHandler} from './sync.mjs';
import {createGitHubSnapshotPull} from './sync-import.mjs';
import {createNativeJobHandler,createNativeQueryReader} from './native-jobs.mjs';
import {QUERY_TOOLS, runQuery, parseQueryRequest, queryError, QueryError} from './query.mjs';
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const KEY = 'dashboard/latest.json';
const headers = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com",
};
function json(value, status=200, extra={}) {
  return new Response(JSON.stringify(value), {status,headers:{...headers,'content-type':'application/json; charset=utf-8',...extra}});
}
async function readBoundedBody(request) {
  if(Number(request.headers.get('content-length')||0)>MAX_BODY_BYTES)return {error:'snapshot_too_large',status:413};
  const reader=request.body?.getReader();
  if(!reader)return {error:'body_required',status:400};
  let size=0;const chunks=[];
  while(true){
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;
    if(size>MAX_BODY_BYTES){await reader.cancel();return {error:'snapshot_too_large',status:413};}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return {bytes};
}
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))), x=>x.toString(16).padStart(2,'0')).join('');
}
async function unpackSnapshot(snapshot) {
  if(!snapshot || typeof snapshot!=='object' || !Object.hasOwn(snapshot,'_cs2_transport'))return {snapshot};
  const packed=snapshot._cs2_transport;
  if(Object.keys(snapshot).length!==1 || !packed || typeof packed!=='object' || Array.isArray(packed) || Object.keys(packed).some(key=>!['encoding','data','decoded_bytes','compressed_sha256','decoded_sha256'].includes(key)) || !['encoding','data','decoded_bytes'].every(key=>Object.hasOwn(packed,key)) || ['compressed_sha256','decoded_sha256'].some(key=>Object.hasOwn(packed,key)&&!/^[a-f0-9]{64}$/.test(packed[key])) || packed.encoding!=='gzip-base64-json' || typeof packed.data!=='string' || !Number.isInteger(packed.decoded_bytes) || packed.decoded_bytes<2)return {error:'invalid_snapshot_transport',status:422};
  if(packed.decoded_bytes>MAX_BODY_BYTES || packed.data.length>4*Math.ceil(MAX_COMPRESSED_BYTES/3))return {error:'snapshot_too_large',status:413};
  if(packed.data.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(packed.data))return {error:'invalid_snapshot_transport',status:422};
  let reader;
  try {
    let bytes=Uint8Array.from(atob(packed.data),char=>char.charCodeAt(0));
    if(bytes.byteLength>MAX_COMPRESSED_BYTES)return {error:'snapshot_too_large',status:413};
    if(packed.compressed_sha256){const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');if(hash!==packed.compressed_sha256)return {error:'snapshot_transport_digest_mismatch',status:422};}
    packed.data='';
    reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    bytes=null;
    const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_BODY_BYTES){await reader.cancel().catch(()=>{});return {error:'snapshot_too_large',status:413};}
      text+=decoder.decode(value,{stream:true});
    }
    if(size!==packed.decoded_bytes)return {error:'invalid_snapshot_transport',status:422};
    text+=decoder.decode();
    if(packed.decoded_sha256 && await digest(text)!==packed.decoded_sha256)return {error:'snapshot_transport_digest_mismatch',status:422};
    return {snapshot:JSON.parse(text)};
  } catch {
    if(reader)await reader.cancel().catch(()=>{});
    return {error:'invalid_snapshot_transport',status:422};
  }
}
function validateReplay(replay, rounds) {
  if(replay==null)return true;
  if(!['1.0','1.1','1.2','1.3'].includes(replay.version)||!Array.isArray(replay.players)||replay.players.length>32||!Array.isArray(replay.rounds)||replay.rounds.length>rounds.length)return false;
  const expectedFields=['player_index','x','y','z','yaw','pitch','alive','team',...(['1.2','1.3'].includes(replay.version)?['health','armor']:[])];
  if(JSON.stringify(replay.player_fields)!==JSON.stringify(expectedFields))return false;
  const players=new Set();
  for(const player of replay.players){if(!Number.isInteger(player.index)||player.index<0||player.index>=32||players.has(player.index)||typeof player.name!=='string'||player.name.length>128)return false;players.add(player.index);}
  const knownRounds=new Set(rounds.map(r=>r.round_number)),seen=new Set();let frameCount=0,killCount=0;
  const point=p=>p===null||(Array.isArray(p)&&p.length===3&&p.every(Number.isFinite));
  const actor=p=>p===null||players.has(p);
  for(const round of replay.rounds){
    if(!knownRounds.has(round.round_number)||seen.has(round.round_number)||!Number.isInteger(round.start_tick)||!Number.isInteger(round.end_tick)||round.start_tick<0||round.end_tick<round.start_tick)return false;
    seen.add(round.round_number);
    const f=round.frames;
    if(!f||f.encoding!=='gzip-base64-json'||typeof f.data!=='string'||f.data.length>MAX_BODY_BYTES||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)||f.data.length%4!==0||!Number.isInteger(f.count)||f.count<0||!Number.isInteger(f.decoded_bytes)||f.decoded_bytes<2||f.decoded_bytes>8*1024*1024)return false;
    frameCount+=f.count;
    if(!Array.isArray(round.kills))return false;
    killCount+=round.kills.length;
    for(const kill of round.kills){
      if(!Number.isInteger(kill.tick)||kill.tick<round.start_tick||kill.tick>round.end_tick||!actor(kill.attacker_index)||!actor(kill.victim_index)||!actor(kill.assister_index)||!point(kill.attacker_position)||!point(kill.victim_position)||!Array.isArray(kill.bullet_impacts)||kill.bullet_impacts.length>16)return false;
      for(const impact of kill.bullet_impacts)if(impact.tick!==kill.tick||impact.shooter_index!==kill.attacker_index||!point(impact.position)||!point(impact.from))return false;
    }
  }
  return frameCount<=(['1.2','1.3'].includes(replay.version)?40000:20000)&&killCount<=2048;
}
function validate(snapshot, owner) {
  if (!snapshot || snapshot.schema_version !== '1.0' || snapshot.profile?.steamid64 !== owner) return false;
  if (!Array.isArray(snapshot.matches) || snapshot.matches.length > 1000) return false;
  if (!Number.isFinite(Date.parse(snapshot.generated_at)) || Date.parse(snapshot.generated_at) > Date.now()+300000) return false;
  const ids = new Set();
  for (const match of snapshot.matches) {
    if (!/^[a-f0-9]{24}$/.test(match.match_id) || ids.has(match.match_id) || !Array.isArray(match.rounds) || match.rounds.length>100) return false;
    ids.add(match.match_id);
    if (match.player?.steamid && match.player.steamid !== owner) return false;
    if (!(isMatchIndex(snapshot) && validMatchRef(match.detail_ref)) && !validateReplay(match.replay,match.rounds)) return false;
    if(match.analysis_version==='2.0') {
      const counters=[match.analysis?.level3?.counter_strafe,...match.rounds.map(r=>r.analysis?.level3?.counter_strafe)].filter(Boolean);
      if(counters.some(c=>['median_stop_to_shot_ms','observed_braking_shots','complete_movement_windows'].some(k=>c[k]!=null)||(c.observations||[]).some(o=>['prior_peak_speed','stop_tick','stop_to_shot_ms'].some(k=>o[k]!=null))))return false;
    }
    for (const round of match.rounds) {
      if (!Number.isInteger(round.round_number) || round.round_number<1 || !['T','CT'].includes(round.side)) return false;
      for (const key of ['kills','deaths','assists','damage','headshot_kills']) if (!Number.isFinite(round[key]) || round[key]<0) return false;
      if (round.headshot_kills>round.kills) return false;
    }
  }
  return validMatchIndex(snapshot);
}
async function readStored(env) {
  if (!env.BUCKET) return null;
  const object=await env.BUCKET.get(KEY);
  if (!object) return null;
  return {object,value:await object.json()};
}
export function makeWorker({page,css,client,playersClient='',playersCss='',coachClient='',coachCss='',syncClient='',nativeClient='',nativeCss='',visualClient='',visualSpec='',workflowClient='',workflowCss='',reasoningClient='',reasoningCss='',initial,assets={},coachSessionStore=createMemoryAgentStore()}) {
  const owner=initial.profile.steamid64;
  const coachHandlers=new WeakMap(),coachMemory=coachSessionStore;
  const syncHandler=createSyncHandler({requireIdentity:true,onComplete:async(run,{token,store,env})=>{
    const key=`publication/${run.id}`,state=await store.get(key);
    const pull=createGitHubSnapshotPull({owner,
      readCurrent:async()=>{const saved=await readStored(env);return saved?{source_revision:saved.value.source_revision,generated_at:saved.value.snapshot.generated_at}:null;},
      persistOperation:(snapshot,revision)=>persistSnapshot({snapshot,source_revision:revision},env),
      validateIndex:validate,
      hasShard:async(ref,kind)=>{if(!env.BUCKET)return false;const object=await env.BUCKET.head(kind==='match'?matchKey(ref):statisticsKey(ref));return !!object&&object.size===ref.decoded_bytes&&object.customMetadata?.owner===owner&&object.customMetadata?.content_sha256===ref.content_sha256;},
    });
    const result=await pull({token,state});if(result.state)await store.set(key,result.state);
    return {status:result.status,source_revision:result.source_revision,generated_at:result.generated_at,...(result.staged_count!=null?{staged_count:result.staged_count,total_shards:result.total_shards}:{})};
  }});
  async function loadMatch(ref,env) {
    if(!env.BUCKET || !validMatchRef(ref))throw new QueryError('match_unavailable',503);
    const object=await env.BUCKET.get(matchKey(ref));
    if(!object || object.size!==ref.decoded_bytes || object.customMetadata?.owner!==owner || object.customMetadata?.content_sha256!==ref.content_sha256)throw new QueryError('match_unavailable',503);
    const bytes=new Uint8Array(await object.arrayBuffer());
    try{return await verifyMatchBytes(bytes,ref,owner);}catch{throw new QueryError('match_unavailable',503);}
  }
  async function loadStatistics(ref,env) {
    if(!env.BUCKET || !validStatisticsRef(ref))throw new QueryError('statistics_unavailable',503);
    const object=await env.BUCKET.get(statisticsKey(ref));
    if(!object || object.size!==ref.decoded_bytes || object.customMetadata?.owner!==owner || object.customMetadata?.content_sha256!==ref.content_sha256)throw new QueryError('statistics_unavailable',503);
    try{return await verifyStatisticsBytes(new Uint8Array(await object.arrayBuffer()),ref,owner);}catch{throw new QueryError('statistics_unavailable',503);}
  }
  const nativeReaders=new WeakMap();
  const loadNativeCapture=(match,input,env)=>{
    if(!env.BUCKET)return createNativeQueryReader({owner})(match,input);
    if(!nativeReaders.has(env.BUCKET))nativeReaders.set(env.BUCKET,createNativeQueryReader({owner,bucket:env.BUCKET}));
    return nativeReaders.get(env.BUCKET)(match,input);
  };
  const queryOptions=env=>({coach:coachStatus(env),loadMatch:async ref=>(await loadMatch(ref,env)).match,loadStatistics:async ref=>(await loadStatistics(ref,env)).match,loadNativeCapture:(match,input)=>loadNativeCapture(match,input,env)});
  const nativeHandler=createNativeJobHandler({requireIdentity:true,
    loadSnapshot:async env=>(await readStored(env))?.value?.snapshot??initial,
    loadMatch:async(summary,env)=>summary.detail_ref?(await loadMatch(summary.detail_ref,env)).match:summary,
  });
  async function storageOperation(operation,input,env) {
    const storage=operation._cs2_storage;
    if(!storage || storage.version!=='1.0' || !['match_upload','statistics_upload','index_commit'].includes(storage.kind) || !/^[a-f0-9]{40,64}$/.test(storage.source_revision??'') || (input.source_revision && input.source_revision!==storage.source_revision))return json({error:'invalid_storage_operation'},422);
    if(storage.kind==='statistics_upload') {
      const ref=storage.reference;
      if(storage.profile?.steamid64!==owner || !validStatisticsRef(ref) || ref.source_revision!==storage.source_revision || typeof operation.statistics_json!=='string' || Object.keys(operation).some(key=>!['_cs2_storage','statistics_json'].includes(key)))return json({error:'invalid_statistics_upload'},422);
      let verified;
      try{verified=await verifyStatisticsBytes(operation.statistics_json,ref,owner);}catch{return json({error:'invalid_statistics_upload'},422);}
      if(!validate({schema_version:'1.0',generated_at:new Date().toISOString(),profile:{steamid64:owner},matches:[{...verified.match,replay:null,analysis_version:null}]},owner))return json({error:'invalid_statistics_upload'},422);
      const key=statisticsKey(ref),metadata={owner,content_sha256:ref.content_sha256,decoded_bytes:String(ref.decoded_bytes),match_id:ref.match_id,detail_content_sha256:verified.match.detail_ref.content_sha256};
      const existing=await env.BUCKET.head(key);
      if(existing) {
        if(existing.customMetadata?.owner!==owner || existing.customMetadata?.content_sha256!==ref.content_sha256 || existing.customMetadata?.detail_content_sha256!==verified.match.detail_ref.content_sha256 || existing.size!==ref.decoded_bytes)return json({error:'immutable_statistics_conflict'},409);
        return json({status:'unchanged',kind:'statistics_upload',match_id:ref.match_id,content_sha256:ref.content_sha256});
      }
      if(!await env.BUCKET.put(key,verified.bytes,{httpMetadata:{contentType:'application/json'},customMetadata:metadata,onlyIf:{etagDoesNotMatch:'*'}}))return json({error:'concurrent_update_retry_read'},409);
      return json({status:'staged',kind:'statistics_upload',match_id:ref.match_id,content_sha256:ref.content_sha256});
    }
    if(storage.kind==='match_upload') {
      const ref=storage.reference;
      if(storage.profile?.steamid64!==owner || !validMatchRef(ref) || ref.source_revision!==storage.source_revision || typeof operation.match_json!=='string' || Object.keys(operation).some(key=>!['_cs2_storage','match_json'].includes(key)))return json({error:'invalid_match_upload'},422);
      let verified;
      try{verified=await verifyMatchBytes(operation.match_json,ref,owner);}catch{return json({error:'invalid_match_upload'},422);}
      if(!validate({schema_version:'1.0',generated_at:new Date().toISOString(),profile:{steamid64:owner},matches:[verified.match]},owner))return json({error:'invalid_match_upload'},422);
      const key=matchKey(ref),metadata={owner,content_sha256:ref.content_sha256,decoded_bytes:String(ref.decoded_bytes),match_id:ref.match_id};
      const existing=await env.BUCKET.head(key);
      if(existing) {
        if(existing.customMetadata?.owner!==owner || existing.customMetadata?.content_sha256!==ref.content_sha256 || existing.size!==ref.decoded_bytes)return json({error:'immutable_match_conflict'},409);
        return json({status:'unchanged',kind:'match_upload',match_id:ref.match_id,content_sha256:ref.content_sha256});
      }
      const written=await env.BUCKET.put(key,verified.bytes,{httpMetadata:{contentType:'application/json'},customMetadata:metadata,onlyIf:{etagDoesNotMatch:'*'}});
      if(!written)return json({error:'concurrent_update_retry_read'},409);
      return json({status:'staged',kind:'match_upload',match_id:ref.match_id,content_sha256:ref.content_sha256});
    }
    if(typeof operation.index_json!=='string' || Object.keys(operation).some(key=>!['_cs2_storage','index_json'].includes(key)))return json({error:'invalid_index_commit'},422);
    const bytes=new TextEncoder().encode(operation.index_json);
    if(bytes.byteLength>MAX_BODY_BYTES)return json({error:'snapshot_too_large'},413);
    let index;try{index=JSON.parse(operation.index_json);}catch{return json({error:'invalid_index_commit'},422);}
    if(!isMatchIndex(index) || !validate(index,owner) || index._cs2_storage.source_revision!==storage.source_revision)return json({error:'invalid_index_commit'},422);
    const previous=await readStored(env),sha256=await sha256Bytes(bytes);
    if(previous?.value.content_sha256===sha256)return json({status:'unchanged',kind:'index_commit',content_sha256:sha256,source_revision:storage.source_revision,generated_at:index.generated_at,match_count:index.matches.length});
    const previousDate=previous?.value.snapshot?.generated_at||initial.generated_at;
    if(Date.parse(index.generated_at)<Date.parse(previousDate))return json({error:'older_snapshot_rejected',current_generated_at:previousDate},409);
    if(previous)previous.value=null;
    // Only a verified, complete immutable set can replace the visible index.
    for(const ref of index._cs2_storage.match_refs) {
      const object=await env.BUCKET.head(matchKey(ref));
      if(!object || object.size!==ref.decoded_bytes || object.customMetadata?.owner!==owner || object.customMetadata?.content_sha256!==ref.content_sha256)return json({error:'match_shard_not_staged',match_id:ref.match_id},409);
    }
    for(const ref of index._cs2_storage.statistics_refs??[]) {
      const object=await env.BUCKET.head(statisticsKey(ref)),detail=index._cs2_storage.match_refs.find(item=>item.match_id===ref.match_id);
      if(!object || object.size!==ref.decoded_bytes || object.customMetadata?.owner!==owner || object.customMetadata?.content_sha256!==ref.content_sha256 || object.customMetadata?.detail_content_sha256!==detail?.content_sha256)return json({error:'statistics_shard_not_staged',match_id:ref.match_id},409);
    }
    const value={snapshot:index,content_sha256:sha256,source_revision:storage.source_revision,ingested_at:new Date().toISOString()};
    const result=await env.BUCKET.put(KEY,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:previous?{etagMatches:previous.object.etag}:{etagDoesNotMatch:'*'}});
    if(!result)return json({error:'concurrent_update_retry_read'},409);
    return json({status:'updated',kind:'index_commit',content_sha256:sha256,source_revision:storage.source_revision,generated_at:index.generated_at,match_count:index.matches.length});
  }
  async function persistSnapshot(input,env) {
    if(!env.BUCKET)return json({error:'storage_not_configured'},503);
    if(!input || typeof input!=='object' || Array.isArray(input))return json({error:'invalid_personal_snapshot'},422);
    const unpacked=await unpackSnapshot(input.snapshot);
    if(unpacked.error)return json({error:unpacked.error},unpacked.status);
    const snapshot=unpacked.snapshot;
    input.snapshot=null;
    if(['match_upload','statistics_upload','index_commit'].includes(snapshot?._cs2_storage?.kind))return storageOperation(snapshot,input,env);
    if(isMatchIndex(snapshot))return json({error:'index_commit_required'},422);
    if(!validate(snapshot,owner) || (input.source_revision && !/^[a-f0-9]{40,64}$/.test(input.source_revision)))return json({error:'invalid_personal_snapshot'},422);
    let content=JSON.stringify(snapshot);const sha256=await digest(content);
    content=null;
    const previous=await readStored(env);
    if(previous?.value.content_sha256===sha256)return json({status:'unchanged',content_sha256:sha256,generated_at:snapshot.generated_at});
    if(isMatchIndex(previous?.value.snapshot))return json({error:'sharded_snapshot_required'},409);
    const previousDate=previous?.value.snapshot?.generated_at || initial.generated_at;
    if(previous)previous.value=null;
    if(Date.parse(snapshot.generated_at)<Date.parse(previousDate))return json({error:'older_snapshot_rejected',current_generated_at:previousDate},409);
    const value={snapshot,content_sha256:sha256,source_revision:input.source_revision||null,ingested_at:new Date().toISOString()};
    const result=await env.BUCKET.put(KEY,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:previous?{etagMatches:previous.object.etag}:{etagDoesNotMatch:'*'}});
    if(!result)return json({error:'concurrent_update_retry_read'},409);
    return json({status:'updated',content_sha256:sha256,generated_at:snapshot.generated_at,match_count:snapshot.matches.length});
  }
  const handler = {
    async fetch(request,env={},ctx={}) {
      const url=new URL(request.url);
      try {
        if(url.pathname==='/mcp' && request.method==='POST') {
          const body=await readBoundedBody(request);
          if(body.error)return json({error:body.error},body.status);
          let rpc;try{rpc=JSON.parse(new TextDecoder().decode(body.bytes));body.bytes=null;}catch{return json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400);}
          if(!rpc || rpc.jsonrpc!=='2.0' || typeof rpc.method!=='string')return json({jsonrpc:'2.0',id:rpc?.id??null,error:{code:-32600,message:'Invalid request'}},400);
          if(rpc.id===undefined)return new Response(null,{status:202,headers});
          const success=result=>json({jsonrpc:'2.0',id:rpc.id,result});
          const failure=(code,message)=>json({jsonrpc:'2.0',id:rpc.id,error:{code,message}});
          if(rpc.method==='initialize')return success({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(rpc.params?.protocolVersion)?rpc.params.protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'cs2-personal-dashboard',version:'1.0.0'}});
          if(rpc.method==='ping')return success({});
          if(rpc.method==='tools/list')return success({tools:[...QUERY_TOOLS,
            {name:'read_dashboard_status',description:'Read personal CS2 Dashboard freshness, match counts and ingestion revision without returning full trajectories.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
            {name:'update_dashboard',description:'Update this owner-private personal CS2 Dashboard from the validated compact index and immutable detail/statistics shards exported by __GITHUB_REPOSITORY__. Preserve the configured Steam identity and existing metric definitions. Rejects stale or foreign data. No model API is called.',inputSchema:{type:'object',properties:{snapshot:{type:'object',additionalProperties:true},source_revision:{type:'string',pattern:'^[a-f0-9]{40,64}$'}},required:['snapshot'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
          ]});
          if(rpc.method!=='tools/call')return failure(-32601,'Method not found');
          // Connected Site tools act as an authenticated visitor. The separate REST
          // service writer remains available for explicitly configured cloud jobs.
          if(!request.headers.get('oai-authenticated-user-id'))return json({jsonrpc:'2.0',id:rpc.id,error:{code:-32001,message:'Sign in with ChatGPT required'}},401);
          if(['read_data_catalog','query_dashboard_data','discover_raw_data','query_raw_data','read_raw_data_batch'].includes(rpc.params?.name)) {
            const args=rpc.params.arguments??{};
            if(rpc.params.name==='read_data_catalog' && (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length))return failure(-32602,'Invalid arguments');
            const saved=await readStored(env),snapshot=saved?.value.snapshot||initial;
            try {
              const delivery={source_revision:saved?.value.source_revision??null,content_sha256:saved?.value.content_sha256??null,ingested_at:saved?.value.ingested_at??null},options=queryOptions(env);
              let result;
              if(rpc.params.name==='read_raw_data_batch'){
                if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||!Array.isArray(args.queries)||!args.queries.length||args.queries.length>6||new TextEncoder().encode(JSON.stringify(args)).byteLength>16*1024)throw new QueryError('invalid_raw_batch');
                // At most one verified detail shard is retained. Adjacent reads
                // reuse it without keeping six large matches in Worker memory.
                let lastKey=null,lastLoad=null;const loader=options.loadMatch;
                options.loadMatch=reference=>{const key=reference.content_sha256;if(key!==lastKey){lastKey=key;lastLoad=loader(reference);}return lastLoad;};
                const results=[];
                for(const query of args.queries){try{if(!query||typeof query!=='object'||Array.isArray(query)||query.mode!=null&&!['rows','schema'].includes(query.mode)||Object.hasOwn(query,'resource'))throw new QueryError('invalid_raw_query');const {mode,...selection}=query;results.push({status:'complete',data:await runQuery(snapshot,{...selection,resource:mode==='schema'?'raw_schema':'raw_rows'},delivery,options)});}catch(error){results.push({status:'error',...queryError(error)});}}
                result={read_only:true,results,coverage:'Only successful returned pages were read; follow each pagination independently.'};
              }else{
                if(['discover_raw_data','query_raw_data'].includes(rpc.params.name)&&Object.hasOwn(args,'resource'))throw new QueryError('invalid_raw_query');
                const selection=rpc.params.name==='read_data_catalog'?{resource:'catalog'}:rpc.params.name==='discover_raw_data'?{...args,resource:'raw_schema'}:rpc.params.name==='query_raw_data'?{...args,resource:'raw_rows'}:args;
                result=await runQuery(snapshot,selection,delivery,options);
              }
              return success({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
            }catch(error){const result=queryError(error);return success({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:true});}
          }
          if(rpc.params?.name==='read_dashboard_status') {
            const stored=await readStored(env);const snapshot=stored?.value.snapshot||initial;
            const replays=snapshot.matches.map(match=>match.replay).filter(replay=>replay?.coverage?.observed_frames>0);
            const result={generated_at:snapshot.generated_at,match_count:snapshot.matches.length,rounds:snapshot.rounds_analyzed,replay_match_count:replays.length,replay_frames:replays.reduce((sum,replay)=>sum+replay.coverage.observed_frames,0),replay_kills:replays.reduce((sum,replay)=>sum+(replay.coverage.observed_kills||0),0),analysis_versions:[...new Set(snapshot.matches.map(match=>match.analysis_version).filter(Boolean))],source_revision:stored?.value.source_revision||null,content_sha256:stored?.value.content_sha256||null,ingested_at:stored?.value.ingested_at||null,storage_configured:!!env.BUCKET,storage_kind:stored?.value.snapshot?._cs2_storage?.kind??null,statistics_match_count:stored?.value.snapshot?._cs2_storage?.statistics_refs?.length??0,ai_coach:coachStatus(env).status};
            return success({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
          }
          if(rpc.params?.name==='update_dashboard') {
            const args=rpc.params.arguments;
            if(!args || typeof args!=='object' || Object.keys(args).some(k=>!['snapshot','source_revision'].includes(k)))return failure(-32602,'Invalid arguments');
            const response=await persistSnapshot(args,env);
            const result=await response.json();return success({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:!response.ok});
          }
          return failure(-32602,'Unknown tool');
        }
        if (url.pathname==='/api/dashboard' && ['GET','HEAD'].includes(request.method)) {
          const saved=await readStored(env);
          const snapshot=saved?.value?.snapshot || initial;
          if(request.method==='HEAD')return new Response(null,{headers:{...headers,'content-type':'application/json; charset=utf-8'}});
          return json({...snapshot,delivery:{kind:saved?'persisted':'bundled_snapshot',ingested_at:saved?.value?.ingested_at || null,source_revision:saved?.value?.source_revision || null,content_sha256:saved?.value?.content_sha256 || null}});
        }
        if(url.pathname==='/api/statistics' && ['GET','HEAD'].includes(request.method)) {
          if(request.headers.get('origin') && request.headers.get('origin')!==url.origin)return json({error:'origin_rejected'},403);
          const id=url.searchParams.get('match_id'),hash=url.searchParams.get('sha256');
          if(!/^[a-f0-9]{24}$/.test(id??'') || !/^[a-f0-9]{64}$/.test(hash??'') || url.searchParams.getAll('match_id').length!==1 || url.searchParams.getAll('sha256').length!==1)return json({error:'invalid_statistics_request'},400);
          const stored=await readStored(env),snapshot=stored?.value.snapshot||initial,match=snapshot.matches.find(match=>match.match_id===id);
          if(!match)return json({error:'match_not_found'},404);
          const ref=match.statistics_ref;
          if(!validStatisticsRef(ref) || ref.content_sha256!==hash)return json({error:'statistics_revision_mismatch'},409);
          const verified=await loadStatistics(ref,env);
          if(!sameMatchRef(verified.match.detail_ref,match.detail_ref))return json({error:'statistics_revision_mismatch'},409);
          return new Response(request.method==='HEAD'?null:verified.bytes,{headers:{...headers,'content-type':'application/json; charset=utf-8'}});
        }
        if(url.pathname==='/api/match' && ['GET','HEAD'].includes(request.method)) {
          const id=url.searchParams.get('match_id'),hash=url.searchParams.get('sha256');
          if(!/^[a-f0-9]{24}$/.test(id??'') || !/^[a-f0-9]{64}$/.test(hash??'') || url.searchParams.getAll('match_id').length!==1 || url.searchParams.getAll('sha256').length!==1)return json({error:'invalid_match_request'},400);
          const stored=await readStored(env),snapshot=stored?.value.snapshot||initial;
          const current=snapshot.matches.find(match=>match.match_id===id);
          if(!current)return json({error:'match_not_found'},404);
          if(!isMatchIndex(snapshot))return json({error:'match_revision_unavailable'},409);
          let ref=snapshot._cs2_storage.match_refs.find(item=>item.match_id===id && item.content_sha256===hash);
          if(!ref) {
            const object=await env.BUCKET?.head(matchKey({match_id:id,content_sha256:hash}));
            if(!object || object.customMetadata?.owner!==owner)return json({error:'match_revision_mismatch'},409);
            ref={schema_version:'1.0',match_id:id,content_sha256:hash,decoded_bytes:object.size,path:`reports/dashboard.matches/${id}.json`,source_revision:snapshot._cs2_storage.source_revision};
          }
          const verified=await loadMatch(ref,env);
          return new Response(request.method==='HEAD'?null:verified.bytes,{headers:{...headers,'content-type':'application/json; charset=utf-8'}});
        }
        if(url.pathname==='/api/query') {
          try {
            const input=await parseQueryRequest(request),saved=await readStored(env),snapshot=saved?.value.snapshot||initial;
            return json(await runQuery(snapshot,input,{source_revision:saved?.value.source_revision??null,content_sha256:saved?.value.content_sha256??null,ingested_at:saved?.value.ingested_at??null},queryOptions(env)));
          } catch(error) {return json(queryError(error),error instanceof QueryError?error.status:503);}
        }
        if (url.pathname==='/api/ingest' && request.method==='POST') {
          // This shared personal snapshot endpoint relies on the confirmed owner-private
          // Sites dispatch boundary. Service access is consumed by dispatch and carries
          // no visitor identity. Never change this Site's audience to enable an updater.
          const origin=request.headers.get('origin');
          if (origin && origin!==url.origin) return json({error:'origin_rejected'},403);
          if (!env.BUCKET) return json({error:'storage_not_configured'},503);
          if (!request.headers.get('content-type')?.includes('application/json')) return json({error:'json_required'},415);
          const body=await readBoundedBody(request);
          if(body.error)return json({error:body.error},body.status);
          let input; try{input=JSON.parse(new TextDecoder().decode(body.bytes));body.bytes=null;}catch{return json({error:'invalid_json'},400);}
          return persistSnapshot(input,env);
        }
        if(url.pathname==='/api/sync')return syncHandler(request,env);
        if(url.pathname==='/api/native-jobs')return nativeHandler(request,env);
        if(url.pathname==='/api/coach'){
          const key=env.BUCKET||env;
          let coach=coachHandlers.get(key);
          if(!coach){
            coach=createCoachHandler({
              getEnv:()=>env,sessionOwner:owner,sessionStore:env.BUCKET?createR2AgentStore(env.BUCKET):coachMemory,
              loadSnapshot:async()=>{const saved=await readStored(env);return {...(saved?.value.snapshot||initial),delivery:{source_revision:saved?.value.source_revision??null,ingested_at:saved?.value.ingested_at??null,content_sha256:saved?.value.content_sha256??null}};},
              loadMatch:async ref=>(await loadMatch(ref,env)).match,
              loadStatistics:async ref=>(await loadStatistics(ref,env)).match,
              loadNativeCapture:(match,input)=>loadNativeCapture(match,input,env),
            });
            coachHandlers.set(key,coach);
          }
          return coach(request,{...(typeof ctx.waitUntil==='function'?{waitUntil:promise=>ctx.waitUntil(promise)}:{})});
        }
        if (url.pathname==='/health') return json({status:'ok',analysis_api:'1.0',ai_coach:coachStatus(env).status});
        if(request.method==='GET' || request.method==='HEAD') {
          if(assets[url.pathname]) {
            const asset=assets[url.pathname];
            const bytes=request.method==='HEAD'?null:Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0));
            return new Response(bytes,{headers:{...headers,'content-type':asset.type}});
          }
          const asset={
            '/assets/app.js':[client,'text/javascript'],'/assets/styles.css':[css,'text/css'],
            '/assets/players.js':[playersClient,'text/javascript'],'/assets/players.css':[playersCss,'text/css'],
            '/assets/coach.js':[coachClient,'text/javascript'],'/assets/coach.css':[coachCss,'text/css'],
            '/assets/agent-workflow.js':[workflowClient,'text/javascript'],'/assets/agent-workflow.css':[workflowCss,'text/css'],'/assets/agent-reasoning.js':[reasoningClient,'text/javascript'],'/assets/agent-reasoning.css':[reasoningCss,'text/css'],
            '/assets/sync.js':[syncClient,'text/javascript'],'/assets/native-render.js':[nativeClient,'text/javascript'],
            '/assets/native-render.css':[nativeCss,'text/css'],'/assets/agent-visual.js':[visualClient,'text/javascript'],
            '/shared/agent-visual.mjs':[visualSpec,'text/javascript'],'/':[page,'text/html'],
          }[url.pathname];
          if(asset)return new Response(request.method==='HEAD'?null:asset[0],{headers:{...headers,'content-type':asset[1]+'; charset=utf-8'}});
        }
        return json({error:'not_found'},404);
      } catch { return json({error:'service_temporarily_unavailable'},503); }
    },
  };
  return handler;
}
