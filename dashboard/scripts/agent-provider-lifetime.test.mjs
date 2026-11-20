import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoachHandler,coachStatus} from '../worker/coach.mjs';
import {createAgentRuntime,createMemoryAgentStore} from '../worker/agent-runtime.mjs';
import {readSseEvents} from '../worker/agent-stream.mjs';
import {createCoachSession} from '../ui/coach.js';

const owner='76561198000000000',match='a'.repeat(24),source={source_revision:'b'.repeat(40),generated_at:'2026-11-04T00:00:00Z',content_sha256:'c'.repeat(64)},env={DEEPSEEK_API_KEY:'FIXTURE_ONLY'};
const snapshot=()=>({profile:{steamid64:owner},generated_at:source.generated_at,delivery:source,aggregate:{rounds:1,damage:80},matches:[{match_id:match,map_name:'de_nuke',rounds:[{round_number:1,damage:80,kills:1,deaths:0,side:'T'}]}]});
const fresh=()=>({id:crypto.randomUUID(),turn_id:crypto.randomUUID(),action:'message',create:true});
const post=(body,signal)=>new Request('https://example.test/api/coach',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify(body),signal});
const context=body=>body.input.filter(item=>item.role==='user').map(item=>JSON.parse(item.content)).find(item=>item.trusted_query_results);
const report=ref=>({headline:'正式报告',summary:'使用实际读取证据。',findings:[{title:'实测伤害',assessment:'样本为80 HP。',priority:'medium',evidence_refs:[ref]}],training:[],limitations:[],visualizations:[]});
const complete=analysis=>({status:'completed',output:[{type:'function_call',name:'present_coach_analysis',call_id:'present',arguments:JSON.stringify(analysis)}]});
const frame=(type,data)=>new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
const collect=async response=>{const events=[];for await(const event of readSseEvents(response.body))events.push(JSON.parse(event.data));return events;};
const key=conversation=>`coach/v3/${owner}/sessions/${conversation.id}.json`;
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(condition){for(let i=0;i<50&&!condition();i++)await immediate();assert.ok(condition());}

test('a late repair gets an independent response lifetime and finishes after the scheduling deadline',async()=>{
  const store=createMemoryAgentStore(),conversation=fresh();let stamp=Date.parse(source.generated_at),calls=0,providerFailure;
  const handler=createCoachHandler({sessionStore:store,now:()=>stamp,loadSnapshot:async()=>snapshot(),getEnv:()=>env,executionWindow:{api_calls:2,tool_calls:24,timeout_ms:100,provider_timeout_ms:1500,provider_idle_timeout_ms:800},fetchImpl:async(_,options)=>{
    try{
      calls++;const body=JSON.parse(options.body),input=context(body),analysis=report(input.trusted_query_results.at(-1).query_evidence_ref);
      assert.equal(body.max_output_tokens,393216);
      if(calls===1){stamp+=99;delete analysis.headline;return Response.json(complete(analysis));}
      assert.equal(body.reasoning.effort,'high');assert.deepEqual(body.tools.map(tool=>tool.name),['present_coach_analysis']);
      return new Response(new ReadableStream({start(controller){setTimeout(()=>{try{assert.equal(options.signal.aborted,false);stamp+=80;controller.enqueue(frame('response.completed',{response:complete(analysis)}));controller.close();}catch(error){providerFailure=error;controller.error(error);}},40);}}),{headers:{'content-type':'text/event-stream'}});
    }catch(error){providerFailure=error;throw error;}
  }});
  const events=await collect(await handler(post({question:'检查数据',conversation})));if(providerFailure)throw providerFailure;
  assert.equal(calls,2);assert.equal(events.at(-1).type,'completed');const final=events.find(event=>event.type==='validated').payload;
  assert.equal(final.analysis.headline,'正式报告');assert.equal(final.task.progress.model_calls,2);assert.equal(final.session.turn_id,conversation.turn_id);assert.ok(stamp>Date.parse(source.generated_at)+100);assert.equal((await store.load(key(conversation))).value.turn.lease_until,0);
});

test('the request host deadline budgets startup and stops a late provider before saving a resumable checkpoint',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const store=createMemoryAgentStore(),conversation=fresh();
  let stamp=Date.parse(source.generated_at),providerSignal,providerCalls=0,cancelled=0;
  let providerStarted;
  const started=new Promise(resolve=>{providerStarted=resolve;});
  const handler=createCoachHandler({
    sessionStore:store,now:()=>stamp,getEnv:()=>env,
    executionWindow:{api_calls:8,tool_calls:24,timeout_ms:120000,host_timeout_ms:50000},
    loadSnapshot:async()=>{stamp+=39000;return snapshot();},
    fetchImpl:async(_url,options)=>{
      providerSignal=options.signal;
      providerCalls++;
      providerStarted();
      return new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});
    },
  });
  const status=await (await handler(new Request('https://example.test/api/coach'))).json();
  assert.equal(status.execution.host_timeout_ms,50000);
  assert.equal(status.execution.scheduling_timeout_ms,45000);
  assert.equal(status.execution.timeout_ms,45000);
  const reading=collect(await handler(post({question:'检查数据',conversation})));
  await Promise.race([started,reading.then(events=>assert.fail(`Provider never started: ${events.at(-1)?.payload?.task?.pause_reason}`))]);
  t.mock.timers.tick(5999);await immediate();
  assert.equal(providerSignal.aborted,false);
  t.mock.timers.tick(1);
  const paused=(await reading).at(-1);
  assert.equal(paused.type,'paused');
  assert.equal(paused.payload.task.pause_reason,'provider_timeout');
  assert.equal(paused.payload.session.can_resume,true);
  assert.equal(providerCalls,1);
  assert.equal(cancelled,1);
  const saved=(await store.load(key(conversation))).value.turn;
  assert.equal(saved.progress.model_calls,1);
  assert.equal(saved.lease_until,0);
  assert.ok(saved.work.queries.length);
});

test('real provider bytes keep an active response alive without exposing or persisting reasoning',async()=>{
  const store=createMemoryAgentStore(),conversation=fresh();let calls=0;
  const handler=createCoachHandler({sessionStore:store,loadSnapshot:async()=>snapshot(),getEnv:()=>env,executionWindow:{api_calls:1,tool_calls:24,timeout_ms:1000,provider_timeout_ms:1500,provider_idle_timeout_ms:300},fetchImpl:async(_,options)=>{
    calls++;const ref=context(JSON.parse(options.body)).trusted_query_results.at(-1).query_evidence_ref;
    const chunks=[new TextEncoder().encode(': provider keepalive\n\n'),frame('response.created',{}),frame('response.reasoning_text.delta',{delta:'PRIVATE_PROVIDER_REASONING'}),frame('response.completed',{response:complete(report(ref))})];let timer,index=0;
    return new Response(new ReadableStream({start(controller){timer=setInterval(()=>{controller.enqueue(chunks[index++]);if(index===chunks.length){clearInterval(timer);controller.close();}},100);},cancel(){clearInterval(timer);}}),{headers:{'content-type':'text/event-stream'}});
  }});
  const events=await collect(await handler(post({question:'检查数据',conversation})));assert.equal(calls,1);assert.equal(events.at(-1).type,'completed');assert.doesNotMatch(JSON.stringify(events),/PRIVATE_PROVIDER_REASONING|provider keepalive/);assert.doesNotMatch(JSON.stringify((await store.load(key(conversation))).value),/PRIVATE_PROVIDER_REASONING|provider keepalive/);
});

for(const mode of ['idle','hard'])test(`${mode} timeout cancels the provider body and saves a bounded resumable checkpoint`,async()=>{
  const store=createMemoryAgentStore(),conversation=fresh();let cancelled=0,calls=0,timer;
  const handler=createCoachHandler({sessionStore:store,loadSnapshot:async()=>snapshot(),getEnv:()=>env,executionWindow:{api_calls:1,tool_calls:24,timeout_ms:1000,provider_timeout_ms:mode==='hard'?90:400,provider_idle_timeout_ms:mode==='hard'?300:50},fetchImpl:async()=>{
    calls++;return new Response(new ReadableStream({start(controller){if(mode==='hard')timer=setInterval(()=>controller.enqueue(new TextEncoder().encode(': active\n\n')),20);},cancel(){cancelled++;clearInterval(timer);}}),{headers:{'content-type':'text/event-stream'}});
  }});
  try{const events=await collect(await handler(post({question:'检查数据',conversation}))),paused=events.at(-1);assert.equal(paused.type,'paused');assert.equal(paused.payload.task.pause_reason,'provider_timeout');assert.equal(paused.payload.session.can_resume,true);assert.equal(calls,1);assert.equal(cancelled,1);const saved=(await store.load(key(conversation))).value.turn;assert.equal(saved.status,'awaiting_continuation');assert.equal(saved.progress.model_calls,1);assert.equal(saved.lease_until,0);assert.equal(saved.result,null);}finally{clearInterval(timer);}
});

test('caller cancellation aborts a long provider response and retains its existing checkpoint',async()=>{
  const store=createMemoryAgentStore(),conversation=fresh(),abort=new AbortController();let markStarted,cancelled=0;const started=new Promise(resolve=>{markStarted=resolve;});
  const handler=createCoachHandler({sessionStore:store,loadSnapshot:async()=>snapshot(),getEnv:()=>env,fetchImpl:async()=>{markStarted();return new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});}});
  const reading=collect(await handler(post({question:'检查数据',conversation},abort.signal)));await started;abort.abort();await reading;
  const saved=(await store.load(key(conversation))).value.turn;assert.equal(saved.status,'awaiting_continuation');assert.equal(saved.pause_reason,'request_interrupted');assert.equal(saved.progress.model_calls,1);assert.equal(saved.lease_until,0);assert.ok(saved.work.queries.length);assert.equal(cancelled,1);
});

test('provider lease reservation excludes a competing resume beyond the ordinary lease and stale CAS writers cannot extend it',async()=>{
  const store=createMemoryAgentStore();let stamp=Date.parse(source.generated_at);const now=()=>stamp,runtime=createAgentRuntime({owner,store,now}),current=await runtime.begin({question:'检查数据',source});
  const stale=await store.load(key({id:current.record.id}));await current.reserveProviderLease(630000);stamp+=200000;
  const contender=createAgentRuntime({owner,store,now}),conversation={id:current.record.id,turn_id:current.turn.id,action:'resume'};
  assert.equal((await contender.read(conversation.id,source)).session.can_resume,false);await assert.rejects(contender.begin({conversation,source}),error=>error.code==='analysis_in_progress');
  const old=structuredClone(stale.value);old.turn.lease_until=stamp+630000;assert.equal(await store.write(key(conversation),old,stale.etag),null);
  for(const duration of [0,-1,630001,NaN,Infinity])await assert.rejects(current.reserveProviderLease(duration),error=>error.code==='invalid_provider_lease');
  await current.checkpoint(current.turn.work);assert.equal(current.turn.lease_until,stamp+150000,'A finished response restores the short lease');
});

test('browser watchdog permits a long server call past 150 seconds and explicit cancellation still works',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let postSignal,calls=0;
  const session=createCoachSession({storage:null,fetchImpl:async(url,options={})=>{
    if(options.method==='POST'){calls++;postSignal=options.signal;return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});}
    return Response.json(coachStatus(env));
  }});
  try{const running=session.run({question:'检查数据'});await waitFor(()=>postSignal);t.mock.timers.tick(150001);await immediate();assert.equal(postSignal.aborted,false);assert.equal(calls,1);session.cancel();await running;assert.equal(postSignal.aborted,true);assert.equal(session.getState().busy,false);}finally{session.destroy();t.mock.timers.reset();}
});
