import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoachHandler} from '../worker/coach.mjs';
import {AgentRuntimeError,createAgentRuntime,createMemoryAgentStore} from '../worker/agent-runtime.mjs';
import {readSseEvents} from '../worker/agent-stream.mjs';

const owner='76561198000000000',match='a'.repeat(24),source={source_revision:'b'.repeat(40),content_sha256:'c'.repeat(64),generated_at:'2026-11-09T00:00:00Z'};
const selection={match_id:match,raw_dataset:'owner_rounds',columns:['round_number','damage','deaths'],filters:[{field:'damage',op:'eq',value:0},{field:'deaths',op:'gt',value:0}],source_revision:source.source_revision};
const rawQuery=()=>({resource:'raw_rows',...structuredClone(selection)});
const fresh=()=>({id:crypto.randomUUID(),turn_id:crypto.randomUUID(),create:true,action:'message'});
const report=(reference,visualizations=[])=>({headline:'已核对零伤害阵亡的原始记录',summary:'3 个原始回合中只有第 1 回合符合伤害为 0 且阵亡大于 0，空值和缺失值没有计为 0。',findings:[{title:'原始条件匹配 1 回合',assessment:'第 1 回合 damage=0、deaths=1；原始查询扫描 3 行、命中 1 行。',priority:'medium',evidence_refs:[reference]}],training:[],limitations:['仅核对指定比赛保存的解析数据。'],visualizations});
function snapshot(){return {profile:{steamid64:owner},generated_at:source.generated_at,delivery:source,aggregate:{matches:1,rounds:3,adr:0},matches:[{match_id:match,map_name:'de_inferno',analysis_version:'2.6',player:{steamid:owner},rounds:[{round_number:1,side:'T',damage:0,deaths:1,kills:0},{round_number:2,side:'CT',damage:null,deaths:1,kills:0},{round_number:3,side:'T',deaths:1,kills:0}]}]};}
function provider(item){const terminal={type:'response.completed',sequence_number:0,response:{status:'completed',output:[item],usage:{input_tokens:10,output_tokens:20}}},bytes=new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`);let offset=0;return new Response(new ReadableStream({pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(offset+17,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;}}),{headers:{'content-type':'text/event-stream'}});}
const call=(name,args,call_id)=>({type:'function_call',name,call_id,arguments:JSON.stringify(args)});
async function events(response){const values=[];for await(const frame of readSseEvents(response.body))values.push(JSON.parse(frame.data));return values;}
function visual(reference){return {title:'原始条件命中回合伤害',description:'绑定实际过滤结果的伤害字段。',evidence_refs:[reference],document:{version:1,kind:'observed',assumptions:[],dataBindings:[{name:'rows',evidence_ref:reference,path:['items']}],params:[],lets:[],nodes:[{id:'damage',parent:null,tag:'span',attrs:[],style:[],text:null,bindings:[{target:'text',expr:'data.rows[0].record.damage'}],when:null,repeat:null,action:null}],actions:[]}};}

test('real streaming handler archives filtered raw rows and restores exact evidence and bound artifacts through read-only GET',async()=>{
 const store=createMemoryAgentStore(),conversation=fresh(),lifetime=[];let models=0,reference,candidate,providerError;
 const handler=createCoachHandler({sessionStore:store,loadSnapshot:async()=>snapshot(),getEnv:()=>({DEEPSEEK_API_KEY:'FIXTURE_ONLY'}),fetchImpl:async(_,options)=>{
  try{const body=JSON.parse(options.body);models++;assert.equal(body.stream,true);
  if(models===1)return provider(call('query_raw_data',selection,'raw_filter'));
  if(models===2){const continuation=JSON.parse(body.input.find(item=>item.type==='function_call_output'&&item.call_id==='raw_filter').output);reference=continuation.query_evidence_ref;const context=JSON.parse(body.input.find(item=>item.role==='user').content),output=context.trusted_query_results.find(item=>item.query_evidence_ref===reference);assert.equal(output.resource,'raw_rows');assert.equal(output.scanned_rows,3);assert.equal(output.selected_rows,1);assert.deepEqual(output.items.map(item=>item.record),[{round_number:1,damage:0,deaths:1}]);assert.equal(output.source.content_sha256,source.content_sha256);candidate=visual(reference);return provider(call('validate_visualization',{visualizations:[candidate]},'raw_visual'));}
  assert.equal(models,3);const checked=JSON.parse(body.input.find(item=>item.type==='function_call_output'&&item.call_id==='raw_visual').output);assert.equal(checked.valid,true,JSON.stringify(checked));return provider(call('present_coach_analysis',report(reference,[candidate]),'raw_report'));}catch(error){providerError=error;throw error;}
 }});
 const response=await handler(new Request('https://example.test/api/coach',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify({question:'核查指定比赛的零伤害阵亡原始条件。',context:{view:'coach',match_id:match,data_scope:'current_selection'},conversation})}),{waitUntil:promise=>lifetime.push(promise)});
 assert.equal(response.status,200);const streamed=await events(response);await Promise.all(lifetime);if(providerError)throw providerError;assert.equal(streamed.at(-1).type,'completed',JSON.stringify(streamed.at(-1)));assert.equal(models,3);
 const rawActivities=streamed.filter(event=>event.type==='activity'&&event.payload.resource==='raw_rows');assert.ok(rawActivities.some(event=>event.payload.status==='completed'));for(const event of rawActivities){assert.equal(Object.hasOwn(event.payload.query??{},'filters'),false);assert.equal(Object.hasOwn(event.payload.query??{},'columns'),false);assert.equal(Object.hasOwn(event.payload.query??{},'raw_dataset'),false);}
 const stage=streamed.find(event=>event.type==='artifact');assert.ok(stage,'A filtered raw query may back a validated projected stage artifact');assert.equal(stage.payload.visualizations[0].data.rows[0].record.damage,0);assert.deepEqual(stage.payload.visualizations[0].provenance[0].source,source);assert.deepEqual(stage.payload.visualizations[0].provenance[0].path,['items']);assert.deepEqual(stage.payload.evidence.find(item=>item.query_ref===reference).query.filters,selection.filters);
 const before=await store.load(`coach/v3/${owner}/sessions/${conversation.id}.json`),url=new URL('https://example.test/api/coach');url.searchParams.set('conversation_id',conversation.id);url.searchParams.set('turn_id',conversation.turn_id);url.searchParams.set('query_ref',reference);
 const savedResponse=await handler(new Request(url));assert.equal(savedResponse.status,200);const saved=await savedResponse.json();assert.equal(saved.read_only,true);assert.equal(saved.stale,false);assert.equal(saved.query_ref,reference);assert.deepEqual(saved.query.filters,selection.filters);assert.deepEqual(saved.query.columns,selection.columns);assert.equal(saved.source.content_sha256,source.content_sha256);assert.deepEqual(saved.result.items.map(item=>item.record),[{round_number:1,damage:0,deaths:1}]);
 const recovery=await events(await handler(new Request('https://example.test/api/coach?conversation_id='+conversation.id,{headers:{accept:'text/event-stream'}})));assert.deepEqual(recovery.map(event=>event.type),['snapshot','validated','completed']);assert.deepEqual(recovery.find(event=>event.type==='validated').payload.agent.visualizations[0].provenance[0].source,source);assert.equal(models,3);assert.deepEqual(await store.load(`coach/v3/${owner}/sessions/${conversation.id}.json`),before);
});

test('archive and observed query normalization preserve raw predicates without injecting pagination defaults or widening plan scopes',async()=>{
 const runtime=createAgentRuntime({owner}),controller=await runtime.begin({question:'记录原始查询',source}),query=rawQuery(),result={resource:'raw_rows',source,items:[{record:{round_number:1,damage:0,deaths:1}}]};
 const saved=await controller.rememberQuery({...query,player_id:null},result);assert.deepEqual(saved.query,query);assert.equal(Object.hasOwn(saved.query,'offset'),false);assert.equal(Object.hasOwn(saved.query,'limit'),false);assert.equal(Object.hasOwn(saved.query,'player_id'),false);assert.deepEqual((await controller.cachedQuery(query)).query,query);assert.equal(await controller.cachedQuery({...query,offset:0,limit:25}),null);
 await controller.observed(query,saved.reference);assert.deepEqual(controller.turn.plan_observations.find(item=>item.reference===saved.reference).query,query);assert.deepEqual((await controller.restoreQuery(saved.reference)).query,query);
 await assert.rejects(controller.plan({action:'set',step_id:null,steps:[{id:'raw',label:'读取原始条件',resources:['raw_rows'],operation:'read_data',depends_on:[],scope:{match_id:match,filters:selection.filters}}]}),error=>error instanceof AgentRuntimeError&&error.code==='invalid_task_plan');
 await controller.pause();const restored=await runtime.readQuery(controller.record.id,source,{turnId:controller.turn.id,reference:saved.reference});assert.deepEqual(restored.query,query);assert.deepEqual(restored.result.items,result.items);
});

test('raw archive validation rejects invalid predicates, unsafe paths, accessors and foreign prototypes before storing or invoking getters',async()=>{
 const backing=createMemoryAgentStore();let writes=0,gets=0;const store={...backing,async write(...args){writes++;return backing.write(...args);}},controller=await createAgentRuntime({owner,store}).begin({question:'校验原始查询',source}),value={source,items:[]},invalid=[
  {...rawQuery(),filters:[{field:'damage',op:'execute',value:0}]},
  {...rawQuery(),filters:[{field:'damage',op:'exists',value:0}]},
  {...rawQuery(),filters:[{field:'damage',op:'eq',value:{nested:0}}]},
  {...rawQuery(),filters:[{field:'damage',op:'eq',value:NaN}]},
  {...rawQuery(),filters:[{field:'payload.authorization',op:'eq',value:'PRIVATE_MARKER'}]},
  {...rawQuery(),columns:['payload.__proto__.secret']},
  {...rawQuery(),columns:['payload.access_token']},
  {...rawQuery(),source_revision:'not-a-source'},
  {...rawQuery(),filters:[{field:'damage',op:'eq',value:0,secret:'PRIVATE_MARKER'}]},
  Object.assign(Object.create({hidden:'PRIVATE_MARKER'}),rawQuery()),
 ];
 const fieldAccessor={op:'eq',value:0};Object.defineProperty(fieldAccessor,'field',{enumerable:true,get(){gets++;return 'damage';}});invalid.push({...rawQuery(),filters:[fieldAccessor]});
 const arrayAccessor=[{field:'damage',op:'eq',value:0}];Object.defineProperty(arrayAccessor,'0',{enumerable:true,get(){gets++;return {field:'damage',op:'eq',value:0};}});invalid.push({...rawQuery(),filters:arrayAccessor});
 const topAccessor=rawQuery();Object.defineProperty(topAccessor,'filters',{enumerable:true,get(){gets++;return [];} });invalid.push(topAccessor);
 const resourceAccessor=rawQuery();Object.defineProperty(resourceAccessor,'resource',{enumerable:true,get(){gets++;return 'raw_rows';}});invalid.push(resourceAccessor);
 const filterPrototype=Object.assign(Object.create({hidden:'PRIVATE_MARKER'}),{field:'damage',op:'eq',value:0});invalid.push({...rawQuery(),filters:[filterPrototype]});
 const baseline=writes;
 for(const query of invalid){await assert.rejects(controller.rememberQuery(query,value),error=>error instanceof AgentRuntimeError&&['invalid_activity','invalid_task_plan'].includes(error.code)&&!error.message.includes('PRIVATE_MARKER'));await assert.rejects(controller.cachedQuery(query),AgentRuntimeError);await assert.rejects(controller.observed(query,'actual:invalid'),AgentRuntimeError);}
 assert.equal(gets,0);assert.equal(writes,baseline);assert.equal(controller.turn.query_sequence??0,0);assert.equal(controller.turn.plan_observations?.length??0,0);
});
