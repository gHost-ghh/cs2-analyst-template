/** Owner-authenticated native capture jobs. The browser relays local captures;
 * no endpoint bypasses the host's existing private-site gate. */
export const NATIVE_VERSION='1.0';
export const NATIVE_PART_BYTES=256*1024;
export const NATIVE_MAX_PART_BYTES=4*1024*1024;
export const NATIVE_MAX_VIDEO_BYTES=24*1024*1024;
export const NATIVE_MAX_EVIDENCE_BYTES=4*1024*1024;
export const NATIVE_MAX_JOB_BYTES=256*1024*1024;
export const NATIVE_JOB_TTL_MS=2*60*60*1000;
const MAX_JSON=128*1024,MAX_CLIPS=16,MAX_SECONDS=180;
const ID=/^[a-f0-9]{24}$/,SHA=/^[a-f0-9]{64}$/,REV=/^[a-f0-9]{40,64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ARTIFACT=/^[a-z0-9][a-z0-9_-]{0,79}$/;
const BURST=/^[a-zA-Z0-9:_-]{1,128}$/;
const encoder=new TextEncoder();
const headers={'cache-control':'private, no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'same-origin','x-robots-tag':'noindex, nofollow'};
class NativeError extends Error {constructor(code,status=422){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new NativeError(code,status);};
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{...headers,...extra}});
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const safeKeys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const bytesOf=value=>value instanceof Uint8Array?value:new Uint8Array(value);
async function boundedBody(request,limit){
  const size=request.headers.get('content-length');if(size!=null&&(!/^\d+$/.test(size)||Number(size)>limit))fail('native_request_too_large',413);
  const reader=request.body?.getReader();if(!reader)fail('native_body_required',400);
  const chunks=[];let total=0;
  try {while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();fail('native_request_too_large',413);}chunks.push(value);}}
  finally {reader.releaseLock();}
  const out=new Uint8Array(total);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}return out;
}
async function readJSON(request){if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))fail('json_required',415);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBody(request,MAX_JSON)));}catch(error){if(error instanceof NativeError)throw error;fail('invalid_native_request',400);}}
function nonce(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');}
function root(owner){return `native/v1/${owner}/`;}
function jobKey(owner,id){return `${root(owner)}jobs/${id}/job.json`;}
function manifestKey(owner,id){return `${root(owner)}jobs/${id}/manifest.json`;}
function completeKey(owner,id){return `${root(owner)}jobs/${id}/complete.json`;}
function partKey(owner,id,artifact,index){return `${root(owner)}jobs/${id}/parts/${artifact}/${String(index).padStart(5,'0')}`;}
function clipKey(owner,sha,fingerprint){return `${root(owner)}clips/${sha}/${fingerprint}.json`;}
function analysisClipKey(owner,sha,analysis,fingerprint){return `${root(owner)}clips/${sha}/${analysis}/${fingerprint}.json`;}
async function nativeAnalysisDigest(match,summary=match){
  const analysis=summary.detail_ref?.content_sha256??await hash(encoder.encode(JSON.stringify(match)));
  if(!SHA.test(analysis??''))fail('native_analysis_unavailable',503);return analysis;
}
const fingerprint=clip=>hash(encoder.encode(JSON.stringify([clip.burst_id,clip.start_tick,clip.finish_tick])));
const publicJob=(job,state='awaiting_local_render')=>({version:NATIVE_VERSION,job_id:job.job_id,match_id:job.match_id,source_revision:job.source_revision,analysis_sha256:job.analysis_sha256,source_sha256:job.plan.source_sha256,state,created_at:new Date(job.created_ms).toISOString(),expires_at:new Date(job.expires_ms).toISOString(),plan:job.plan,demo:job.demo});

export function createR2NativeStore(bucket){return {
  async getJSON(key){const object=await bucket.get(key);if(object?.size>256*1024)fail('native_metadata_too_large');return object?object.json():null;},
  async claimJSON(key,value){return !!await bucket.put(key,JSON.stringify(value),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});},
  async getPart(key){const object=await bucket.get(key);if(object?.size>NATIVE_MAX_PART_BYTES)fail('native_part_too_large');return object?{bytes:new Uint8Array(await object.arrayBuffer()),metadata:object.customMetadata??{}}:null;},
  async headPart(key){const object=await bucket.head(key);return object?{bytes:object.size,metadata:object.customMetadata??{}}:null;},
  async claimPart(key,bytes,metadata){return !!await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:Object.fromEntries(Object.entries(metadata).map(([key,value])=>[key,String(value)]))});},
};}

export function nativeDemoURL(value){
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f]/.test(value))fail('invalid_native_demo_source');
  let url;try{url=new URL(value);}catch{fail('invalid_native_demo_source');}
  const authority=/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
  if(!['http:','https:'].includes(url.protocol)||authority?.toLowerCase()!==url.hostname||url.username||url.password||url.port||url.hash||url.search||url.hostname.length>253||!/^replay\d+\.(?:valve\.net|wmsj\.cn|csgo\.com\.cn)$/.test(url.hostname)||!/^\/730\/[a-zA-Z0-9_.-]{1,256}\.dem(?:\.bz2)?$/.test(url.pathname))fail('invalid_native_demo_source');
  return url.href;
}

export function createNativeSourceReader({fetcher=(...args)=>fetch(...args)}={}){
  // This private fixed repository file is never copied into browser assets.
  const endpoint='https://api.github.com/repos/__GITHUB_REPOSITORY__/contents/data/native_render_sources.json?ref=main';
  return async function readSource(match,env={}){
    if(!env.GITHUB_ACTIONS_TOKEN)return null;
    let response;try{response=await fetcher(endpoint,{headers:{Authorization:`Bearer ${env.GITHUB_ACTIONS_TOKEN}`,Accept:'application/vnd.github.raw+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'cs2-native-render/1.0'},redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{fail('native_demo_source_unavailable',503);}
    if(response.status===404){await response.body?.cancel().catch(()=>{});return null;}
    if(!response.ok){await response.body?.cancel().catch(()=>{});fail('native_demo_source_unavailable',503);}
    let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBody(response,2*1024*1024)));}catch{fail('invalid_native_demo_manifest',503);}
    if(input?.version!=='1.0'||input.owner_steamid!==env.NATIVE_OWNER_STEAM_ID||!input.matches||typeof input.matches!=='object'||Array.isArray(input.matches))fail('invalid_native_demo_manifest',503);
    const source=input.matches[match.match_id];if(!source)return null;
    const expected=match.provenance?.source_sha256??match.provenance?.sha256;
    if(source.sha256!==expected||!integer(source.bytes,16,8*1024*1024*1024))fail('native_demo_source_mismatch',409);
    const url=nativeDemoURL(source.url);
    return {status:'available',url,sha256:expected,bytes:source.bytes,compression:new URL(url).pathname.endsWith('.bz2')?'bz2':'none'};
  };
}

function windows(match){const list=[];for(const round of match.rounds??[])for(const clip of round.analysis?.level3?.mechanics?.aim_playback?.windows??[]){if(!BURST.test(clip.burst_id??'')||!integer(clip.start_tick,0,2**31-1)||!integer(clip.finish_tick,clip.start_tick+1,2**31-1))continue;list.push({...clip,round_number:round.round_number});}return list.sort((a,b)=>a.start_tick-b.start_tick||a.finish_tick-b.finish_tick||a.burst_id.localeCompare(b.burst_id));}
export function createNativePlan(match,owner,burstIds){
  const sha=match.provenance?.source_sha256??match.provenance?.sha256,tickrate=match.provenance?.tickrate;
  if(!SHA.test(sha??'')||!Number.isFinite(tickrate)||tickrate<16||tickrate>256)fail('native_source_identity_unavailable',409);
  const candidates=windows(match),requested=new Set(burstIds);
  if(!burstIds.length||burstIds.length>MAX_CLIPS||requested.size!==burstIds.length||burstIds.some(id=>!BURST.test(id)))fail('invalid_native_clip_selection',400);
  const selected=candidates.filter(clip=>requested.has(clip.burst_id));if(selected.length!==requested.size)fail('native_clip_not_found',404);
  let seconds=0;
  const clips=selected.map((clip,index)=>{
    const duration=(clip.finish_tick-clip.start_tick)/tickrate;if(duration>20)fail('native_clip_too_long',422);seconds+=duration;
    const shot_ticks=[...new Set((clip.shot_markers??[]).map(row=>Array.isArray(row)?row[0]:row.tick).filter(tick=>integer(tick,clip.start_tick,clip.finish_tick)))].sort((a,b)=>a-b);
    if(!shot_ticks.length)fail('native_clip_has_no_shots',422);
    return {clip_id:String(index).padStart(3,'0'),burst_id:clip.burst_id,round_number:clip.round_number,start_tick:clip.start_tick,finish_tick:clip.finish_tick,preroll_tick:Math.max(0,clip.start_tick-Math.round(tickrate*3)),shot_ticks,target_steamids:[...new Set((clip.targets??[]).map(target=>String(target.steamid)).filter(id=>/^\d{17}$/.test(id)))].sort(),duration_seconds:duration};
  });
  if(seconds>MAX_SECONDS)fail('native_capture_budget_exceeded',422);
  return {version:NATIVE_VERSION,kind:'cs2_engine_capture_plan',status:'awaiting_local_render',match_id:match.match_id,owner_steamid:owner,source_sha256:sha,map_name:match.map_name,tickrate,fps:120,expected_demo_build:match.provenance?.demo_build??null,clips,capture_seconds:seconds,available_clips:candidates.length,truncated:clips.length<candidates.length,outputs:['native_pov_video','frame_alignment_evidence'],evaluated_bone_matrices:false,exact_animation_rendered:false};
}

function checkedReceipt(receipt,job){
  if(!safeKeys(receipt,['version','job_id','match_id','source_sha256','engine','clips'])||receipt.version!==NATIVE_VERSION||receipt.job_id!==job.job_id||receipt.match_id!==job.match_id||receipt.source_sha256!==job.plan.source_sha256||!Array.isArray(receipt.clips)||receipt.clips.length!==job.plan.clips.length)fail('invalid_native_receipt');
  if(!safeKeys(receipt.engine,['renderer','capture_adapter','game_build','hlae_version'])||receipt.engine.renderer!=='CS2/HLAE'||receipt.engine.capture_adapter!=='1.0'||!['game_build','hlae_version'].every(key=>typeof receipt.engine[key]==='string'&&receipt.engine[key].length>=1&&receipt.engine[key].length<=128))fail('invalid_native_engine_receipt');
  const ids=new Set(),clipIds=new Set();let total=0;
  for(const clip of receipt.clips){
    const expected=job.plan.clips.find(row=>row.clip_id===clip.clip_id);
    if(!safeKeys(clip,['clip_id','burst_id','fps','width','height','start_tick','finish_tick','first_frame_tick','first_frame_time','frame_count','artifacts'])||!expected||clipIds.has(clip.clip_id)||clip.burst_id!==expected.burst_id||clip.start_tick!==expected.start_tick||clip.finish_tick!==expected.finish_tick||!Number.isFinite(clip.first_frame_tick)||clip.first_frame_tick<clip.start_tick||clip.first_frame_tick>clip.start_tick+2||!Number.isFinite(clip.first_frame_time)||clip.first_frame_time<0||clip.fps!==job.plan.fps||!integer(clip.width,320,3840)||!integer(clip.height,240,2160)||!integer(clip.frame_count,1,5000)||!Array.isArray(clip.artifacts)||clip.artifacts.length<2||clip.artifacts.length>3)fail('invalid_native_clip_receipt');
    clipIds.add(clip.clip_id);const kinds=new Set();
    for(const artifact of clip.artifacts){
      if(!safeKeys(artifact,['artifact_id','kind','content_type','bytes','sha256','part_count','part_bytes','ffprobe','layout','display_width'])||!ARTIFACT.test(artifact.artifact_id??'')||ids.has(artifact.artifact_id)||!['pov','matte','evidence'].includes(artifact.kind)||kinds.has(artifact.kind)||!SHA.test(artifact.sha256??'')||!integer(artifact.part_bytes,1024,NATIVE_MAX_PART_BYTES)||!integer(artifact.bytes,1,artifact.kind==='evidence'?NATIVE_MAX_EVIDENCE_BYTES:NATIVE_MAX_VIDEO_BYTES)||artifact.part_count!==Math.ceil(artifact.bytes/artifact.part_bytes)||artifact.content_type!==(artifact.kind==='evidence'?'application/x-ndjson':'video/mp4'))fail('invalid_native_artifact');
      if(artifact.kind==='matte'?(artifact.layout!=='color-mask-side-by-side'||artifact.display_width!==clip.width):(artifact.layout!=null||artifact.display_width!=null))fail('invalid_native_artifact');
      kinds.add(artifact.kind);ids.add(artifact.artifact_id);total+=artifact.bytes;
      if(artifact.kind!=='evidence'){
        const p=artifact.ffprobe;
        if(!safeKeys(p,['codec_name','width','height','avg_frame_rate','nb_frames','duration'])||!['h264','hevc'].includes(p.codec_name)||p.width!==clip.width*(artifact.kind==='matte'?2:1)||p.height!==clip.height||Number(p.nb_frames)!==clip.frame_count||!Number.isFinite(Number(p.duration))||Number(p.duration)<=0||Number(p.duration)>22||typeof p.avg_frame_rate!=='string'||!/^\d+\/\d+$/.test(p.avg_frame_rate)||Math.abs(p.avg_frame_rate.split('/').map(Number).reduce((a,b)=>a/b)-clip.fps)>.02||Math.abs(Number(p.duration)-clip.frame_count/clip.fps)>.1)fail('invalid_native_media_probe');
      }else if(artifact.ffprobe!=null)fail('invalid_native_artifact');
    }
    if(!kinds.has('pov')||!kinds.has('evidence'))fail('native_required_artifact_missing');
  }
  if(total>NATIVE_MAX_JOB_BYTES)fail('native_capture_budget_exceeded',413);
  return receipt;
}

function boxes(bytes,start=0,end=bytes.byteLength){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),out=[];let offset=start;
  while(offset<end){if(offset+8>end)fail('invalid_native_mp4');let size=view.getUint32(offset),head=8;
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if(size===1){if(offset+16>end)fail('invalid_native_mp4');const large=view.getBigUint64(offset+8);if(large>BigInt(Number.MAX_SAFE_INTEGER))fail('invalid_native_mp4');size=Number(large);head=16;}else if(size===0)size=end-offset;
    if(size<head||offset+size>end)fail('invalid_native_mp4');out.push({type,start:offset+head,end:offset+size,size});offset+=size;
  }return out;
}
/** Inspect the real MP4 sample table instead of trusting a supplied FFprobe JSON. */
export function validateNativeMP4(bytes,clip,artifact){
  const b=bytesOf(bytes),view=new DataView(b.buffer,b.byteOffset,b.byteLength),top=boxes(b),moov=top.find(box=>box.type==='moov');
  if(!top.some(box=>box.type==='ftyp')||!top.some(box=>box.type==='mdat')||!moov)fail('invalid_native_mp4');
  let found=false;
  for(const trak of boxes(b,moov.start,moov.end).filter(box=>box.type==='trak')){
    const entries=boxes(b,trak.start,trak.end),mdia=entries.find(box=>box.type==='mdia'),tkhd=entries.find(box=>box.type==='tkhd');if(!mdia||!tkhd)continue;
    const media=boxes(b,mdia.start,mdia.end),hdlr=media.find(box=>box.type==='hdlr');if(!hdlr||hdlr.end-hdlr.start<12||String.fromCharCode(...b.subarray(hdlr.start+8,hdlr.start+12))!=='vide')continue;
    const mdhd=media.find(box=>box.type==='mdhd'),minf=media.find(box=>box.type==='minf');if(!mdhd||!minf||tkhd.end-tkhd.start<8)fail('invalid_native_mp4');
    const version=b[mdhd.start];if(![0,1].includes(version))fail('invalid_native_mp4');
    const shift=version===1?20:12;if(mdhd.end-mdhd.start<shift+(version===1?12:8))fail('invalid_native_mp4');
    const scale=view.getUint32(mdhd.start+shift),duration=b[mdhd.start]===1?Number(view.getBigUint64(mdhd.start+shift+4)):view.getUint32(mdhd.start+shift+4);
    const width=view.getUint32(tkhd.end-8)/65536,height=view.getUint32(tkhd.end-4)/65536;
    const stbl=boxes(b,minf.start,minf.end).find(box=>box.type==='stbl');if(!stbl)fail('invalid_native_mp4');
    const table=boxes(b,stbl.start,stbl.end),stsz=table.find(box=>box.type==='stsz'),stsd=table.find(box=>box.type==='stsd'),stts=table.find(box=>box.type==='stts');
    if(!stsz||stsz.end-stsz.start<12||!stsd||stsd.end-stsd.start<16||!stts||stts.end-stts.start<8)fail('invalid_native_mp4');
    const count=view.getUint32(stsz.start+8),codec=String.fromCharCode(...b.subarray(stsd.start+12,stsd.start+16));
    if(!['avc1','avc3','hvc1','hev1'].includes(codec)||width!==clip.width*(artifact.kind==='matte'?2:1)||height!==clip.height||count!==clip.frame_count||scale===0||!Number.isFinite(duration)||Math.abs(duration/scale-count/clip.fps)>.1||(['avc1','avc3'].includes(codec)?'h264':'hevc')!==artifact.ffprobe.codec_name)fail('native_media_probe_mismatch');
    const sampleSize=view.getUint32(stsz.start+4),entriesCount=view.getUint32(stts.start+4);
    if(!sampleSize&&stsz.end-stsz.start!==12+count*4||entriesCount>count||stts.end-stts.start!==8+entriesCount*8)fail('invalid_native_mp4');
    let sampleBytes=sampleSize*count,sampleCount=0,sampleDuration=0;
    if(!sampleSize){sampleBytes=0;for(let index=0;index<count;index++){const size=view.getUint32(stsz.start+12+index*4);if(!size)fail('invalid_native_mp4');sampleBytes+=size;}}
    for(let index=0;index<entriesCount;index++){const offset=stts.start+8+index*8,n=view.getUint32(offset),delta=view.getUint32(offset+4);if(!n||!delta)fail('invalid_native_mp4');sampleCount+=n;sampleDuration+=n*delta;}
    if(sampleBytes<1||sampleBytes>top.filter(box=>box.type==='mdat').reduce((sum,box)=>sum+box.end-box.start,0)||sampleCount!==count||Math.abs(sampleDuration-duration)>scale*.1)fail('invalid_native_mp4');
    found=true;
  }
  if(!found)fail('native_video_track_missing');
}

export function validateNativeEvidence(bytes,job,clip){
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{fail('invalid_native_frame_evidence');}
  const planned=job.plan.clips.find(row=>row.clip_id===clip.clip_id);let start=null,end=null,complete=false,lastTick=-Infinity,lastTime=-Infinity,frames=0;
  for(const line of text.split(/\r?\n/)){
    if(!line.trim())continue;if(line.length>32*1024)fail('invalid_native_frame_evidence');
    let row;try{row=JSON.parse(line);}catch{fail('invalid_native_frame_evidence');}
    if(row.type==='failed')fail('native_capture_failed');
    if(row.type==='complete'){if(row.source_sha256!==job.plan.source_sha256||row.match_id!==job.match_id||row.reason!=='complete')fail('invalid_native_frame_evidence');complete=true;continue;}
    if(row.clip_id!==clip.clip_id)continue;
    if(row.type==='clip_start'){
      if(start||row.source_sha256!==job.plan.source_sha256||row.owner_steamid!==job.owner||row.camera_mode!=='verified_native_spectator'||!Number.isFinite(row.tick)||row.tick<planned.start_tick||row.tick>planned.start_tick+2)fail('native_camera_alignment_failed');start=row;
    }else if(row.type==='frame'){
      if(!start||end||row.frame!==frames||!Number.isFinite(row.tick)||row.tick<planned.start_tick||row.tick>planned.finish_tick||row.tick<lastTick||!Number.isFinite(row.time)||row.time<=lastTime||frames===0&&(row.tick!==clip.first_frame_tick||row.time!==clip.first_frame_time)||!vector(row.camera?.position)||!vector(row.camera?.angles)||!Number.isFinite(row.camera?.fov)||row.camera.fov<20||row.camera.fov>179||!Array.isArray(row.viewport)||row.viewport[0]!==clip.width||row.viewport[1]!==clip.height||!Array.isArray(row.players)||row.players.length>64)fail('invalid_native_frame_evidence');
      const pawn=row.players.find(player=>String(player.steamid)===job.owner);
      if(!pawn||!vector(pawn.origin)||!Number.isFinite(pawn.health))fail('native_owner_frame_missing');
      // The native spectator camera must remain at the owner's eye throughout.
      const [x,y,z]=row.camera.position,origin=pawn.origin;
      if(Math.hypot(x-origin[0],y-origin[1])>6||z-origin[2]<12||z-origin[2]>85)fail('native_camera_alignment_failed');
      frames++;lastTick=row.tick;lastTime=row.time;
    }else if(row.type==='clip_end'){
      if(!start||end||row.frames!==frames||row.camera_rejected!==false||!Number.isFinite(row.tick)||row.tick<=planned.finish_tick||row.tick>planned.finish_tick+4)fail('native_frame_coverage_mismatch');end=row;
    }
  }
  const expectedSeconds=(planned.finish_tick-planned.start_tick)/job.plan.tickrate;
  if(!start||!end||!complete||frames!==clip.frame_count||lastTick<planned.finish_tick-2||Math.abs(frames/clip.fps-expectedSeconds)>Math.max(.15,2/clip.fps))fail('native_frame_coverage_mismatch');
  return {status:'passed',kind:'native_engine_frames',frame_count:frames,first_tick:clip.first_frame_tick,last_tick:lastTick};
}

async function readNativeArtifact(store,owner,job,artifact){
  const result=new Uint8Array(artifact.bytes);let offset=0;
  for(let index=0;index<artifact.part_count;index++){
    const part=await store.getPart(partKey(owner,job.job_id,artifact.artifact_id,index)),expected=Math.min(artifact.part_bytes,artifact.bytes-index*artifact.part_bytes);
    if(!part||part.bytes.byteLength!==expected||part.metadata.job_id!==job.job_id||part.metadata.artifact_id!==artifact.artifact_id||await hash(part.bytes)!==part.metadata.sha256)fail('native_artifact_incomplete',409);
    result.set(part.bytes,offset);offset+=part.bytes.byteLength;
  }
  if(await hash(result)!==artifact.sha256)fail('native_artifact_digest_mismatch');return result;
}

async function readVerifiedNativeClip({owner,store,match,clip,analysis,source,tickrate}){
  const base={clip_id:clip.burst_id,round_number:clip.round_number,start_tick:clip.start_tick,finish_tick:clip.finish_tick,evidence_ref:clip.evidence_id??`match:${match.match_id}:r${clip.round_number}:aim:${clip.burst_id}`};
  try{
    const key=await fingerprint(clip),cached=await store.getJSON(analysisClipKey(owner,source,analysis,key))??await store.getJSON(clipKey(owner,source,key));
    if(!cached)return {item:{...base,state:'not_rendered'}};
    if(cached.analysis_sha256!=null&&cached.analysis_sha256!==analysis)fail('native_analysis_mismatch');
    if(cached.match_id!==match.match_id||cached.source_sha256!==source||cached.burst_id!==clip.burst_id||cached.state!=='rendered'||!UUID.test(cached.job_id??'')||!ARTIFACT.test(cached.clip_id??''))fail('native_capture_identity_mismatch');
    const job=await store.getJSON(jobKey(owner,cached.job_id));
    if(!job||job.version!==NATIVE_VERSION||job.owner!==owner||job.job_id!==cached.job_id||job.match_id!==match.match_id||job.plan?.version!==NATIVE_VERSION||job.plan?.kind!=='cs2_engine_capture_plan'||job.plan?.owner_steamid!==owner||job.plan?.source_sha256!==source||job.plan?.tickrate!==tickrate||job.plan?.fps!==120||!Array.isArray(job.plan?.clips)||job.plan.clips.length<1||job.plan.clips.length>MAX_CLIPS)fail('native_capture_identity_mismatch');
    if(job.analysis_sha256!==analysis)fail('native_analysis_mismatch');
    const planned=job.plan.clips.find(value=>value.clip_id===cached.clip_id&&value.burst_id===clip.burst_id);
    if(!planned||planned.start_tick!==clip.start_tick||planned.finish_tick!==clip.finish_tick)fail('native_capture_fingerprint_mismatch');
    const done=await store.getJSON(completeKey(owner,job.job_id));
    if(!done||done.state!=='rendered'||done.job_id!==job.job_id||done.match_id!==match.match_id||done.source_sha256!==source||done.analysis_sha256!==analysis||!Array.isArray(done.clips))fail('native_capture_not_complete');
    const receipt=checkedReceipt(await store.getJSON(manifestKey(owner,job.job_id)),job),recorded=receipt.clips.find(value=>value.clip_id===planned.clip_id),completed=done.clips.find(value=>value.clip_id===planned.clip_id&&value.burst_id===clip.burst_id);
    if(done.clips.length!==receipt.clips.length||!recorded||!completed||completed.state!=='rendered'||completed.job_id!==job.job_id||JSON.stringify(done.engine)!==JSON.stringify(receipt.engine)||JSON.stringify(cached.artifacts)!==JSON.stringify(recorded.artifacts)||JSON.stringify(completed.artifacts)!==JSON.stringify(recorded.artifacts))fail('native_capture_manifest_mismatch');
    const alignment={start_tick:recorded.first_frame_tick,requested_start_tick:recorded.start_tick,finish_tick:recorded.finish_tick,tickrate,fps:recorded.fps,video_start_seconds:0};
    if(JSON.stringify(cached.alignment)!==JSON.stringify(alignment)||JSON.stringify(completed.alignment)!==JSON.stringify(alignment)||completed.validation?.status!=='passed'||completed.validation.kind!=='native_engine_frames'||completed.validation.frame_count!==recorded.frame_count||completed.validation.first_tick!==recorded.first_frame_tick||!Number.isFinite(completed.validation.last_tick)||completed.validation.last_tick<clip.finish_tick-2||completed.validation.last_tick>clip.finish_tick)fail('native_capture_validation_mismatch');
    const validation={status:'passed',kind:'native_engine_frames',frame_count:recorded.frame_count,first_tick:recorded.first_frame_tick,last_tick:completed.validation.last_tick};
    const item={...base,state:'rendered',fps:recorded.fps,width:recorded.width,height:recorded.height,frame_count:recorded.frame_count,first_frame_tick:recorded.first_frame_tick,first_frame_time:recorded.first_frame_time,source_sha256:source,analysis_sha256:analysis,rendered_at:typeof done.rendered_at==='string'&&Number.isFinite(Date.parse(done.rendered_at))?done.rendered_at:null,engine:{renderer:receipt.engine.renderer,capture_adapter:receipt.engine.capture_adapter,game_build:receipt.engine.game_build,hlae_version:receipt.engine.hlae_version},validation};
    return {item,job,recorded,completed};
  }catch(error){return {item:{...base,state:'unavailable',reason:error instanceof NativeError?error.code:'native_capture_unavailable'}};}

}

/** Read current-owner completed capture metadata and observed frame evidence.
 * Enumerates only current analysis windows; never lists storage or reads video. */
export function createNativeQueryReader({owner,store:fixedStore,bucket}={}){
  const store=fixedStore??(bucket?createR2NativeStore(bucket):null);
  const pagination=(input,total,returned)=>({offset:input.offset,limit:input.limit,returned,total,next_offset:input.offset+returned<total?input.offset+returned:null});
  const empty=(input,state,reason,clip)=>({state,...(reason?{reason}:{}),...(clip?{clip}:{}),items:[],pagination:pagination(input,0,0)});
  return async function loadNativeCapture(match,raw){
    const input={...raw,offset:raw?.offset??0,limit:raw?.limit??25};
    if(!['native_captures','native_frames'].includes(input.resource)||!ID.test(input.match_id??'')||match?.match_id!==input.match_id||!integer(input.offset,0,1000000)||!integer(input.limit,1,100)||input.clip_id!=null&&(!BURST.test(input.clip_id)||input.clip_id==='__proto__'||input.clip_id==='constructor'||input.clip_id==='prototype')||input.resource==='native_frames'&&!input.clip_id)fail('invalid_native_query',400);
    if(input.player_id!=null&&!/^\d{17}$/.test(input.player_id))fail('invalid_native_query',400);
    if(input.round_number!=null&&!integer(input.round_number,1,100)||['tick_from','tick_to'].some(key=>input[key]!=null&&!integer(input[key],0,Number.MAX_SAFE_INTEGER)))fail('invalid_native_query',400);
    const candidates=windows(match).filter(clip=>(input.round_number==null||clip.round_number===input.round_number)&&(!input.clip_id||clip.burst_id===input.clip_id));
    if(input.clip_id&&!candidates.length)fail('native_clip_not_found',404);
    const source=match.provenance?.source_sha256??match.provenance?.sha256,tickrate=match.provenance?.tickrate;
    if(!/^\d{17}$/.test(owner??'')||!SHA.test(source??'')||!Number.isFinite(tickrate)||tickrate<16||tickrate>256)return empty(input,'unavailable','native_source_identity_unavailable');
    if(!store)return empty(input,'unavailable','native_storage_unavailable');
    let analysis;try{analysis=await nativeAnalysisDigest(match);}catch{return empty(input,'unavailable','native_analysis_unavailable');}
    const evidenceRef=clip=>clip.evidence_id??`match:${match.match_id}:r${clip.round_number}:aim:${clip.burst_id}`;
    const readClip=clip=>readVerifiedNativeClip({owner,store,match,clip,analysis,source,tickrate});
    if(input.resource==='native_captures'){
      const selected=candidates.slice(input.offset,input.offset+input.limit),items=[];
      for(const clip of selected)items.push((await readClip(clip)).item);
      return {state:'available',items,pagination:pagination(input,candidates.length,items.length)};
    }
    const clip=candidates[0],start=input.tick_from??clip.start_tick,end=input.tick_to??clip.finish_tick;
    if(end<start||end-start>tickrate*30)fail('native_frame_window_exceeds_30_seconds',400);
    const loaded=await readClip(clip);
    if(!loaded.recorded)return empty(input,loaded.item.state,loaded.item.reason,loaded.item);
    try{
      const artifact=loaded.recorded.artifacts.find(value=>value.kind==='evidence'),bytes=await readNativeArtifact(store,owner,loaded.job,artifact);
      validateNativeEvidence(bytes,loaded.job,loaded.recorded);
      const frames=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='frame'&&row.clip_id===loaded.recorded.clip_id);
      for(const row of frames){const identified=new Set();for(const value of row.players){const id=String(value?.steamid);if((id!=='0'&&!/^\d{17}$/.test(id))||!vector(value.origin)||!Number.isFinite(value.health)||value.health<0||value.health>100||id!=='0'&&identified.has(id))fail('invalid_native_frame_players');if(id!=='0')identified.add(id);}}
      const rows=frames.filter(row=>row.tick>=start&&row.tick<=end);
      const items=rows.slice(input.offset,input.offset+input.limit).map(row=>({clip_id:clip.burst_id,round_number:clip.round_number,frame:row.frame,tick:row.tick,time:row.time,time_basis:row.time_basis==='record_elapsed_seconds'?'record_elapsed_seconds':'unspecified',...(Number.isFinite(row.render_time)?{render_time:row.render_time}:{}),...(Number.isFinite(row.demo_time)?{demo_time:row.demo_time}:{}),...(Number.isFinite(row.frame_step)?{frame_step:row.frame_step}:{}),camera:{position:[...row.camera.position],angles:[...row.camera.angles],fov:row.camera.fov},viewport:[...row.viewport],players:row.players.filter(value=>String(value.steamid)!=='0'&&(input.player_id==null||String(value.steamid)===input.player_id)).map(value=>({steamid:String(value.steamid),origin:[...value.origin],health:value.health})),unidentified_entity_count:row.players.filter(value=>String(value.steamid)==='0').length,evidence_ref:evidenceRef(clip)}));
      return {state:'available',clip:loaded.item,window:{tick_from:start,tick_to:end},items,pagination:pagination(input,rows.length,items.length)};
    }catch(error){return empty(input,'unavailable',error instanceof NativeError?error.code:'native_evidence_unavailable',loaded.item);}
  };
}

export function createNativeJobHandler({loadSnapshot,loadMatch,getSource=createNativeSourceReader(),store:fixedStore,requireIdentity=false,now=()=>Date.now(),randomTicket=nonce}={}){
  const stores=new WeakMap();
  return async function nativeJobs(request,env={}){
    try{
      const url=new URL(request.url),origin=request.headers.get('origin');
      if(origin&&origin!==url.origin||request.headers.get('sec-fetch-site')==='cross-site')fail('origin_rejected',403);
      if(requireIdentity&&!request.headers.get('oai-authenticated-user-id'))fail('sign_in_required',401);
      if(!['GET','HEAD','POST','PUT'].includes(request.method))return json({error:'method_not_allowed'},405,{allow:'GET, HEAD, POST, PUT'});
      if(['POST','PUT'].includes(request.method)&&origin!==url.origin)fail('origin_rejected',403);
      const snapshot=await loadSnapshot(env),owner=snapshot?.profile?.steamid64;
      if(!/^\d{17}$/.test(owner??''))fail('native_snapshot_unavailable',503);
      let store=fixedStore;if(!store&&env.BUCKET){if(!stores.has(env.BUCKET))stores.set(env.BUCKET,createR2NativeStore(env.BUCKET));store=stores.get(env.BUCKET);}if(!store)fail('native_storage_unavailable',503);
      const readJob=async id=>{if(!UUID.test(id??''))fail('invalid_native_job_id',400);const job=await store.getJSON(jobKey(owner,id));if(!job||job.owner!==owner)fail('native_job_not_found',404);return job;};
      const authorize=(job,ticket)=>{if(now()>job.expires_ms)fail('native_job_expired',410);if(!SHA.test(ticket??'')||ticket!==job.ticket)fail('invalid_native_ticket',403);};
      if(request.method==='POST'){
        if(url.search)fail('invalid_native_request',400);const input=await readJSON(request);
        if(input?.action==='create'){
          if(!safeKeys(input,['action','request_id','match_id','burst_ids'])||!UUID.test(input.request_id??'')||!ID.test(input.match_id??'')||!Array.isArray(input.burst_ids))fail('invalid_native_request',400);
          const existing=await store.getJSON(jobKey(owner,input.request_id));
          if(existing){if(existing.match_id!==input.match_id||JSON.stringify([...input.burst_ids].sort())!==JSON.stringify(existing.plan.clips.map(c=>c.burst_id).sort()))fail('native_request_conflict',409);authorize(existing,existing.ticket);return json({...publicJob(existing),ticket:existing.ticket},200);}
          const summary=snapshot.matches.find(match=>match.match_id===input.match_id);if(!summary)fail('native_match_not_found',404);
          const match=loadMatch?await loadMatch(summary,env):summary,plan=createNativePlan(match,owner,input.burst_ids);
          const source_revision=snapshot.delivery?.source_revision??snapshot._cs2_storage?.source_revision??null;
          if(source_revision!=null&&!REV.test(source_revision))fail('invalid_native_source_revision',503);
          const analysis_sha256=await nativeAnalysisDigest(match,summary);
          let demo=await getSource(match,{...env,NATIVE_OWNER_STEAM_ID:owner});
          if(!demo)demo={status:'source_unavailable',sha256:plan.source_sha256,bytes:match.provenance?.source_bytes??match.provenance?.bytes??null,compression:'none'};
          else if(demo.sha256!==plan.source_sha256||demo.status!=='available'||nativeDemoURL(demo.url)!==demo.url)fail('native_demo_source_mismatch',409);
          const job={version:NATIVE_VERSION,owner,job_id:input.request_id,match_id:input.match_id,source_revision,analysis_sha256,created_ms:now(),expires_ms:now()+NATIVE_JOB_TTL_MS,ticket:randomTicket(),plan,demo};
          if(!SHA.test(job.ticket))fail('native_ticket_generation_failed',503);
          if(!await store.claimJSON(jobKey(owner,job.job_id),job))fail('native_request_conflict',409);
          return json({...publicJob(job),ticket:job.ticket},201);
        }
        if(!['prepare','complete'].includes(input?.action)||!safeKeys(input,input.action==='prepare'?['action','job_id','ticket','receipt']:['action','job_id','ticket']))fail('invalid_native_request',400);
        const job=await readJob(input.job_id);authorize(job,input.ticket);
        if(input.action==='prepare'){
          const receipt=checkedReceipt(input.receipt,job),previous=await store.getJSON(manifestKey(owner,job.job_id));
          if(previous&&JSON.stringify(previous)!==JSON.stringify(receipt))fail('native_manifest_conflict',409);
          if(!previous&&!await store.claimJSON(manifestKey(owner,job.job_id),receipt))fail('native_manifest_conflict',409);
          return json({job_id:job.job_id,state:'uploading',artifacts:receipt.clips.flatMap(clip=>clip.artifacts.map(a=>({artifact_id:a.artifact_id,part_count:a.part_count,part_bytes:a.part_bytes})))},202);
        }
        const done=await store.getJSON(completeKey(owner,job.job_id));if(done)return json(done);
        const receipt=await store.getJSON(manifestKey(owner,job.job_id));if(!receipt)fail('native_manifest_required',409);checkedReceipt(receipt,job);
        const clips=[];
        for(const clip of receipt.clips){let validation;
          for(const artifact of clip.artifacts){const bytes=await readNativeArtifact(store,owner,job,artifact);if(artifact.kind==='evidence')validation=validateNativeEvidence(bytes,job,clip);else validateNativeMP4(bytes,clip,artifact);}
          if(!validation)fail('native_required_artifact_missing');
          clips.push({burst_id:clip.burst_id,state:'rendered',job_id:job.job_id,clip_id:clip.clip_id,artifacts:clip.artifacts,alignment:{start_tick:clip.first_frame_tick,requested_start_tick:clip.start_tick,finish_tick:clip.finish_tick,tickrate:job.plan.tickrate,fps:clip.fps,video_start_seconds:0},validation});
        }
        const result={job_id:job.job_id,match_id:job.match_id,state:'rendered',rendered_at:new Date(now()).toISOString(),source_sha256:job.plan.source_sha256,analysis_sha256:job.analysis_sha256,engine:receipt.engine,clips};
        await store.claimJSON(completeKey(owner,job.job_id),result);
        for(const clip of clips){const planned=job.plan.clips.find(c=>c.clip_id===clip.clip_id),key=await fingerprint(planned),cached={...clip,match_id:job.match_id,source_sha256:job.plan.source_sha256,analysis_sha256:job.analysis_sha256};await store.claimJSON(analysisClipKey(owner,job.plan.source_sha256,job.analysis_sha256,key),cached);await store.claimJSON(clipKey(owner,job.plan.source_sha256,key),cached);}
        return json(result,201);
      }
      if(request.method==='PUT'){
        if([...url.searchParams.keys()].some(key=>!['job_id','artifact_id','part_index'].includes(key))||['job_id','artifact_id','part_index'].some(key=>url.searchParams.getAll(key).length!==1))fail('invalid_native_part_request',400);
        const job=await readJob(url.searchParams.get('job_id'));authorize(job,request.headers.get('x-native-ticket'));
        if(request.headers.get('content-type')!=='application/octet-stream')fail('native_binary_required',415);
        const id=url.searchParams.get('artifact_id'),index=Number(url.searchParams.get('part_index'));
        if(!ARTIFACT.test(id??'')||!/^\d{1,5}$/.test(url.searchParams.get('part_index')??''))fail('invalid_native_part_request',400);
        const receipt=await store.getJSON(manifestKey(owner,job.job_id)),artifact=receipt?.clips.flatMap(clip=>clip.artifacts).find(a=>a.artifact_id===id);
        if(!artifact||!integer(index,0,artifact.part_count-1))fail('native_part_not_declared',409);
        const expected=Math.min(artifact.part_bytes,artifact.bytes-index*artifact.part_bytes),sha=request.headers.get('x-content-sha256');
        if(!SHA.test(sha??''))fail('native_part_digest_required',400);
        const body=await boundedBody(request,expected);if(body.byteLength!==expected||await hash(body)!==sha)fail('native_part_digest_mismatch');
        const key=partKey(owner,job.job_id,id,index),metadata={job_id:job.job_id,artifact_id:id,sha256:sha};
        const existing=await store.headPart(key);if(existing&&(existing.bytes!==expected||existing.metadata.sha256!==sha))fail('native_part_conflict',409);
        if(!existing&&!await store.claimPart(key,body,metadata)){const current=await store.headPart(key);if(!current||current.bytes!==expected||current.metadata.sha256!==sha)fail('native_part_conflict',409);}
        return json({job_id:job.job_id,artifact_id:id,part_index:index,status:existing?'unchanged':'uploaded'});
      }
      if(url.searchParams.has('match_id')){
        if([...url.searchParams.keys()].some(key=>!['match_id','burst_id'].includes(key))||url.searchParams.getAll('match_id').length!==1)fail('invalid_native_request',400);
        const id=url.searchParams.get('match_id');if(!ID.test(id??''))fail('invalid_native_request',400);
        const summary=snapshot.matches.find(match=>match.match_id===id);if(!summary)fail('native_match_not_found',404);
        const requested=url.searchParams.getAll('burst_id');if(requested.length>MAX_CLIPS||requested.some(id=>!BURST.test(id)))fail('invalid_native_clip_selection',400);
        const match=loadMatch?await loadMatch(summary,env):summary;
        const candidates=windows(match).filter(clip=>!requested.length||requested.includes(clip.burst_id)).slice(0,MAX_CLIPS),source=match.provenance?.source_sha256??match.provenance?.sha256,tickrate=match.provenance?.tickrate,analysis=await nativeAnalysisDigest(match,summary);
        const clips=await Promise.all(candidates.map(async clip=>{
          if(!SHA.test(source??'')||!Number.isFinite(tickrate)||tickrate<16||tickrate>256)return {burst_id:clip.burst_id,state:'unavailable',reason:'native_source_identity_unavailable'};
          const checked=await readVerifiedNativeClip({owner,store,match,clip,analysis,source,tickrate});
          return checked.recorded?{...checked.completed,match_id:id,source_sha256:source,analysis_sha256:analysis}: {burst_id:clip.burst_id,state:checked.item.state,...(checked.item.reason?{reason:checked.item.reason}:{})};
        }));
        return json({status:'ok',match_id:id,analysis_sha256:analysis,clips,max_batch_clips:MAX_CLIPS});
      }
      if([...url.searchParams.keys()].some(key=>!['job_id','artifact_id'].includes(key))||url.searchParams.getAll('job_id').length!==1||url.searchParams.getAll('artifact_id').length>1)fail('invalid_native_request',400);
      const job=await readJob(url.searchParams.get('job_id')),done=await store.getJSON(completeKey(owner,job.job_id)),id=url.searchParams.get('artifact_id');
      if(!id)return json(done??publicJob(job,now()>job.expires_ms?'expired':await store.getJSON(manifestKey(owner,job.job_id))?'uploading':'awaiting_local_render'));
      if(!ARTIFACT.test(id)||!done)fail('native_media_not_ready',409);
      const artifact=done.clips.flatMap(clip=>clip.artifacts).find(a=>a.artifact_id===id);if(!artifact)fail('native_artifact_not_found',404);
      let start=0,end=artifact.bytes-1,status=200;const range=request.headers.get('range');
      if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)fail('invalid_native_media_range',416);start=Number(match[1]);end=match[2]?Number(match[2]):end;if(!integer(start,0,artifact.bytes-1)||!integer(end,start,artifact.bytes-1))return json({error:'invalid_native_media_range'},416,{'content-range':`bytes */${artifact.bytes}`});status=206;}
      const mediaHeaders={...headers,'content-type':artifact.content_type,'content-length':String(end-start+1),'accept-ranges':'bytes','content-disposition':'inline',...(status===206?{'content-range':`bytes ${start}-${end}/${artifact.bytes}`}:{})};
      if(request.method==='HEAD')return new Response(null,{status,headers:mediaHeaders});
      let index=Math.floor(start/artifact.part_bytes);const last=Math.floor(end/artifact.part_bytes);
      const stream=new ReadableStream({async pull(controller){try{if(index>last){controller.close();return;}const part=await store.getPart(partKey(owner,job.job_id,id,index));if(!part||await hash(part.bytes)!==part.metadata.sha256)throw Error('native_media_unavailable');const offset=index*artifact.part_bytes;controller.enqueue(part.bytes.subarray(Math.max(0,start-offset),Math.min(part.bytes.byteLength,end-offset+1)));index++;}catch{controller.error(new Error('native_media_unavailable'));}}});
      return new Response(stream,{status,headers:mediaHeaders});
    }catch(error){const safe=error instanceof NativeError?error:new NativeError('native_service_unavailable',503);return json({error:safe.code,state:'error'},safe.status);}
  };
}
