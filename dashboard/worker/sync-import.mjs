import {MAX_INDEX_BYTES, MAX_MATCH_BYTES, MAX_STATISTICS_BYTES, isMatchIndex, validMatchIndex, verifyMatchBytes, verifyStatisticsBytes} from './storage.mjs';

const IMPORT_API='https://api.github.com/repos/__GITHUB_REPOSITORY__';
const IMPORT_OWNER='__STEAMID64__';
class SnapshotPullError extends Error {constructor(code){super(code);this.code=code;}}
async function importReadBytes(response,limit) {
  if(Number(response.headers.get('content-length')||0)>limit){await response.body?.cancel().catch(()=>{});throw new SnapshotPullError('sync_snapshot_too_large');}
  const reader=response.body?.getReader();if(!reader)throw new SnapshotPullError('sync_snapshot_missing_body');
  const chunks=[];let size=0,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},15000);
  try {
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new SnapshotPullError('sync_snapshot_too_large');}chunks.push(value);}
    if(timedOut)throw new SnapshotPullError('sync_snapshot_timeout');
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
  }finally {clearTimeout(timer);reader.releaseLock();}
}
function importDecode(bytes) {try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new SnapshotPullError('sync_snapshot_invalid_encoding');}}
function importJSON(bytes) {try{return JSON.parse(importDecode(bytes));}catch(error){if(error instanceof SnapshotPullError)throw error;throw new SnapshotPullError('sync_snapshot_invalid_json');}}
function importValidIndex(index,owner,now) {
  if(index?.schema_version!=='1.0'||index.profile?.steamid64!==owner||!Array.isArray(index.matches)||index.matches.length>1000||!isMatchIndex(index)||!validMatchIndex(index)||!Number.isFinite(Date.parse(index.generated_at))||Date.parse(index.generated_at)>now+300000)return false;
  const ids=new Set();
  for(const match of index.matches){
    if(ids.has(match.match_id)||!Array.isArray(match.rounds)||match.rounds.length>100||match.player?.steamid&&match.player.steamid!==owner)return false;
    ids.add(match.match_id);
    for(const round of match.rounds)if(!Number.isInteger(round.round_number)||round.round_number<1||!['T','CT'].includes(round.side)||['kills','deaths','assists','damage','headshot_kills'].some(key=>!Number.isFinite(round[key])||round[key]<0)||round.headshot_kills>round.kills)return false;
  }
  return true;
}
async function importPersist(persistOperation,operation,sourceRevision) {
  let value;
  try {
    const result=await persistOperation(operation,sourceRevision);
    if(result instanceof Response){value=await result.json();if(!result.ok)throw new SnapshotPullError(value.error==='concurrent_update_retry_read'?'sync_snapshot_concurrent_update':'sync_snapshot_commit_rejected');}
    else {value=result;if(value?.error)throw new SnapshotPullError('sync_snapshot_commit_rejected');}
  }catch(error){if(error instanceof SnapshotPullError)throw error;throw new SnapshotPullError('sync_snapshot_storage_unavailable');}
  if(!value||!['staged','updated','unchanged'].includes(value.status))throw new SnapshotPullError('sync_snapshot_commit_rejected');
  return value;
}

async function importAPI(path,token,limit,{raw=false,fetcher=(...args)=>fetch(...args)}={}) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetcher(`${IMPORT_API}${path}`,{redirect:'manual',signal:controller.signal,headers:{Accept:raw?'application/vnd.github.raw+json':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'CS2-Analyst','Authorization':`Bearer ${token}`}});
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw new SnapshotPullError(response.status===401||response.status===403?'sync_snapshot_access_denied':response.status===404?'sync_snapshot_not_found':'sync_snapshot_source_unavailable');}
      return await importReadBytes(response,limit);
    }catch(error){if(error instanceof SnapshotPullError)throw error;throw new SnapshotPullError('sync_snapshot_source_unavailable');}
    finally {clearTimeout(timeout);}
  }

// The caller retains the small cursor in private runtime storage. Every call is
// independently bounded; full historical trajectories are never accumulated.
export function createGitHubSnapshotPull({fetcher=(...args)=>fetch(...args),owner=IMPORT_OWNER,readCurrent=async()=>null,persistOperation,hasShard=async()=>false,validateIndex=null,now=()=>Date.now(),maxShards=4,maxVisited=64,maxDurationMs=20000}={}) {
  if(owner!==IMPORT_OWNER||typeof persistOperation!=='function'||!Number.isInteger(maxShards)||maxShards<1||maxShards>8||!Number.isInteger(maxVisited)||maxVisited<1||maxVisited>128)throw new Error('invalid_snapshot_pull_configuration');
  const api=(path,token,limit,options={})=>importAPI(path,token,limit,{...options,fetcher});
  async function sourceFile(path,commit,token,limit) {return api(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`,token,limit,{raw:true});}
  return async function pullSnapshot({token,state=null}={}) {
    if(typeof token!=='string'||!token.trim())throw new SnapshotPullError('sync_snapshot_not_configured');
    if(state&&(!/^[a-f0-9]{40}$/.test(state.source_commit||'')||!Number.isSafeInteger(state.cursor)||state.cursor<0||state.source_revision!=null&&!/^[a-f0-9]{40,64}$/.test(state.source_revision)))throw new SnapshotPullError('sync_snapshot_invalid_cursor');
    const current=await readCurrent();
    if(state?.source_revision&&current?.source_revision===state.source_revision)return {status:'unchanged',source_commit:state.source_commit,source_revision:state.source_revision,generated_at:current.generated_at};
    let commit=state?.source_commit;
    if(!commit){const head=importJSON(await api('/git/ref/heads/main',token,32768));if(head.ref!=='refs/heads/main'||head.object?.type!=='commit'||!/^[a-f0-9]{40}$/.test(head.object.sha||''))throw new SnapshotPullError('sync_snapshot_invalid_source');commit=head.object.sha;}
    const indexBytes=await sourceFile('reports/dashboard.index.json',commit,token,MAX_INDEX_BYTES),index=importJSON(indexBytes);
    if(!importValidIndex(index,owner,now())||validateIndex&&!validateIndex(index,owner))throw new SnapshotPullError('sync_snapshot_invalid_index');
    const revision=index._cs2_storage.source_revision;
    if(state?.source_revision&&state.source_revision!==revision)throw new SnapshotPullError('sync_snapshot_revision_mismatch');
    if(current?.source_revision===revision)return {status:'unchanged',source_commit:commit,source_revision:revision,generated_at:index.generated_at};
    if(current?.generated_at&&Date.parse(index.generated_at)<Date.parse(current.generated_at))return {status:'unchanged',source_commit:commit,source_revision:current.source_revision,generated_at:current.generated_at};
    const operations=[...index._cs2_storage.match_refs.map(ref=>({kind:'match',ref})),...(index._cs2_storage.statistics_refs||[]).map(ref=>({kind:'statistics',ref}))];
    let cursor=state?.cursor||0,staged=0,visited=0;const started=now();
    if(cursor>operations.length)throw new SnapshotPullError('sync_snapshot_invalid_cursor');
    while(cursor<operations.length&&staged<maxShards&&visited<maxVisited&&(visited===0||now()-started<maxDurationMs)){
      const {kind,ref}=operations[cursor];visited++;
      if(!await hasShard(ref,kind)){
        const bytes=await sourceFile(ref.path,commit,token,kind==='match'?MAX_MATCH_BYTES:MAX_STATISTICS_BYTES);
        try {if(kind==='match')await verifyMatchBytes(bytes,ref,owner);else await verifyStatisticsBytes(bytes,ref,owner);}catch{throw new SnapshotPullError('sync_snapshot_shard_invalid');}
        const operation={_cs2_storage:{version:'1.0',kind:kind==='match'?'match_upload':'statistics_upload',source_revision:revision,profile:{steamid64:owner},reference:ref},[kind==='match'?'match_json':'statistics_json']:importDecode(bytes)};
        await importPersist(persistOperation,operation,revision);staged++;
      }
      cursor++;
    }
    const nextState={source_commit:commit,source_revision:revision,cursor};
    if(cursor<operations.length)return {status:'publishing',source_commit:commit,source_revision:revision,generated_at:index.generated_at,staged_count:cursor,total_shards:operations.length,state:nextState};
    const result=await importPersist(persistOperation,{_cs2_storage:{version:'1.0',kind:'index_commit',source_revision:revision},index_json:importDecode(indexBytes)},revision);
    return {status:result.status==='unchanged'?'unchanged':'updated',source_commit:commit,source_revision:revision,generated_at:index.generated_at,match_count:index.matches.length,state:nextState};
  };
}

// Read only the next deployment target. Netlify uses this to wait for its
// replacement function bundle; the read never downloads historical shards.
export async function readGitHubSnapshotRevision({token,sourceCommit=null,fetcher=(...args)=>fetch(...args),owner=IMPORT_OWNER,now=()=>Date.now()}={}) {
  if(typeof token!=='string'||!token.trim()||owner!==IMPORT_OWNER)throw new SnapshotPullError('sync_snapshot_not_configured');
  let commit=sourceCommit;
  if(commit&&!/^[a-f0-9]{40}$/.test(commit))throw new SnapshotPullError('sync_snapshot_invalid_source');
  if(!commit){const head=importJSON(await importAPI('/git/ref/heads/main',token,32768,{fetcher}));if(head.ref!=='refs/heads/main'||head.object?.type!=='commit'||!/^[a-f0-9]{40}$/.test(head.object.sha||''))throw new SnapshotPullError('sync_snapshot_invalid_source');commit=head.object.sha;}
  const index=importJSON(await importAPI(`/contents/reports/dashboard.index.json?ref=${commit}`,token,MAX_INDEX_BYTES,{raw:true,fetcher}));
  if(!importValidIndex(index,owner,now()))throw new SnapshotPullError('sync_snapshot_invalid_index');
  return {source_commit:commit,source_revision:index._cs2_storage.source_revision,generated_at:index.generated_at,match_count:index.matches.length};
}
