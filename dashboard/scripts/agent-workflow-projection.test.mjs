import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCoachTaskState,prepareCoachWorkflow,coachTaskStateHtml} from '../ui/coach.js';
import {createAgentRuntime,createMemoryAgentStore} from '../worker/agent-runtime.mjs';

const state=()=>({id:crypto.randomUUID(),status:'running',plan_revision:4,checkpoint:{generation:2},workflow:{version:1,revision:4,generation:2,state:'running',operations:{running:0,completed:3,failed:1,interrupted:1,retention:'recent'},ignored:'PRIVATE',edges:[{from:'PRIVATE'}]}});

test('task preparation preserves only source-generation matched server workflow operation counters',()=>{
  const task=state(),prepared=prepareCoachTaskState(task);
  assert.deepEqual(prepared.workflow,{version:1,revision:4,generation:2,state:'running',operations:{running:0,completed:3,failed:1,interrupted:1,retention:'recent'}});
  assert.doesNotMatch(JSON.stringify(prepared),/PRIVATE|ignored|edges/);
  for(const change of [{state:'completed'},{revision:3},{generation:1},{version:2}])assert.equal(prepareCoachTaskState({...task,workflow:{...task.workflow,...change}}).workflow,null);
});

test('invalid operation snapshots cannot introduce fake running state or invoke accessors',()=>{
  const task=state();let accessed=false;
  for(const operations of [
    {...task.workflow.operations,running:-1},{...task.workflow.operations,running:'1'},
    {...task.workflow.operations,completed:161},{...task.workflow.operations,completed:160},
    {...task.workflow.operations,retention:'all'}, {...task.workflow.operations,unexpected:'PRIVATE'},
    {running:0,completed:0,failed:0,retention:'complete'},
    Object.defineProperty({...task.workflow.operations},'running',{enumerable:true,get(){accessed=true;return 1;}}),
  ])assert.equal(prepareCoachWorkflow({...task.workflow,operations},task),null);
  assert.equal(accessed,false);
  assert.equal(prepareCoachWorkflow({...task.workflow,state:'awaiting_continuation',operations:{...task.workflow.operations,running:1}},{...task,status:'awaiting_continuation'}),null);
});

test('paused and resumed real runtime snapshots do not relabel a previous-window started tool as running',async()=>{
  const runtime=createAgentRuntime({owner:'76561198000000000',store:createMemoryAgentStore()}),source={source_revision:'a'.repeat(40),generated_at:'2026-11-05T00:00:00Z',content_sha256:'b'.repeat(64)};
  const session=await runtime.begin({question:'核对读取状态',context:{view:'coach'},task:{mode:'diagnose'},source});
  await session.activity({kind:'tool',name:'read_rounds',call_id:'old',attempt:1,status:'started'});
  await session.pause();const paused=await runtime.read(session.record.id),html=value=>coachTaskStateHtml({task:value.task,conversation:value.session,busy:false});
  assert.equal(prepareCoachTaskState(paused.task).workflow.operations.interrupted,1);
  assert.match(html(paused),/运行中 0/);assert.match(html(paused),/中断 1/);
  const resumed=await runtime.begin({question:session.turn.question,context:session.turn.context,task:session.turn.task,source,conversation:{id:session.record.id,turn_id:session.turn.id,action:'resume'}});
  assert.match(html(resumed.public()),/运行中 0/);assert.match(html(resumed.public()),/中断 1/);
  await resumed.activity({kind:'tool',name:'read_rounds',call_id:'new',attempt:2,status:'started'});
  const live=prepareCoachTaskState(resumed.public().task);assert.equal(live.workflow.operations.running,1);assert.equal(live.workflow.operations.interrupted,1);
  assert.match(html(resumed.public()),/运行中 1/);
});
