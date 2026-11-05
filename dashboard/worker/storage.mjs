// Shared immutable match-shard contract. Hashes cover exact source bytes.
export const MAX_MATCH_BYTES = 16 * 1024 * 1024;
export const MAX_STATISTICS_BYTES = 16 * 1024 * 1024;
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;
export const isMatchIndex = value => value?._cs2_storage?.kind === 'match_index';
export const matchKey = ref => `dashboard/matches/${ref.match_id}/${ref.content_sha256}.json`;
export const statisticsKey = ref => `dashboard/statistics/${ref.match_id}/${ref.content_sha256}.json`;
function validReference(ref,directory,maxBytes) {
  return !!ref && ref.schema_version === '1.0' && /^[a-f0-9]{24}$/.test(ref.match_id)
    && /^[a-f0-9]{64}$/.test(ref.content_sha256)
    && Number.isSafeInteger(ref.decoded_bytes) && ref.decoded_bytes > 1 && ref.decoded_bytes <= maxBytes
    && ref.path === `reports/${directory}/${ref.match_id}.json`
    && /^[a-f0-9]{40,64}$/.test(ref.source_revision ?? '');
}
export const validMatchRef = ref => validReference(ref,'dashboard.matches',MAX_MATCH_BYTES);
export const validStatisticsRef = ref => validReference(ref,'dashboard.statistics',MAX_STATISTICS_BYTES);
const referenceFields=['schema_version','match_id','content_sha256','decoded_bytes','path','source_revision'];
export function sameMatchRef(a,b) {
  return validMatchRef(a) && validMatchRef(b) && referenceFields.every(key=>a[key]===b[key]);
}
export const sameStatisticsRef = (a,b) => validStatisticsRef(a) && validStatisticsRef(b) && referenceFields.every(key=>a[key]===b[key]);
export function validMatchIndex(snapshot) {
  if(snapshot?._cs2_storage == null)return true;
  const storage=snapshot._cs2_storage;
  if(storage.version!=='1.0' || storage.kind!=='match_index' || !/^[a-f0-9]{40,64}$/.test(storage.source_revision??'') || storage.source_generated_at!==snapshot.generated_at || !Array.isArray(storage.match_refs) || storage.match_refs.length!==snapshot.matches?.length)return false;
  const refs=new Map();
  for(const ref of storage.match_refs) {
    if(!validMatchRef(ref) || ref.source_revision!==storage.source_revision || refs.has(ref.match_id))return false;
    refs.set(ref.match_id,ref);
  }
  if(!snapshot.matches.every(match=>sameMatchRef(match.detail_ref,refs.get(match.match_id))))return false;
  if(storage.source_report_sha256!=null && !/^[a-f0-9]{64}$/.test(storage.source_report_sha256))return false;
  if(storage.source_report_bytes!=null && (!Number.isSafeInteger(storage.source_report_bytes) || storage.source_report_bytes<2))return false;
  if(storage.statistics_refs==null)return snapshot.matches.every(match=>match.statistics_ref==null);
  if(!Array.isArray(storage.statistics_refs) || storage.statistics_refs.length!==snapshot.matches.length)return false;
  const statistics=new Map();
  for(const ref of storage.statistics_refs) {
    if(!validStatisticsRef(ref) || ref.source_revision!==storage.source_revision || statistics.has(ref.match_id))return false;
    statistics.set(ref.match_id,ref);
  }
  return snapshot.matches.every(match=>sameStatisticsRef(match.statistics_ref,statistics.get(match.match_id)));
}
export async function sha256Bytes(value) {
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
}
export async function verifyMatchBytes(source,ref,owner) {
  if(!validMatchRef(ref))throw new Error('invalid_match_ref');
  const bytes=typeof source==='string'?new TextEncoder().encode(source):source;
  if(bytes.byteLength!==ref.decoded_bytes || bytes.byteLength>MAX_MATCH_BYTES)throw new Error('invalid_match_length');
  if(await sha256Bytes(bytes)!==ref.content_sha256)throw new Error('invalid_match_hash');
  const match=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(match?.match_id!==ref.match_id || !Array.isArray(match.rounds) || match.rounds.length>100 || (match.player?.steamid && match.player.steamid!==owner))throw new Error('invalid_match_identity');
  return {match,bytes};
}
export async function verifyStatisticsBytes(source,ref,owner) {
  if(!validStatisticsRef(ref))throw new Error('invalid_statistics_ref');
  const bytes=typeof source==='string'?new TextEncoder().encode(source):source;
  if(bytes.byteLength!==ref.decoded_bytes || bytes.byteLength>MAX_STATISTICS_BYTES)throw new Error('invalid_statistics_length');
  if(await sha256Bytes(bytes)!==ref.content_sha256)throw new Error('invalid_statistics_hash');
  const match=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(match?.match_id!==ref.match_id || !Array.isArray(match.rounds) || match.rounds.length>100 || (match.player?.steamid && match.player.steamid!==owner) || !validMatchRef(match.detail_ref) || match.detail_ref.match_id!==ref.match_id || match.detail_ref.source_revision!==ref.source_revision || match.statistics_ref!=null || match._cs2_storage!=null)throw new Error('invalid_statistics_identity');
  return {match,bytes};
}

const clone = value => structuredClone(value);
const projectionOwn = (value,key) => value != null && Object.hasOwn(value,key);
const RESERVED = ['_cs2_storage','_cs2_deferred','detail_ref','statistics_ref'];
function checkReserved(value) {
  if(Array.isArray(value)){for(const child of value)checkReserved(child);return;}
  if(!value || typeof value!=='object')return;
  if(RESERVED.some(key=>projectionOwn(value,key)))throw Error('reserved_projection_field_in_source');
  for(const child of Object.values(value))checkReserved(child);
}
function defer(parent,key,path) {
  if(!parent || !projectionOwn(parent,key) || parent[key]===null)return;
  const value=parent[key];delete parent[key];
  const meta={path:[...path,key],kind:Array.isArray(value)?'array':typeof value==='object'?'object':'text'};
  if(Array.isArray(value))meta.count=value.length;
  if(value && typeof value==='object' && !Array.isArray(value))for(const name of ['encoding','count','decoded_bytes'])if(projectionOwn(value,name))meta[name]=value[name];
  (parent._cs2_deferred??={})[key]=meta;
}
function analysis(value,path) {
  if(!value || typeof value!=='object')return;
  const l3=value.level3??{},mechanics=l3.mechanics??{};
  for(const name of ['crosshair','counter_strafe'])for(const [i,row]of (l3[name]?.observations??[]).entries())for(const key of ['trace','points','samples'])defer(row,key,[...path,'level3',name,'observations',String(i)]);
  for(const name of ['targeting','stopping'])for(const [i,row]of (mechanics[name]?.observations??[]).entries())defer(row,'trace',[...path,'level3','mechanics',name,'observations',String(i)]);
  for(const [i,row]of (mechanics.aim_playback?.windows??[]).entries())for(const key of ['trajectory','points','targets','geometry'])defer(row,key,[...path,'level3','mechanics','aim_playback','windows',String(i)]);
}
export function projectMatch(match,ref) {
  const result=clone(match);analysis(result.analysis,['analysis']);
  for(const [i,row]of (result.rounds??[]).entries())analysis(row.analysis,['rounds',String(i),'analysis']);
  // Round statistics and weapon totals stay immediately available. Event
  // streams are read from the complete immutable match for detail views.
  for(const [playerIndex,player]of (result.players??[]).entries())for(const [roundIndex,round]of (player.rounds??[]).entries())defer(round,'events',['players',String(playerIndex),'rounds',String(roundIndex)]);
  for(const [i,row]of (result.replay?.rounds??[]).entries()){
    const path=['replay','rounds',String(i)];
    for(const key of ['frames','shots']){
      if(row[key]?.encoding==='gzip-base64-json')defer(row[key],'data',[...path,key]);
      else defer(row,key,path);
    }
    for(const key of ['tactical','damage_events','unassociated_impacts'])defer(row,key,path);
  }
  result.detail_ref=clone(ref);return result;
}
export function projectCoreMatch(statistics,ref) {
  const result=clone(statistics);
  if(!projectionOwn(result,'coverage') && statistics.analysis?.coverage && typeof statistics.analysis.coverage==='object')result.coverage=clone(statistics.analysis.coverage);
  for(const key of ['analysis','positions','events','training_plan','capability_details'])defer(result,key,[]);
  for(const [i,round]of (result.rounds??[]).entries())for(const key of ['analysis','events','positions','aim','positioning','utility','economy'])defer(round,key,['rounds',String(i)]);
  for(const [i,player]of (result.players??[]).entries())for(const key of ['rounds','by_side','by_weapon'])defer(player,key,['players',String(i)]);
  defer(result.replay,'rounds',['replay']);
  result.statistics_ref=clone(ref);
  return result;
}
export function projectSnapshot(snapshot,refs,{sourceRevision=null,statisticsRefs=null}={}) {
  checkReserved(snapshot);
  const index=clone(snapshot),byId=new Map(refs.map(ref=>[ref.match_id,ref]));
  if(byId.size!==snapshot.matches.length || refs.length!==byId.size)throw Error('invalid_shard_manifest');
  const statisticsById=statisticsRefs&&new Map(statisticsRefs.map(ref=>[ref.match_id,ref]));
  if(statisticsRefs && (statisticsById.size!==snapshot.matches.length || statisticsRefs.length!==statisticsById.size))throw Error('invalid_statistics_manifest');
  index.matches=snapshot.matches.map(match=>{const ref=byId.get(match.match_id);if(!ref)throw Error('missing_match_reference');const statistics=projectMatch(match,ref);if(!statisticsRefs)return statistics;const statisticsRef=statisticsById.get(match.match_id);if(!validStatisticsRef(statisticsRef))throw Error('missing_statistics_reference');return projectCoreMatch(statistics,statisticsRef);});
  index._cs2_storage={version:'1.0',kind:'match_index',source_revision:sourceRevision,source_generated_at:snapshot.generated_at??null,match_refs:clone(refs)};
  if(statisticsRefs)index._cs2_storage.statistics_refs=clone(statisticsRefs);
  return index;
}
