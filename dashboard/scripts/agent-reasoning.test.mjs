import test from 'node:test';
import assert from 'node:assert/strict';
import {readResponsesStream,readSseEvents} from '../worker/agent-stream.mjs';
import {createCoachHandler} from '../worker/coach.mjs';
import {createMemoryAgentStore} from '../worker/agent-runtime.mjs';
import {createProviderTraceCollector,providerTraceTail} from '../worker/agent-reasoning.mjs';
const enc=new TextEncoder(),text='依据真实数据分析 <script>untrusted</script>。';
const response=events=>new Response(events.map((event,index)=>`data: ${JSON.stringify({sequence_number:index,...event})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
const final=output=>({type:'response.completed',response:{status:'completed',output}});
test('documented plaintext reasoning is opt-in and terminal repetition is not duplicated',async()=>{
 const reasoning={type:'reasoning',content:[{type:'reasoning_text',text}]},events=[{type:'response.reasoning_text.delta',output_index:0,delta:text},final([reasoning])],chunks=[];
 await readResponsesStream(response(events),{onReasoning:value=>chunks.push(value.text)});assert.equal(chunks.join(''),text);
 const privateDefault=await readResponsesStream(response(events));assert.deepEqual(privateDefault.output,[reasoning]);
});
test('actual handler streams the dedicated DeepSeek trace, persists it for GET and keeps credentials server-side',async()=>{
 const source={source_revision:'a'.repeat(40),generated_at:'2026-11-05T00:00:00Z',content_sha256:'b'.repeat(64)},owner='76561198000000000',id='c'.repeat(24),snapshot={profile:{steamid64:owner},generated_at:source.generated_at,delivery:source,aggregate:{matches:1,rounds:1},matches:[{match_id:id,map_name:'de_nuke',rounds:[{round_number:1,side:'T',damage:80,kills:1,deaths:0}]}]},conversation={id:crypto.randomUUID(),turn_id:crypto.randomUUID(),action:'message',create:true};let models=0;
 const handler=createCoachHandler({sessionStore:createMemoryAgentStore(),loadSnapshot:async()=>snapshot,getEnv:()=>({DEEPSEEK_API_KEY:'SERVER_ONLY_TEST_KEY'}),fetchImpl:async(_,options)=>{
  models++;const body=JSON.parse(options.body);assert.ok(body.tools.some(tool=>tool.name==='edit_task_workflow'));assert.ok(body.tools.some(tool=>tool.name==='query_raw_data'));
  const context=JSON.parse(body.input.find(item=>item.role==='user').content),ref=context.trusted_query_results[2].query_evidence_ref,report={headline:'验证报告',summary:'依据已读数据。',findings:[{title:'伤害',assessment:'80 HP。',priority:'medium',evidence_refs:[ref]}],training:[],limitations:[],visualizations:[]};
  return response([{type:'response.reasoning_text.delta',output_index:0,delta:text},final([{type:'reasoning',content:[{type:'reasoning_text',text}]},{type:'function_call',name:'present_coach_analysis',call_id:'report',arguments:JSON.stringify(report)}])]);
 }});
 const request=new Request('https://example.test/api/coach',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify({question:'仅核对现有伤害。',conversation})}),events=[];
 for await(const item of readSseEvents((await handler(request)).body))events.push(JSON.parse(item.data));
 assert.equal(events.at(-1).type,'completed');assert.equal(events.filter(item=>item.type==='provider_trace').map(item=>item.payload.text).join(''),text);assert.ok(!JSON.stringify(events).includes('SERVER_ONLY_TEST_KEY'));
 const recovered=await(await handler(new Request('https://example.test/api/coach?conversation_id='+conversation.id))).json();assert.equal(recovered.task.provider_trace[0].text,text);assert.equal(recovered.task.provider_trace[0].status,'completed');assert.equal(models,1);assert.ok(!JSON.stringify(recovered.result.analysis).includes(text));
});
test('trace retention is a UTF-8-safe display bound, not a generation limit',async()=>{
 const value='中🙂'.repeat(30000),tail=providerTraceTail(value);assert.ok(enc.encode(tail.text).length<=64*1024);assert.equal(tail.truncated,true);assert.ok(!tail.text.includes('\ufffd'));
 const saved=[],emitted=[],collector=createProviderTraceCollector({attempt:1,provider:'deepseek',model:'deepseek-flash',persist:value=>saved.push(value),emit:value=>emitted.push(value)});await collector.start();await collector.delta(value);await collector.finish('interrupted');await collector.finish();assert.equal(saved.at(-1).status,'interrupted');assert.equal(emitted.filter(item=>item.status==='interrupted').length,1);assert.equal(saved.at(-1).truncated,true);
});

test('a failed provider terminal preserves reasoning as interrupted without marking its response complete',async()=>{
 const source={source_revision:'a'.repeat(40),generated_at:'2026-11-05T00:00:00Z',content_sha256:'b'.repeat(64)},owner='76561198000000000',id='c'.repeat(24),snapshot={profile:{steamid64:owner},generated_at:source.generated_at,delivery:source,aggregate:{matches:1,rounds:1},matches:[{match_id:id,map_name:'de_nuke',rounds:[{round_number:1,side:'T',damage:80,kills:1,deaths:0}]}]},conversation={id:crypto.randomUUID(),turn_id:crypto.randomUUID(),action:'message',create:true};let models=0;
 const handler=createCoachHandler({sessionStore:createMemoryAgentStore(),loadSnapshot:async()=>snapshot,getEnv:()=>({DEEPSEEK_API_KEY:'SERVER_ONLY_TEST_KEY'}),fetchImpl:async()=>{
  models++;return response([{type:'response.reasoning_text.delta',output_index:0,delta:text},{type:'response.failed',response:{status:'failed',output:[{type:'reasoning',content:[{type:'reasoning_text',text}]}],error:{code:'internal_error',message:'UPSTREAM_ERROR_NOT_EXPOSED'}}}]);
 }}),events=[];
 const request=new Request('https://example.test/api/coach',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify({question:'仅核对现有伤害。',conversation})});
 for await(const item of readSseEvents((await handler(request)).body))events.push(JSON.parse(item.data));
 const traces=events.filter(item=>item.type==='provider_trace');assert.equal(traces.at(-1).payload.status,'interrupted');assert.equal(traces.some(item=>item.payload.status==='completed'),false);assert.equal(events.at(-1).type,'paused');
 const recovered=await(await handler(new Request('https://example.test/api/coach?conversation_id='+conversation.id))).json();assert.equal(recovered.task.provider_trace[0].status,'interrupted');assert.equal(recovered.status,'awaiting_continuation');assert.equal(models,1);assert.doesNotMatch(JSON.stringify({events,recovered}),/SERVER_ONLY_TEST_KEY|UPSTREAM_ERROR_NOT_EXPOSED/);
});
