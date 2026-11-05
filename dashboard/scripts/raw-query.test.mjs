import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {runQuery,QUERY_TOOLS} from '../worker/query.mjs';
import {makeWorker} from '../worker/server.mjs';
import {sha256Bytes,matchKey} from '../worker/storage.mjs';
const owner='76561190000000001',other='76561190000000002',id='1'.repeat(24),revision='2'.repeat(40);
const packed=value=>{const text=JSON.stringify(value);return {encoding:'gzip-base64-json',data:gzipSync(text).toString('base64'),decoded_bytes:Buffer.byteLength(text),count:value.length};};
function fixture(){
  const rounds=[1,2,3].map((number,index)=>({round_number:number,side:number===2?'CT':'T',start_tick:100+index*1000,end_tick:999+index*1000,kills:0,deaths:1,damage:index===1?null:0,nullable:null,events:[{type:'damage',tick:120+index*1000,health:73,index,payload:{trajectory:Array.from({length:25},(_,i)=>[i,100+i,200+i]),secret:'must-not-leak'}}]}));
  delete rounds[2].damage;
  const match={match_id:id,analysis_version:'2.6',player:{steamid:owner},rounds,players:[{steamid:owner,rounds:[rounds[0]]},{steamid:other,rounds:[{round_number:1,start_tick:100,damage:7,events:[{tick:121,type:'hurt',health:66}]}]}],replay:{version:'1.2',tickrate:64,player_fields:['player_index','x','y','z','yaw','pitch','alive','team','health','armor'],players:[{index:0,steamid:owner},{index:1,steamid:other}],rounds:[{round_number:1,start_tick:100,end_tick:999,frames:packed([[100,[[0,10,20,30,90,0,1,2,100,50],[1,70,80,90,180,0,1,3,73,0]]],[108,[[0,11,20,30,91,0,1,2,100,50],[1,71,80,90,181,0,1,3,60,0]]]]),shots:[{id:'s1',tick:121,shooter_index:0,impacts:[{tick:121,position:[1,2,3],sequence:1}]}],unassociated_impacts:[{tick:122,shooter_index:1,position:[9,8,7]}],damage_events:[{tick:121,attacker_index:0,victim_index:1,health:73}],tactical:{bomb:{carrier_frames:[[100,0,10,20,30]],events:[{tick:150,type:'planted'}]},effects:[{tick:151,type:'smoke',centres:[[151,1,2,3]]}]}}]}};
  match.rounds[0].analysis={level3:{mechanics:{aim_playback:{point_fields:['tick','yaw','pitch'],windows:[{burst_id:'r1:b121',trajectory:(()=>{const text=JSON.stringify({points:[[100,90,0],[108,91,1]],geometry:{camera_fields:['tick','eye_z'],camera:[[100,64],[108,63.5]]},targets:[{steamid:other,points:[[100,1,2],[108,3,4]]}]});return {encoding:'gzip-base64-json',data:gzipSync(text).toString('base64'),decoded_bytes:Buffer.byteLength(text)};})()}]}}}};
  return {schema_version:'1.0',generated_at:'2026-11-01T00:00:00Z',profile:{steamid64:owner},matches:[match],delivery:{source_revision:revision}};
}
const query=(extra={})=>({resource:'raw_rows',match_id:id,raw_dataset:'owner_rounds',...extra});
test('raw directory and actual field discovery separate missing, null, tuples and unparsed Demo coverage',async()=>{
  const value=fixture(),catalog=await runQuery(value,{resource:'raw_schema'});
  assert.equal(catalog.datasets.find(item=>item.raw_dataset==='replay_frames').round_number_required,true);
  assert.equal(catalog.datasets[0].unparsed_demo,false);assert.equal(catalog.limits.max_batch_queries,6);
  const schema=await runQuery(value,query({resource:'raw_schema',limit:100})),damage=schema.items.find(item=>item.field==='damage');
  assert.deepEqual(damage.types,['number','null']);assert.equal(damage.null_count,1);assert.equal(damage.missing_count,1);assert.equal(schema.field_sample_rows,3);
  assert.ok(QUERY_TOOLS.find(tool=>tool.name==='query_raw_data').annotations.readOnlyHint);
});
test('raw predicates scan the requested dataset before paging and preserve zero, null and missing separately',async()=>{
  const value=fixture();
  const zero=await runQuery(value,query({columns:['round_number','damage'],filters:[{field:'damage',op:'eq',value:0}],source_revision:revision}));
  assert.equal(zero.scanned_rows,3);assert.equal(zero.selected_rows,1);assert.deepEqual(zero.items[0].record,{round_number:1,damage:0});
  const nil=await runQuery(value,query({columns:['damage'],filters:[{field:'damage',op:'eq',value:null}]}));assert.deepEqual(nil.items[0].record,{damage:null});
  const missing=await runQuery(value,query({columns:['damage'],filters:[{field:'damage',op:'exists',value:false}]}));assert.deepEqual(missing.items[0].record,{});assert.deepEqual(missing.items[0].missing_fields,['damage']);
  const first=await runQuery(value,query({columns:['round_number'],limit:1}));const second=await runQuery(value,query({columns:['round_number'],offset:first.pagination.next_offset,limit:1}));assert.equal(second.items[0].record.round_number,2);assert.deepEqual(second.items[0].locator.path,['rounds','1']);
});
test('nested raw event projection retains all saved values and exact locator instead of compact descriptors',async()=>{
  const value=fixture(),result=await runQuery(value,query({raw_dataset:'owner_events',round_number:1,columns:['tick','payload.trajectory']}));
  assert.deepEqual(result.items[0].record['payload.trajectory'],value.matches[0].rounds[0].events[0].payload.trajectory);assert.equal(result.items[0].record['payload.trajectory'].length,25);
  assert.deepEqual(result.items[0].locator.path,['rounds','0','events','0']);assert.match(result.items[0].evidence_ref,/raw:owner_events/);
  const sanitized=await runQuery(value,query({raw_dataset:'owner_events',round_number:1,columns:['payload']}));assert.ok(!JSON.stringify(sanitized).includes('must-not-leak'));assert.deepEqual(sanitized.items[0].omitted_fields,['payload.secret']);
  const player=await runQuery(value,query({raw_dataset:'player_events',player_id:other,columns:['health']}));assert.equal(player.items[0].record.health,66);assert.equal(player.items[0].locator.player_id,other);assert.deepEqual(player.items[0].locator.path,['players','1','rounds','0','events','0']);
});
test('decoded actor frames expose actual health/coordinates, actor filters and source tuple offsets',async()=>{
  const result=await runQuery(fixture(),query({raw_dataset:'replay_frames',round_number:1,player_id:other,columns:['tick','player_index','x','health'],filters:[{field:'health',op:'lt',value:70}]}));
  assert.equal(result.scanned_rows,2);assert.equal(result.items.length,1);assert.deepEqual(result.items[0].record,{tick:108,player_index:1,x:71,health:60});assert.deepEqual(result.items[0].locator.decoded_path,['1','1','1']);assert.equal(result.items[0].locator.tuple_fields[8],'health');
  await assert.rejects(runQuery(fixture(),query({raw_dataset:'replay_frames',round_number:1,tick_from:100,tick_to:2021})),/frame_window_exceeds_30_seconds/);
  const broken=fixture();broken.matches[0].replay.rounds[0].frames.decoded_bytes++;await assert.rejects(runQuery(broken,query({raw_dataset:'replay_frames',round_number:1})),/frames_unavailable/);
});
test('compressed aim points/camera and impacts retain real decoded locators without claiming engine geometry',async()=>{
  const value=fixture(),points=await runQuery(value,query({raw_dataset:'aim_points',round_number:1,clip_id:'r1:b121',columns:['tick','yaw'],tick_from:108}));
  assert.deepEqual(points.items[0].record,{tick:108,yaw:91});assert.deepEqual(points.items[0].locator.decoded_path,['points','1']);
  const camera=await runQuery(value,query({raw_dataset:'aim_camera',round_number:1,columns:['eye_z']}));assert.equal(camera.items[1].record.eye_z,63.5);
  const impacts=await runQuery(value,query({raw_dataset:'replay_impacts',round_number:1,player_id:owner,columns:['position']}));assert.deepEqual(impacts.items[0].record.position,[1,2,3]);assert.equal(impacts.items[0].locator.shot_id,'s1');
  const bomb=await runQuery(value,query({raw_dataset:'bomb_carrier_frames',round_number:1,columns:['tick','x']}));assert.deepEqual(bomb.items[0].record,{tick:100,x:10});
});
test('raw reads pin the snapshot before I/O and carry verified immutable detail provenance',async()=>{
  const value=fixture(),full=value.matches[0],hash='a'.repeat(64),reference={content_sha256:hash,source_revision:revision};value._cs2_storage={kind:'match_index'};value.matches=[{match_id:id,rounds:full.rounds,detail_ref:reference}];let loads=0;
  const options={loadMatch:async ref=>{loads++;assert.equal(ref.content_sha256,hash);return full;}};
  await assert.rejects(runQuery(value,query({source_revision:'f'.repeat(40)}),{},options),/source_revision_mismatch/);assert.equal(loads,0);
  const result=await runQuery(value,query({source_revision:revision,columns:['damage']}),{},options);assert.equal(loads,1);assert.equal(result.provenance.detail_content_sha256,hash);assert.equal(result.source.source_revision,revision);
});
test('raw validation rejects executable inputs, prototype/secret paths and unbounded scans before reading',async()=>{
  for(const extra of [{columns:['__proto__.secret']},{columns:['constructor']},{columns:['payload.secret']},{filters:[{field:'damage',op:'code',value:'run'}]},{filters:[{field:'damage',op:'exists',value:'yes'}]},{raw_dataset:'filesystem'},{limit:1000},{raw_dataset:'replay_frames'}])await assert.rejects(runQuery(fixture(),query(extra)),error=>error.status===400);
  const value=fixture();value.matches[0].rounds[0].events=Array.from({length:40},(_,i)=>({tick:120+i,text:'x'.repeat(2000),i}));
  const first=await runQuery(value,query({raw_dataset:'owner_events',round_number:1,columns:['i','text'],limit:100}));assert.ok(first.items.length>0&&first.items.length<40);assert.equal(first.response_limited,true);assert.equal(first.pagination.next_offset,first.items.length);assert.ok(Buffer.byteLength(JSON.stringify(first))<34*1024);
  const next=await runQuery(value,query({raw_dataset:'owner_events',round_number:1,columns:['i','text'],offset:first.pagination.next_offset}));assert.equal(next.items[0].record.i,first.items.length);
});
test('authenticated MCP raw batches share one verified immutable shard and isolate per-query errors',async()=>{
  const snapshot=fixture(),full=snapshot.matches[0],bytes=new TextEncoder().encode(JSON.stringify(full)),hash=await sha256Bytes(bytes),reference={schema_version:'1.0',match_id:id,content_sha256:hash,decoded_bytes:bytes.length,path:`reports/dashboard.matches/${id}.json`,source_revision:revision};
  const index={...snapshot,_cs2_storage:{kind:'match_index'},matches:[{match_id:id,rounds:[],detail_ref:reference}]};let shardLoads=0;
  const env={BUCKET:{get:async key=>key==='dashboard/latest.json'?{json:async()=>({snapshot:index,source_revision:revision})}:key===matchKey(reference)?(shardLoads++,{size:bytes.length,customMetadata:{owner,content_sha256:hash},arrayBuffer:async()=>bytes.buffer}):null}};
  const worker=makeWorker({page:'',css:'',client:'',initial:snapshot});
  const rpc=(name,args,authenticated=true)=>new Request('https://test.example/mcp',{method:'POST',headers:{'content-type':'application/json',...(authenticated?{'oai-authenticated-user-id':'owner'}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  assert.equal((await worker.fetch(rpc('query_raw_data',{match_id:id,raw_dataset:'owner_rounds'},false),env)).status,401);assert.equal(shardLoads,0);
  const response=await (await worker.fetch(rpc('read_raw_data_batch',{queries:[{match_id:id,raw_dataset:'owner_rounds',columns:['damage'],limit:1},{match_id:id,raw_dataset:'owner_events',columns:['health'],round_number:1},{match_id:id,raw_dataset:'owner_rounds',columns:['secret']},{match_id:id,raw_dataset:'replay_damage',round_number:1,columns:['health']}]}),env)).json();
  const result=response.result.structuredContent;assert.equal(shardLoads,1);assert.deepEqual(result.results.map(item=>item.status),['complete','complete','error','complete']);assert.equal(result.results[3].data.items[0].record.health,73);assert.equal(result.results[0].data.provenance.detail_content_sha256,hash);
  const tooMany=await (await worker.fetch(rpc('read_raw_data_batch',{queries:Array.from({length:7},()=>({match_id:id,raw_dataset:'owner_rounds'}))}),env)).json();assert.equal(tooMany.result.structuredContent.error,'invalid_raw_batch');
});
