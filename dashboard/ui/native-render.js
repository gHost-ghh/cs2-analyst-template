const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
export const NATIVE_LIMITS=Object.freeze({clips:16,seconds:180,part_bytes:512*1024,artifact_bytes:24*1024*1024,connect_ms:180000,bridge_origin:'http://127.0.0.1:43187',channel:'cs2-native-local-v1'});
const statusLabels={unrendered:'尚未渲染',queued:'等待本机连接',downloading:'下载 Demo',rendering:'本机渲染中',encoding:'视频处理中',uploading:'上传中',validating:'校验中',ready:'原生回放',failed:'渲染未完成',cancelled:'已取消',expired:'连接已过期'};
export function nativeClipKey(clip){return JSON.stringify([clip.match_id,clip.round_number,clip.burst_id,clip.source_sha256??null,clip.detail_revision??null,clip.start_tick??null,clip.finish_tick??null,clip.tickrate??null]);}
export function nativeArtifactMatches(value,clip){
 const alignment=value?.alignment;
 return Boolean(value?.state==='rendered'&&value.validation?.status==='passed'&&value.validation?.kind==='native_engine_frames'&&value.match_id===clip.match_id&&value.burst_id===clip.burst_id&&/^[a-f0-9]{64}$/.test(clip.source_sha256??'')&&value.source_sha256===clip.source_sha256&&alignment&&alignment.requested_start_tick===clip.start_tick&&alignment.finish_tick===clip.finish_tick&&alignment.tickrate===clip.tickrate&&numeric(alignment.start_tick)&&alignment.start_tick>=clip.start_tick&&alignment.start_tick<=clip.start_tick+2&&alignment.start_tick<alignment.finish_tick&&value.validation.first_tick===alignment.start_tick);
}
export function nativePlanMatches(response,clips){
 const plan=response?.plan,first=clips[0];
 if(!first||plan?.match_id!==first.match_id||plan.source_sha256!==first.source_sha256||plan.tickrate!==first.tickrate||!Array.isArray(plan.clips)||plan.clips.length!==clips.length)return false;
 if(/^[a-f0-9]{64}$/.test(first.detail_revision??'')&&response.analysis_sha256!==first.detail_revision)return false;
 return clips.every(clip=>{const planned=plan.clips.find(row=>row.burst_id===clip.burst_id);return planned&&planned.start_tick===clip.start_tick&&planned.finish_tick===clip.finish_tick&&clip.source_sha256===plan.source_sha256&&clip.tickrate===plan.tickrate;});
}
export function clipDuration(clip){const rate=clip.tickrate||64,start=clip.start_tick??clip.points?.[0]?.tick,end=clip.finish_tick??clip.points?.at(-1)?.tick;return numeric(start)&&numeric(end)&&numeric(rate)&&rate>0&&end>start?(end-start)/rate:null;}
export function nativeBatchRows(rows,selected){
 const seen=new Set();return rows.filter(row=>row.match_id===selected.match_id&&!row.legacy&&row.burst_id&&Number.isInteger(row.round_number)&&clipDuration(row)>0&&clipDuration(row)<=20).filter(row=>{const key=nativeClipKey(row);if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>(a.start_tick??0)-(b.start_tick??0));
}
export function selectNativeBatch(rows,keys){let seconds=0;const selected=[];for(const row of rows){if(!keys.has(nativeClipKey(row)))continue;const duration=clipDuration(row);if(!duration||selected.length>=NATIVE_LIMITS.clips||seconds+duration>NATIVE_LIMITS.seconds)throw Error('每批最多 16 个片段、180 秒');selected.push(row);seconds+=duration;}if(!selected.length)throw Error('请至少选择一个片段');return {clips:selected,seconds};}
export function nativeLaunchUrl(origin,nonce){const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||!['https://your-site.example','https://your-site.example'].includes(origin)||!/^[a-f0-9]{64}$/.test(nonce))throw Error('本机连接参数无效');return `cs2lab://render?origin=${encodeURIComponent(origin)}&nonce=${nonce}`;}
export function nativeConnectPage(popup,origin,nonce){
 const launch=nativeLaunchUrl(origin,nonce),doc=popup.document;
 const element=(tag,text)=>{const node=doc.createElement(tag);if(text)node.textContent=text;return node;};
 doc.title='连接 CS2 本机助手';doc.documentElement.lang='zh-CN';
 const viewport=element('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';
 const stylesheet=element('link');stylesheet.rel='stylesheet';stylesheet.href=`${origin}/assets/native-render.css`;doc.head.append(viewport,stylesheet);
 const main=element('main'),heading=element('h1','连接本机助手'),intro=element('p','请在 3 分钟内完成以下两步，并保持比赛页面与本窗口开启。'),steps=element('ol');
 const launchStep=element('li'),launchLink=element('a','打开本机助手');launchLink.href=launch;launchLink.target='_self';
 launchStep.append(launchLink,element('p','在浏览器或系统提示中允许打开 CS2 Demo Lab。助手窗口显示“已启动”后，再进行第 2 步。'));
 const connectStep=element('li'),connectLink=element('a','助手已打开，连接上传');connectLink.href=`${NATIVE_LIMITS.bridge_origin}/bridge#${nonce}`;connectLink.target='_self';
 connectStep.append(connectLink,element('p','连接后将按所选片段开始渲染和上传。如果显示无法连接，请关闭本窗口，回到比赛页面重新发起渲染。'));
 steps.append(launchStep,connectStep);
 const help=element('p','没有出现应用打开提示？请先安装本机助手，然后重新发起渲染。'),state=element('p','等待你打开并连接本机助手');state.setAttribute('role','status');
 main.append(heading,intro,steps,help,state);doc.body.className='native-connect-page';doc.body.replaceChildren(main);
 return message=>{state.textContent=message;for(const link of [launchLink,connectLink]){link.removeAttribute('href');link.setAttribute('aria-disabled','true');}};
}
export function validBridgeMessage(event,popup,nonce){const value=event?.data;return event?.source===popup&&event?.origin===NATIVE_LIMITS.bridge_origin&&value&&typeof value==='object'&&value.channel===NATIVE_LIMITS.channel&&value.nonce===nonce&&['ready','status','prepared','artifact-part','complete','error'].includes(value.type);}
export function nativeMediaUrl(value,base=globalThis.location?.origin){if(typeof value!=='string'||!value.startsWith('/api/native-jobs?'))return null;try{const url=new URL(value,base);return url.origin===base&&!url.username&&!url.password?url.pathname+url.search:null;}catch{return null;}}
export function nativeTickAtTime(time,alignment){if(!numeric(time)||time<0||!alignment||!numeric(alignment.start_tick)||!numeric(alignment.tickrate)||alignment.tickrate<=0)return null;const offset=numeric(alignment.video_start_seconds)?alignment.video_start_seconds:0;return alignment.start_tick+Math.max(0,time-offset)*alignment.tickrate;}
export function nativeTimeAtTick(tick,alignment){if(!numeric(tick)||!alignment||!numeric(alignment.start_tick)||!numeric(alignment.tickrate)||alignment.tickrate<=0)return null;return Math.max(0,(tick-alignment.start_tick)/alignment.tickrate+(alignment.video_start_seconds||0));}
export function nativePlaceholderHtml(status='unrendered',detail=''){
 const label=statusLabels[status]||'尚未渲染',busy=['queued','downloading','rendering','encoding','uploading','validating'].includes(status);
 return `<div class="native-placeholder" data-native-state="${esc(status)}"><div class="native-placeholder-mark" aria-hidden="true">${busy?'<span class="spinner"></span>':'<span>▷</span>'}</div><strong>${esc(label)}</strong><p>${esc(detail||(status==='unrendered'?'在这台电脑上生成真实游戏画面':'渲染和上传完成后可在这里播放'))}</p><span class="native-machine-label">WINDOWS 11 · RTX 5070 Ti LAPTOP</span></div>`;
}
export const NATIVE_EVIDENCE_LIMITS=Object.freeze({bytes:4*1024*1024,frames:5000,players:64,line_bytes:32*1024});
const evidenceFail=code=>{throw Error(code);};
const evidenceUtf8=new TextEncoder();
const evidenceVector=value=>Array.isArray(value)&&value.length===3&&value.every(item=>numeric(item)&&Math.abs(item)<=1e7);
function evidenceManifest(value,clip){
 if(!nativeArtifactMatches(value,clip)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.job_id??'')||!/^\d{3}$/.test(value.clip_id??''))evidenceFail('native_evidence_unverified');
 const artifacts=value.artifacts?.filter(row=>row.kind==='evidence'),artifact=artifacts?.[0],count=value.validation.frame_count,fps=value.alignment.fps;
 if(artifacts?.length!==1||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(artifact?.artifact_id??'')||artifact.content_type!=='application/x-ndjson'||!Number.isInteger(artifact.bytes)||artifact.bytes<1||artifact.bytes>NATIVE_EVIDENCE_LIMITS.bytes||!/^[a-f0-9]{64}$/.test(artifact.sha256??'')||!Number.isInteger(count)||count<1||count>NATIVE_EVIDENCE_LIMITS.frames||!numeric(fps)||fps<=0||fps>240||!numeric(value.validation.last_tick)||!numeric(value.alignment.video_start_seconds??0)||(value.alignment.video_start_seconds??0)<0)evidenceFail('native_evidence_unverified');
 return artifact;
}
export async function parseNativeEvidence(bytes,value,clip){
 const artifact=evidenceManifest(value,clip);
 if(!(bytes instanceof Uint8Array)||bytes.byteLength!==artifact.bytes)evidenceFail('native_evidence_size_mismatch');
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(item=>item.toString(16).padStart(2,'0')).join('');
 if(digest!==artifact.sha256)evidenceFail('native_evidence_hash_mismatch');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{evidenceFail('native_evidence_invalid');}
 const lines=text.split(/\r?\n/).filter(line=>line.trim());
 if(lines.length>value.validation.frame_count+3)evidenceFail('native_evidence_invalid');
 let start=null,end=null,complete=null;const frames=[],bounds={minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity};
 for(const line of lines){
  if(evidenceUtf8.encode(line).byteLength>NATIVE_EVIDENCE_LIMITS.line_bytes)evidenceFail('native_evidence_invalid');
  let row;try{row=JSON.parse(line);}catch{evidenceFail('native_evidence_invalid');}
  if(!row||typeof row!=='object'||Array.isArray(row)||row.job_id!=null&&row.job_id!==value.job_id)evidenceFail('native_evidence_identity_mismatch');
  if(row.type==='complete'){
   if(!end||complete||row.reason!=='complete'||row.source_sha256!==value.source_sha256||row.match_id!==value.match_id)evidenceFail('native_evidence_identity_mismatch');complete=row;continue;
  }
  if(complete||row.clip_id!==value.clip_id)evidenceFail('native_evidence_identity_mismatch');
  if(row.type==='clip_start'){
   if(start||frames.length||row.source_sha256!==value.source_sha256||row.camera_mode!=='verified_native_spectator'||!/^\d{17}$/.test(row.owner_steamid??'')||row.tick!==value.alignment.start_tick||!numeric(row.time))evidenceFail('native_evidence_identity_mismatch');start=row;continue;
  }
  if(row.type==='clip_end'){
   if(!start||end||row.frames!==frames.length||row.camera_rejected!==false||!numeric(row.tick)||row.tick<=clip.finish_tick||row.tick>clip.finish_tick+4)evidenceFail('native_evidence_frame_mismatch');end=row;continue;
  }
  if(row.type!=='frame'||!start||end||row.frame!==frames.length||!numeric(row.tick)||row.tick<clip.start_tick||row.tick>clip.finish_tick||!numeric(row.time)||frames.length&&row.time<=frames.at(-1).time||frames.length&&row.tick<frames.at(-1).tick||!evidenceVector(row.camera?.position)||!evidenceVector(row.camera?.angles)||!numeric(row.camera?.fov)||row.camera.fov<20||row.camera.fov>179||!Array.isArray(row.viewport)||row.viewport.length!==2||!row.viewport.every((item,index)=>Number.isInteger(item)&&item>0&&item<=(index?2160:3840))||!Array.isArray(row.players)||row.players.length>NATIVE_EVIDENCE_LIMITS.players)evidenceFail('native_evidence_frame_mismatch');
  const identities=new Set(),identifiedPlayers=[];let unidentifiedCount=0;
  for(const player of row.players){
   if(typeof player?.steamid!=='string'||player.steamid!=='0'&&!/^\d{17}$/.test(player.steamid)||!evidenceVector(player.origin)||!numeric(player.health)||player.health<0||player.health>1000)evidenceFail('native_evidence_frame_mismatch');
   // CS2 can expose an anonymous/proxy controller with the reserved SteamID 0.
   // Its record is validated above, but it is not an identified player.
   if(player.steamid==='0'){unidentifiedCount++;continue;}
   if(identities.has(player.steamid))evidenceFail('native_evidence_frame_mismatch');identities.add(player.steamid);identifiedPlayers.push(player);
   bounds.minX=Math.min(bounds.minX,player.origin[0]);bounds.maxX=Math.max(bounds.maxX,player.origin[0]);bounds.minY=Math.min(bounds.minY,player.origin[1]);bounds.maxY=Math.max(bounds.maxY,player.origin[1]);
  }
  if(!identities.has(start.owner_steamid))evidenceFail('native_evidence_owner_missing');
  const owner=row.players.find(player=>player.steamid===start.owner_steamid),position=row.camera.position;
  if(Math.hypot(position[0]-owner.origin[0],position[1]-owner.origin[1])>6||position[2]-owner.origin[2]<12||position[2]-owner.origin[2]>85)evidenceFail('native_evidence_camera_mismatch');
  if(frames.length&&(row.viewport[0]!==frames[0].viewport[0]||row.viewport[1]!==frames[0].viewport[1]))evidenceFail('native_evidence_frame_mismatch');
  if(['render_time','demo_time','frame_step'].some(field=>row[field]!=null&&!numeric(row[field]))||row.frame_step!=null&&row.frame_step<=0)evidenceFail('native_evidence_frame_mismatch');
  frames.push({frame:row.frame,tick:row.tick,time:row.time,render_time:row.render_time??null,demo_time:row.demo_time??null,frame_step:row.frame_step??null,camera:{position:[...row.camera.position],angles:[...row.camera.angles],fov:row.camera.fov},viewport:[...row.viewport],unidentified_count:unidentifiedCount,players:identifiedPlayers.map(player=>({steamid:player.steamid,origin:[...player.origin],health:player.health}))});
 }
 if(!start||!end||!complete||frames.length!==value.validation.frame_count||frames[0].tick!==value.validation.first_tick||frames[0].time!==start.time||frames.at(-1).tick!==value.validation.last_tick)evidenceFail('native_evidence_frame_mismatch');
 const identities=[...new Set(frames.flatMap(row=>row.players.map(player=>player.steamid)))].sort();
 if(identities.length>NATIVE_EVIDENCE_LIMITS.players)evidenceFail('native_evidence_frame_mismatch');
 return {job_id:value.job_id,clip_id:value.clip_id,source_sha256:value.source_sha256,owner_steamid:start.owner_steamid,fps:value.alignment.fps,video_start_seconds:value.alignment.video_start_seconds??0,frames,bounds,identities};
}
export async function fetchNativeEvidence(value,clip,{fetcher=(...args)=>fetch(...args),signal}={}){
 const artifact=evidenceManifest(value,clip),url=`/api/native-jobs?job_id=${encodeURIComponent(value.job_id)}&artifact_id=${encodeURIComponent(artifact.artifact_id)}`;
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 const response=await fetcher(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 if(!response.ok||!/^application\/x-ndjson(?:;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();evidenceFail('native_evidence_unavailable');}
 const length=response.headers.get('content-length');
 if(length!=null&&(!/^\d+$/.test(length)||Number(length)!==artifact.bytes)){await response.body?.cancel();evidenceFail('native_evidence_size_mismatch');}
 const reader=response.body?.getReader();if(!reader)evidenceFail('native_evidence_unavailable');
 const abort=()=>{reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 let total=0;const chunks=[];
 try{while(true){if(signal?.aborted)throw new DOMException('Aborted','AbortError');const {done,value:chunk}=await reader.read();if(done)break;total+=chunk.byteLength;if(total>artifact.bytes){await reader.cancel();evidenceFail('native_evidence_size_mismatch');}chunks.push(chunk);}}
 finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const parsed=await parseNativeEvidence(bytes,value,clip);if(signal?.aborted)throw new DOMException('Aborted','AbortError');return parsed;
}
export function nativeEvidenceFrameIndex(evidence,time){
 if(!evidence?.frames?.length||!numeric(time)||time<0||!numeric(evidence.fps)||evidence.fps<=0)return null;
 return Math.max(0,Math.min(evidence.frames.length-1,Math.floor(Math.max(0,time-(evidence.video_start_seconds||0))*evidence.fps+1e-6)));
}
export function nativeFrameMeasures(evidence,index){
 const current=evidence?.frames?.[index],previous=evidence?.frames?.[index-1];if(!current)return null;
 const duration=previous?current.time-previous.time:null,valid=numeric(duration)&&duration>0;
 const direction=angles=>{const pitch=angles[0]*Math.PI/180,yaw=angles[1]*Math.PI/180;return [Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),-Math.sin(pitch)];};
 const from=previous?direction(previous.camera.angles):null,to=direction(current.camera.angles),angle=from?Math.acos(Math.max(-1,Math.min(1,from.reduce((sum,item,axis)=>sum+item*to[axis],0))))*180/Math.PI:null;
 const owner=current.players.find(player=>player.steamid===evidence.owner_steamid),priorOwner=previous?.players.find(player=>player.steamid===evidence.owner_steamid);
 return {yaw:current.camera.angles[1],pitch:current.camera.angles[0],fov:current.camera.fov,interval:valid?duration:null,angular_speed:valid?angle/duration:null,owner_distance:valid&&owner&&priorOwner?Math.hypot(...owner.origin.map((item,axis)=>item-priorOwner.origin[axis])):null};
}
export function nativeEvidenceFrameHtml(evidence,index){
 const frame=evidence?.frames?.[index],measures=nativeFrameMeasures(evidence,index);if(!frame||!measures)return '';
 const show=(value,digits=1)=>numeric(value)?value.toFixed(digits):'—',bounds=evidence.bounds,span=Math.max(64,bounds.maxX-bounds.minX,bounds.maxY-bounds.minY),scale=208/span,centerX=(bounds.minX+bounds.maxX)/2,centerY=(bounds.minY+bounds.maxY)/2;
 const x=value=>128+(value-centerX)*scale,y=value=>128-(value-centerY)*scale;
 const players=frame.players.map(player=>({...player,number:evidence.identities.indexOf(player.steamid)+1,owner:player.steamid===evidence.owner_steamid})).sort((a,b)=>Number(b.owner)-Number(a.owner)||a.number-b.number);
 const plot=`<svg viewBox="0 0 256 256" role="img" aria-label="当前引擎帧已识别玩家的平面坐标"><path d="M24 128H232M128 24V232" stroke="#2a4052" stroke-width="1"/><rect x="24" y="24" width="208" height="208" fill="none" stroke="#2a4052"/>${players.map(player=>`<g opacity="${player.health>0?1:.4}"><circle cx="${show(x(player.origin[0]),2)}" cy="${show(y(player.origin[1]),2)}" r="${player.owner?7:5}" fill="${player.owner?'#a4dfc6':'#8baecf'}"/><text x="${show(x(player.origin[0])+9,2)}" y="${show(y(player.origin[1])-8,2)}" fill="#c4d8e8" font-size="10">${player.owner?'本人':player.number}</text></g>`).join('')}<text x="232" y="249" fill="#809cb0" font-size="10" text-anchor="end">X → · Y ↑ · 跨度 ${show(span,0)} u</text></svg>`;
 const metric=(label,value,unit,title='')=>`<div${title?` title="${esc(title)}"`:''}><dt>${label}</dt><dd>${show(value)}<small>${unit}</small></dd></div>`;
 return `<div class="native-evidence-metrics"><dl>${metric('水平角',measures.yaw,'°')}${metric('俯仰角',measures.pitch,'°')}${metric('视场角',measures.fov,'°')}${metric('视线角速度',measures.angular_speed,'°/s','相邻实际渲染帧的视线方向夹角 / 观测帧间隔')}${metric('本人帧间位移',measures.owner_distance,'u','相邻实际渲染帧的位置距离')}${metric('观测帧间隔',numeric(measures.interval)?measures.interval*1000:null,'ms')}</dl><span>Tick ${show(frame.tick,2)} · 记录时间 ${show(frame.time,4)} s${numeric(frame.render_time)?` · 引擎时间 ${show(frame.render_time,4)} s`:''}</span></div><div class="native-evidence-grid"><figure>${plot}<figcaption>已识别玩家平面坐标 · 引擎帧 ${index+1}${frame.unidentified_count?` · 未识别实体 ${frame.unidentified_count}`:''}</figcaption></figure><div class="native-evidence-table"><table><thead><tr><th>已识别玩家</th><th>X / Y / Z · u</th><th>HP</th></tr></thead><tbody>${players.map(player=>`<tr${player.owner?' class="is-owner"':''}><th title="${esc(player.steamid)}">${player.owner?'本人':`玩家 ${player.number}`}</th><td>${player.origin.map(item=>show(item)).join(' / ')}</td><td>${show(player.health,0)}</td></tr>`).join('')}</tbody></table></div></div>`;
}
const activeSessions=new Set(),sessionSubscribers=new Set();
let creatingJob=false;
const artifactCache=new Map();
let warningInstalled=false;
const apiErrorLabels={not_configured:'本机渲染暂不可用',demo_source_unavailable:'这场比赛的 Demo 暂不可下载',demo_sha256_missing:'这场比赛缺少 Demo 校验信息',capture_clip_missing:'所选片段暂不可渲染',native_job_expired:'连接已过期，请重新发起',native_job_failed:'渲染未完成，请重试',invalid_alignment:'画面时间校验未通过',artifact_too_large:'视频超过上传大小限制'};
async function api(url,options={}){const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});let value;try{value=await response.json();}catch{throw Error('无法读取渲染服务响应');}if(!response.ok)throw Error(apiErrorLabels[value.error]||'渲染服务暂不可用');return value;}
function jsonPost(body){return {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};}
function nonce64(){const bytes=crypto.getRandomValues(new Uint8Array(32));return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');}
function caption(clip){return `R${clip.round_number} · ${clip.weapon||'射击片段'} · ${clip.shot_markers?.length||clip.shots||0} 发`;}
export function nativeBatchHtml(rows,selectedKeys){return `<form class="native-batch-form"><div class="native-batch-heading"><strong>批量渲染上传</strong><button class="icon-button" type="button" data-native-close aria-label="关闭批量选择">×</button></div><p>当前比赛 · 每批最多 16 个片段、180 秒</p><div class="native-batch-list">${rows.map(row=>`<label><input type="checkbox" name="clip" value="${esc(nativeClipKey(row))}" ${selectedKeys.has(nativeClipKey(row))?'checked':''}><span>${esc(caption(row))}</span><time>${clipDuration(row).toFixed(1)}s</time></label>`).join('')}</div><div class="native-batch-summary" aria-live="polite"></div><div class="native-batch-actions"><button type="button" class="button button-quiet" data-native-close>取消</button><button type="submit" class="button button-primary">开始本机渲染</button></div></form>`;}
function emitSession(session){for(const listener of sessionSubscribers)listener(session);}
function sessionStatus(session,status,detail=''){session.status=status;session.detail=detail;emitSession(session);}
function notifyBridge(session,type,body={}){if(session.popup&&!session.popup.closed)session.popup.postMessage({channel:NATIVE_LIMITS.channel,nonce:session.nonce,type,...body},NATIVE_LIMITS.bridge_origin);}
async function relaySession(session){
 // A popup relays only bounded job data and artifacts. Cloud credentials remain in this page.
 // External protocol permission is a human action. Never navigate over its prompt.
 const closeConnectPage=nativeConnectPage(session.popup,location.origin,session.nonce);
 const timeout=setTimeout(()=>{if(!session.sent){sessionStatus(session,'failed','本机助手未连接，请安装后按连接窗口的两步重试');session.cleanup();}},NATIVE_LIMITS.connect_ms);
 const deadline=setTimeout(()=>{sessionStatus(session,'failed','连接已结束，请重新发起渲染');notifyBridge(session,'cancel');session.cleanup();},30*60*1000);
 const watch=setInterval(()=>{if(session.popup.closed){sessionStatus(session,'failed','本机渲染窗口已关闭');session.cleanup();}},2000);
 session.cleanup=()=>{if(session.closed)return;session.closed=true;clearTimeout(timeout);clearTimeout(deadline);clearInterval(watch);globalThis.removeEventListener('message',listener);activeSessions.delete(session);closeConnectPage('本次连接已结束，请回到比赛页面重新发起渲染。');};
 const listener=async event=>{
  if(session.closed||!validBridgeMessage(event,session.popup,session.nonce)||session.handling)return;
  const message=event.data;
  try{
   if(message.type==='ready'){if(session.sent)return;session.sent=true;clearTimeout(timeout);sessionStatus(session,'queued','已连接本机助手，等待开始渲染');notifyBridge(session,'job',{job:session.job});return;}
   if(message.type==='status'){const status=['downloading','rendering','encoding','uploading'].includes(message.status??message.state)?(message.status??message.state):'rendering';const detail=message.detail??message.message;sessionStatus(session,status,typeof detail==='string'?detail.slice(0,120):'');return;}
   if(message.type==='error'){sessionStatus(session,'failed','本机渲染未完成，请查看本机助手');session.cleanup();return;}
   if(message.type==='complete'){sessionStatus(session,'validating');session.handling=true;await session.finish(message);notifyBridge(session,'complete-ack',{job_id:session.job.job_id,ok:true});session.cleanup();return;}
   session.handling=true;await session.receive(message);
  }catch{sessionStatus(session,'failed','上传未完成，请重新连接本机助手');notifyBridge(session,'error',{error:'upload_failed'});session.cleanup();}
  finally{session.handling=false;}
 };
 globalThis.addEventListener('message',listener);
 activeSessions.add(session);emitSession(session);
 if(!warningInstalled){globalThis.addEventListener('beforeunload',event=>{if(activeSessions.size){event.preventDefault();event.returnValue='';}});warningInstalled=true;}
}

export function mountNativeRender(container,{clip,rows=[],onTick=()=>{},getSpeed=()=>.5,onReady=()=>{}}={}){
 if(!container||!clip)return {destroy(){},seek(){},pause(){}};
 let alive=true,job=null,video=null,frameRequest=null,frameRevision=0,lastFrameTime=-1,presentedTime=null,presentedRevision=-1,seekRevision=0,seekPending=false,pendingFrameIndex=null,pendingTick=null,loadController=new AbortController(),loadRevision=0,session=null,evidence=null,evidenceController=null,observedFrame=-1;
 const key=nativeClipKey(clip),batchRows=nativeBatchRows(rows,clip),canRender=!clip.legacy&&clipDuration(clip)>0;
 container.classList.add('native-render-root');
 container.innerHTML=`<div class="native-stage-media" data-native-screen>${nativePlaceholderHtml()}</div><div class="native-render-toolbar"><div class="native-render-status" role="status" data-native-status>尚未渲染</div><div class="native-render-actions"><button type="button" class="button button-primary" data-native-single ${canRender?'':'disabled'}>本机渲染</button><button type="button" class="button button-quiet" data-native-batch ${batchRows.length?'':'disabled'}>批量渲染上传</button><a class="text-button native-install-link" href="/assets/local-render/cs2lab-windows.zip" download>安装本机助手</a></div></div><div class="native-inline-connect" data-native-connect hidden><p>依次完成以下两步，保持比赛页面与连接窗口开启：</p><div><a class="button button-quiet" data-native-launch aria-disabled="true">1 · 打开本机助手</a><button type="button" class="button button-primary" data-native-connect-upload disabled>2 · 助手已打开，连接上传</button></div><p>先在系统提示中允许打开 CS2 Demo Lab，助手显示“已启动”后再连接上传。</p></div><div data-native-transport hidden></div><section class="native-evidence" data-native-evidence hidden></section><div class="native-render-notice" role="status" hidden></div><dialog class="native-batch-dialog"></dialog>`;
 const find=selector=>container.querySelector(selector),screen=find('[data-native-screen]'),status=find('[data-native-status]'),notice=find('.native-render-notice'),transport=find('[data-native-transport]'),dialog=find('dialog'),observations=find('[data-native-evidence]'),connect=find('[data-native-connect]'),launch=find('[data-native-launch]'),connectUpload=find('[data-native-connect-upload]');
 const showError=message=>{if(!alive)return;notice.textContent=message;notice.hidden=false;};
 const canConnect=()=>Boolean(alive&&session&&activeSessions.has(session)&&session.clipKeys?.has(key)&&session.status==='queued'&&!session.sent&&!session.closed&&session.popup&&!session.popup.closed);
 function updateConnectionControls(){
  const available=canConnect();connect.hidden=!available;connectUpload.disabled=!available;
  if(available){launch.href=nativeLaunchUrl(location.origin,session.nonce);launch.removeAttribute('aria-disabled');}
  else{launch.removeAttribute('href');launch.setAttribute('aria-disabled','true');}
 }
 const setStatus=(value,detail='')=>{if(!alive)return;status.textContent=statusLabels[value]||'尚未渲染';if(!video)screen.innerHTML=nativePlaceholderHtml(value,detail);updateConnectionControls();};
 const onSessionChange=value=>{if(!alive||!value.clipKeys?.has(key))return;session=value;setStatus(value.status,value.detail);if(value.status==='ready'){const saved=artifactCache.get(key);if(saved)showReady(saved);else load();}};
 function playbackFrameIndex(time,presented=false){
  if(!evidence||!numeric(time)||time<0)return null;
  const position=Math.max(0,time-evidence.video_start_seconds)*evidence.fps,nearest=Math.round(position);
  // Presented PTS identifies a decoded frame. Other media clocks may round a
  // boundary to microseconds; retain floor selection away from that boundary.
  if(presented||Math.abs(position-nearest)<=evidence.fps*1e-6+Number.EPSILON*Math.max(1,position)*4)return Math.max(0,Math.min(evidence.frames.length-1,nearest));
  return nativeEvidenceFrameIndex(evidence,time);
 }
 function observeTime(time,presented=false){const index=playbackFrameIndex(time,presented);updateEvidenceAt(time,presented);const tick=index!==null?evidence.frames[index].tick:nativeTickAtTime(time,job?.alignment);if(tick!==null&&Math.abs(time-lastFrameTime)>.0001){lastFrameTime=time;onTick(tick);}}
 const frame=(now,metadata)=>{frameRequest=null;if(!alive||!video)return;const presented=numeric(metadata?.mediaTime),time=presented?metadata.mediaTime:video.currentTime;if(presented){presentedTime=time;presentedRevision=seekRevision;if(!video.seeking){seekPending=false;pendingFrameIndex=null;}}observeTime(time,presented);updateTransport();if(!video.paused||video.seeking)scheduleFrame();};
 function scheduleFrame(){if(frameRequest!==null||!video)return;const scheduledVideo=video,revision=++frameRevision,callback=(now,metadata)=>{if(alive&&video===scheduledVideo&&revision===frameRevision)frame(now,metadata);};frameRequest=video.requestVideoFrameCallback?video.requestVideoFrameCallback(callback):requestAnimationFrame(callback);}
 function cancelFrame(){frameRevision++;if(frameRequest!==null){if(video?.cancelVideoFrameCallback)video.cancelVideoFrameCallback(frameRequest);else cancelAnimationFrame(frameRequest);frameRequest=null;}}
 function resetEvidence(){evidenceController?.abort();evidenceController=null;evidence=null;observedFrame=-1;observations.hidden=true;observations.innerHTML='';}
 function updateEvidenceAt(time,presented=false){
  if(!alive||!evidence)return;const index=playbackFrameIndex(time,presented);if(index===null||index===observedFrame)return;observedFrame=index;
  const caption=observations.querySelector('[data-native-evidence-frame]'),body=observations.querySelector('[data-native-evidence-body]');if(caption)caption.textContent=`帧 ${index+1} / ${evidence.frames.length}`;if(body)body.innerHTML=nativeEvidenceFrameHtml(evidence,index);
 }
 async function loadEvidence(value){
  const controller=new AbortController();evidenceController=controller;observations.hidden=false;observations.innerHTML='<p class="native-evidence-message" role="status">正在校验帧数据…</p>';
  try{
   const loaded=await fetchNativeEvidence(value,clip,{signal:controller.signal});if(!alive||controller.signal.aborted||job!==value)return;
   evidence=loaded;observedFrame=-1;observations.innerHTML='<details open><summary><strong>引擎观测</strong><span data-native-evidence-frame></span></summary><div data-native-evidence-body></div><p class="native-evidence-coverage" title="当前帧数据仅包含相机、玩家坐标与血量；没有可核验的弹着终点、烟雾体积或燃烧区域。">弹着终点 / 烟火范围：未采集</p></details>';const presented=presentedTime!==null&&presentedRevision===seekRevision;updateEvidenceAt(presented?presentedTime:video?.currentTime??0,presented);
  }catch(error){if(!alive||controller.signal.aborted||job!==value)return;observations.innerHTML='<p class="native-evidence-message" role="status">帧数据暂不可用</p>';}
 }
 const showReady=value=>{
  resetEvidence();
  const artifact=value.artifacts?.find(row=>row.kind==='pov'),media=nativeMediaUrl(artifact?`/api/native-jobs?job_id=${encodeURIComponent(value.job_id)}&artifact_id=${encodeURIComponent(artifact.artifact_id)}`:null),alignment=value.alignment;
  if(!nativeArtifactMatches(value,clip)||!media||!alignment||nativeTickAtTime(0,alignment)===null){artifactCache.delete(key);setStatus('unrendered');showError('片段版本已更新，请重新渲染');return;}
  loadRevision++;loadController.abort();video?.pause();cancelFrame();lastFrameTime=-1;presentedTime=null;presentedRevision=-1;seekPending=false;pendingFrameIndex=null;job=value;artifactCache.set(key,value);onReady(value);setStatus('ready');find('[data-native-single]').textContent='重新渲染';screen.innerHTML='<div class="native-video-viewport"><video class="native-replay-video" preload="metadata" playsinline></video><span class="native-video-reticle" title="视角中心" aria-hidden="true"></span></div>';video=screen.querySelector('video');video.src=media;video.playbackRate=getSpeed();
  const localVideo=video,isCurrent=()=>alive&&video===localVideo;
  video.addEventListener('play',()=>{if(!isCurrent())return;scheduleFrame();updatePlayButton();});video.addEventListener('pause',()=>{if(!isCurrent())return;cancelFrame();if(seekPending&&localVideo.requestVideoFrameCallback)scheduleFrame();updatePlayButton();});video.addEventListener('timeupdate',()=>{if(!isCurrent())return;updateTransport();if(localVideo.requestVideoFrameCallback)return;observeTime(localVideo.currentTime);});video.addEventListener('seeking',()=>{if(!isCurrent()||!localVideo.requestVideoFrameCallback)return;scheduleFrame();});video.addEventListener('seeked',()=>{if(!isCurrent())return;updateTransport();if(localVideo.requestVideoFrameCallback)scheduleFrame();else{seekPending=false;pendingFrameIndex=null;observeTime(localVideo.currentTime);}});video.addEventListener('error',()=>{if(isCurrent())showError('视频暂时无法播放，请重新读取');});
  transport.hidden=false;transport.innerHTML=`<div class="native-video-controls"><button type="button" class="icon-button" data-native-play aria-label="播放原生回放">▶</button><button type="button" class="icon-button" data-native-frame="-1" aria-label="上一帧">‹</button><button type="button" class="icon-button" data-native-frame="1" aria-label="下一帧">›</button><input type="range" data-native-seek min="0" max="1" step="0.001" value="0" aria-label="原生回放时间"><label><span class="sr-only">播放速度</span><select data-native-speed aria-label="原生回放速度">${[.1,.25,.5,1,2].map(speed=>`<option value="${speed}" ${speed===getSpeed()?'selected':''}>${speed}×</option>`).join('')}</select></label><span data-native-clock>0:00</span><button type="button" class="icon-button native-zoom-button" data-native-zoom aria-label="放大原生画面">1×</button><button type="button" class="icon-button" data-native-fullscreen aria-label="全屏原生回放">⛶</button></div><div class="native-shot-timeline" role="group" aria-label="跳转到开枪帧">${(clip.shot_markers||[]).map(shot=>`<button type="button" class="native-shot-marker ${shot.hit?'hit':''}" data-native-shot="${shot.tick}" title="第 ${shot.shot_index} 发">${shot.shot_index}</button>`).join('')}</div>`;
  video.addEventListener('loadedmetadata',()=>{if(!isCurrent())return;if(pendingTick!==null)seekTick(pendingTick);else if(localVideo.requestVideoFrameCallback)scheduleFrame();updateTransport();if(!localVideo.requestVideoFrameCallback)updateEvidenceAt(localVideo.currentTime);});loadEvidence(value);
 };
 function updatePlayButton(){const button=find('[data-native-play]');if(button){button.textContent=video?.paused?'▶':'Ⅱ';button.setAttribute('aria-label',video?.paused?'播放原生回放':'暂停原生回放');}}
 function updateTransport(){if(!video)return;const seek=find('[data-native-seek]'),clock=find('[data-native-clock]');if(seek){seek.max=String(Number.isFinite(video.duration)?video.duration:1);seek.value=String(video.currentTime);}if(clock)clock.textContent=`${video.currentTime.toFixed(2)}s`;}
 function seekTime(time,frameIndex=null){if(!alive||!video||!numeric(time))return;seekRevision++;seekPending=true;pendingFrameIndex=frameIndex;video.pause();cancelFrame();if(video.requestVideoFrameCallback)scheduleFrame();video.currentTime=Math.max(0,Number.isFinite(video.duration)?Math.min(time,video.duration):time);updateTransport();}
 function seekTick(tick){if(!alive)return;pendingTick=tick;if(!video||!job)return;const time=nativeTimeAtTick(tick,job.alignment);if(time!==null)seekTime(time);}
 function stepFrame(direction){
  if(!video||!job)return;const fps=job.alignment.fps||60,offset=job.alignment.video_start_seconds||0;
  const presented=presentedTime!==null&&presentedRevision===seekRevision,current=pendingFrameIndex??playbackFrameIndex(presented?presentedTime:video.currentTime,presented)??Math.floor(Math.max(0,video.currentTime-offset)*fps+fps*1e-6),last=evidence?evidence.frames.length-1:Number.isFinite(video.duration)?Math.max(0,Math.ceil((video.duration-offset)*fps)-1):Infinity;
  // Seek inside an explicitly selected frame: browser/MP4 time-base rounding
  // can select its predecessor at the exact PTS boundary. The first frame stays
  // at the start. Keep this target separate from rVFC's actual presented PTS.
  const index=Math.max(0,Math.min(last,current+direction)),start=offset+index/fps;
  const remaining=Number.isFinite(video.duration)?Math.max(0,video.duration-start):Infinity;
  seekTime(start+(index===0?0:Math.min(.25/fps,remaining/2)),index);
 }
 async function load(){loadController.abort();loadController=new AbortController();const revision=++loadRevision;try{const value=await api(`/api/native-jobs?match_id=${encodeURIComponent(clip.match_id)}&burst_id=${encodeURIComponent(clip.burst_id)}`,{signal:loadController.signal});if(!alive||revision!==loadRevision)return;const rendered=value.clips?.find(row=>row.burst_id===clip.burst_id);if(rendered?.state==='rendered')showReady(rendered);else setStatus('unrendered');}catch(error){if(alive&&revision===loadRevision&&error.name!=='AbortError'){setStatus('unrendered');showError('暂时无法读取渲染状态');}}}
 async function begin(chosen){
  if(creatingJob||activeSessions.size){showError('本机渲染正在进行，请完成当前批次后继续');return;}
  notice.hidden=true;const popup=globalThis.open('about:blank','cs2-native-render','popup,width=560,height=620');if(!popup){showError('请允许弹出本机渲染窗口');return;}
  try{popup.document.title='连接本机渲染';popup.document.body.textContent='正在连接 CS2 本机助手…';}catch{}
  creatingJob=true;try{
   const selection=selectNativeBatch(chosen,new Set(chosen.map(nativeClipKey)));
   const response=await api('/api/native-jobs',jsonPost({action:'create',request_id:crypto.randomUUID(),match_id:clip.match_id,burst_ids:selection.clips.map(row=>row.burst_id)}));
   if(!response.job_id||!response.ticket||!response.plan)throw Error('无法创建渲染任务');if(!nativePlanMatches(response,selection.clips))throw Error('片段数据已更新，请刷新数据后重试');
   session={popup,nonce:nonce64(),job:{job_id:response.job_id,plan:response.plan,demo:response.demo},ticket:response.ticket,clipKeys:new Set(selection.clips.map(nativeClipKey)),status:'queued',detail:'',sent:false,handling:false,prepared:false,artifacts:new Map(),totalBytes:0};
   session.receive=async message=>{
    if(message.job_id!==session.job.job_id)throw Error('Wrong render job');
    if(message.type==='prepared'){
     if(session.prepared)throw Error('Duplicate receipt');
     const receipt=message.receipt;
     for(const rendered of receipt?.clips||[])for(const artifact of rendered.artifacts||[]){if(typeof artifact.artifact_id!=='string'||session.artifacts.has(artifact.artifact_id)||!Number.isInteger(artifact.bytes)||artifact.bytes<=0||artifact.bytes>NATIVE_LIMITS.artifact_bytes||artifact.part_bytes!==262144||!Number.isInteger(artifact.part_count)||artifact.part_count!==Math.ceil(artifact.bytes/artifact.part_bytes))throw Error('Invalid artifact');session.totalBytes+=artifact.bytes;if(session.totalBytes>256*1024*1024)throw Error('Batch too large');session.artifacts.set(artifact.artifact_id,{...artifact,next:0});}
     if(!session.artifacts.size)throw Error('No render artifacts');
     await api('/api/native-jobs',jsonPost({action:'prepare',job_id:session.job.job_id,ticket:session.ticket,receipt}));session.prepared=true;sessionStatus(session,'uploading');notifyBridge(session,'prepared-ack',{job_id:session.job.job_id,ok:true});return;
    }
    if(message.type!=='artifact-part'||!session.prepared)throw Error('Unexpected artifact');
    const artifact=session.artifacts.get(message.artifact_id),body=message.body;
    if(!artifact||message.part_index!==artifact.next||!(body instanceof ArrayBuffer)||body.byteLength!==Math.min(artifact.part_bytes,artifact.bytes-artifact.next*artifact.part_bytes)||body.byteLength>NATIVE_LIMITS.part_bytes||!/^[a-f0-9]{64}$/.test(message.sha256))throw Error('Invalid artifact part');
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',body))].map(value=>value.toString(16).padStart(2,'0')).join('');if(digest!==message.sha256)throw Error('Artifact digest mismatch');
    await api(`/api/native-jobs?job_id=${encodeURIComponent(session.job.job_id)}&artifact_id=${encodeURIComponent(artifact.artifact_id)}&part_index=${artifact.next}`,{method:'PUT',headers:{'content-type':'application/octet-stream','x-native-ticket':session.ticket,'x-content-sha256':digest},body});artifact.next++;notifyBridge(session,'artifact-ack',{job_id:session.job.job_id,artifact_id:artifact.artifact_id,part_index:message.part_index,ok:true});
   };
   session.finish=async message=>{if(message.job_id!==session.job.job_id||!session.prepared||[...session.artifacts.values()].some(row=>row.next!==row.part_count))throw Error('Incomplete upload');const completed=await api('/api/native-jobs',jsonPost({action:'complete',job_id:session.job.job_id,ticket:session.ticket}));for(const row of completed.clips||[]){const selected=selection.clips.find(clip=>clip.burst_id===row.burst_id);if(selected){const value={...row,match_id:completed.match_id,source_sha256:completed.source_sha256};if(nativeArtifactMatches(value,selected))artifactCache.set(nativeClipKey(selected),value);}}sessionStatus(session,'ready');};
   session.detail='在这里依次点击“打开本机助手”和“助手已打开，连接上传”，连接窗口也保留相同步骤';setStatus('queued',session.detail);await relaySession(session);
  }catch(error){session?.cleanup?.();popup.close();setStatus('unrendered');showError(error.message);}finally{creatingJob=false;}
 }
 function batch(){
  const checked=new Set();let seconds=0;for(const row of batchRows){const duration=clipDuration(row);if(!artifactCache.has(nativeClipKey(row))&&checked.size<NATIVE_LIMITS.clips&&seconds+duration<=NATIVE_LIMITS.seconds){checked.add(nativeClipKey(row));seconds+=duration;}}
  dialog.innerHTML=nativeBatchHtml(batchRows,checked);for(const label of dialog.querySelectorAll('.native-batch-list label')){const input=label.querySelector('input');if(artifactCache.has(input.value)){label.dataset.rendered='true';label.title='已渲染 · 可勾选重新生成';label.querySelector('span').textContent+=' · 已渲染';}}
  const form=dialog.querySelector('form'),summary=dialog.querySelector('.native-batch-summary'),submit=form.querySelector('[type=submit]');
  function read(){try{const value=selectNativeBatch(batchRows,new Set([...form.querySelectorAll('input:checked')].map(input=>input.value)));summary.textContent=`${value.clips.length} 个片段 · ${value.seconds.toFixed(1)} 秒`;submit.disabled=false;return value;}catch(error){summary.textContent=error.message;submit.disabled=true;return null;}}
  form.addEventListener('change',read);form.addEventListener('submit',event=>{event.preventDefault();const value=read();if(value){dialog.close();begin(value.clips);}});dialog.querySelectorAll('[data-native-close]').forEach(button=>button.addEventListener('click',()=>dialog.close()));read();dialog.showModal();
 }
 function click(event){if(!alive)return;const target=event.target.closest('button,a');if(!target)return;if(target.matches('[data-native-launch]')){if(!canConnect()){event.preventDefault();updateConnectionControls();}return;}if(target.matches('[data-native-connect-upload]')){if(!canConnect()){updateConnectionControls();return;}try{session.popup.location.href=`${NATIVE_LIMITS.bridge_origin}/bridge#${session.nonce}`;}catch{sessionStatus(session,'failed','连接窗口无法打开，请重新发起渲染');session.cleanup();}return;}if(target.matches('[data-native-single]'))begin([clip]);else if(target.matches('[data-native-batch]'))batch();else if(target.matches('[data-native-play]')){if(video?.paused)video.play().catch(()=>showError('无法播放，请重试'));else video?.pause();}else if(target.matches('[data-native-frame]')&&video)stepFrame(Number(target.dataset.nativeFrame));else if(target.matches('[data-native-shot]'))seekTick(Number(target.dataset.nativeShot));else if(target.matches('[data-native-zoom]')&&video){const zoom=Number(video.dataset.zoom||1),next=zoom===1?2:zoom===2?4:1;video.dataset.zoom=String(next);video.style.transform=`scale(${next})`;target.textContent=`${next}×`;target.setAttribute('aria-label',`画面放大 ${next} 倍`);}else if(target.matches('[data-native-fullscreen]'))screen.requestFullscreen?.().catch(()=>{});}
 container.addEventListener('click',click);
 container.addEventListener('input',event=>{if(alive&&event.target.matches('[data-native-seek]')&&video)seekTime(Number(event.target.value));});
 container.addEventListener('change',event=>{if(alive&&event.target.matches('[data-native-speed]')&&video)video.playbackRate=Number(event.target.value);});
 sessionSubscribers.add(onSessionChange);session=[...activeSessions].find(value=>value.clipKeys?.has(key))||null;if(session){setStatus(session.status,session.detail);}else if(artifactCache.has(key))showReady(artifactCache.get(key));else load();
  return {seek:seekTick,pause(){video?.pause();cancelFrame();if(alive&&seekPending&&video?.requestVideoFrameCallback)scheduleFrame();},destroy(){alive=false;updateConnectionControls();loadController.abort();resetEvidence();video?.pause();cancelFrame();if(video){video.removeAttribute('src');video.load();}container.removeEventListener('click',click);sessionSubscribers.delete(onSessionChange);}};
}
