import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentRuntime,createMemoryAgentStore} from '../worker/agent-runtime.mjs';
import {projectAgentWorkflow} from '../worker/agent-workflow.mjs';

const owner='76561198000000000',source={source_revision:'a'.repeat(40),generated_at:'2026-11-05T00:00:00Z',content_sha256:'b'.repeat(64)};
const step=(id,resources=['rounds'],depends_on=[],operation='read_data')=>({id,label:id,resources,operation,depends_on,scope:null});
const edit=(action,steps=[],step_id=null)=>({action,steps,step_id});
async function fixture(){
  let writes=0,fail=false;const backing=createMemoryAgentStore(),store={...backing,async write(...args){writes++;if(fail)return null;return backing.write(...args);}};
  const runtime=createAgentRuntime({owner,store}),session=await runtime.begin({question:'按依赖读取并核对证据。',context:{view:'coach'},task:{mode:'diagnose'},source});
  return {runtime,session,writes:()=>writes,fail:()=>{fail=true;}};
}

test('the complete unpaginated raw directory satisfies its task despite unused page-size differences',async()=>{
  const {session}=await fixture();await session.planTransaction({expected_revision:0,edits:[edit('set',[{...step('directory',['raw_schema']),scope:{offset:0,limit:25}},step('present',[],['directory'],'present')])]});
  await session.observed({resource:'raw_schema',offset:0,limit:20},'directory:actual');
  assert.equal(session.public().task.plan[0].status,'complete');assert.deepEqual(session.public().task.workflow.frontier.presentation_step_ids,['present']);
});
test('unpaginated catalog matching never broadens match-specific fields, raw rows or normal pages',async()=>{
  for(const [resource,scope,query] of [
    ['raw_schema',{match_id:'a'.repeat(24),raw_dataset:'owner_rounds',limit:25},{match_id:'a'.repeat(24),raw_dataset:'owner_rounds',limit:20}],
    ['raw_rows',{match_id:'a'.repeat(24),raw_dataset:'owner_rounds',limit:25},{match_id:'a'.repeat(24),raw_dataset:'owner_rounds',limit:20}],
    ['rounds',{limit:25},{limit:20}],
    ['raw_schema',{match_id:'a'.repeat(24)},{}],
  ]){const {session}=await fixture();await session.planTransaction({expected_revision:0,edits:[edit('set',[{...step('read',[resource]),scope}])]});await session.observed({resource,...query},'actual');assert.notEqual(session.public().task.plan[0].status,'complete');}
});

test('atomic graph edits allow forward dependencies, publish once and preserve independent ready frontier',async()=>{
  const {session,writes}=await fixture(),before=writes();
  const result=await session.planTransaction({expected_revision:0,edits:[edit('set',[step('rounds',['rounds'],['directory'])]),edit('append',[step('directory',['catalog']),step('shots',['shots'],['directory']),step('present',[],['rounds','shots'],'present')])]});
  assert.equal(writes()-before,1);assert.equal(result.edits_applied,2);assert.equal(result.plan_revision,1);assert.equal(result.plan_revisions.at(-1).action,'transaction');
  assert.deepEqual(result.workflow.layers,[{depth:0,step_ids:['directory']},{depth:1,step_ids:['rounds','shots']},{depth:2,step_ids:['present']}]);
  assert.deepEqual(result.workflow.frontier,{read_step_ids:['directory'],validation_step_ids:[],presentation_step_ids:[]});
  await session.observed({resource:'catalog'},'directory:1');
  const current=session.public().task;assert.deepEqual(current.workflow.frontier.read_step_ids,['rounds','shots']);assert.equal(current.workflow.counts.completed,1);assert.equal(current.workflow.counts.ready,2);
  assert.deepEqual(current.workflow.edges.filter(edge=>edge.satisfied).map(edge=>[edge.from,edge.to]),[['directory','rounds'],['directory','shots']]);
});

test('invalid or cyclic atomic edits publish nothing and leave exact prior task and plan revisions intact',async()=>{
  const {session,writes}=await fixture(),before=session.public().task,serial=writes();
  for(const edits of [
    [edit('set',[step('first',['rounds'])]),edit('append',[step('first',['shots'])])],
    [edit('set',[step('first',['rounds'],['second'])]),edit('append',[step('second',['shots'],['first'])])],
    [edit('set',[step('first',['rounds'],['missing'])])],
    [edit('set',[step('first',['rounds'])]),{action:'transaction',edits:[]}],
  ]){await assert.rejects(session.planTransaction({expected_revision:0,edits}));assert.deepEqual(session.public().task,before);assert.equal(writes(),serial);}
});

test('stale plan revisions reject atomically and cannot overwrite a newer plan',async()=>{
  const {session,writes}=await fixture();await session.plan(edit('set',[step('current',['rounds'])]));const before=session.public().task,serial=writes();
  await assert.rejects(session.planTransaction({expected_revision:0,edits:[edit('set',[step('stale',['shots'])])]}),error=>error.code==='task_plan_revision_conflict'&&error.status===409&&error.details.current_revision===1);
  assert.deepEqual(session.public().task,before);assert.equal(writes(),serial);
  const result=await session.planTransaction({expected_revision:1,edits:[edit('append',[step('next',['shots'])]),edit('activate',[],'next')]});assert.equal(result.plan_revision,2);assert.equal(result.plan.find(item=>item.id==='next').status,'active');assert.equal(result.workflow.counts.completed,0);
});

test('failed conditional publication restores controller turn identity, revision and complete task state',async()=>{
  const {session,fail}=await fixture(),turn=session.turn,before=session.public(),revision=session.record.revision;fail();
  await assert.rejects(session.planTransaction({expected_revision:0,edits:[edit('set',[step('changed',['rounds'])])]}),{code:'conversation_conflict'});
  assert.equal(session.turn,turn);assert.equal(session.record.turn,turn);assert.equal(session.record.revision,revision);assert.deepEqual(session.public(),before);
});

test('deferred or cancelled dependencies stay explicit and cannot fund readiness or completion',async()=>{
  const {session}=await fixture();const result=await session.planTransaction({expected_revision:0,edits:[edit('set',[step('read',['rounds']),step('verify',[],['read'],'validate_visual'),step('present',[],['verify'],'present')]),edit('defer',[],'read')]});
  assert.deepEqual(result.workflow.frontier,{read_step_ids:[],validation_step_ids:[],presentation_step_ids:[]});assert.equal(result.workflow.counts.deferred,1);assert.equal(result.workflow.counts.blocked,2);
  assert.deepEqual(result.workflow.waiting,[{step_id:'verify',dependency_ids:['read']},{step_id:'present',dependency_ids:['verify']}]);
  const completed=await session.complete({status:'complete',analysis:{headline:'有限结果',summary:'缺失项已列明',findings:[],training:[],limitations:['数据读取已暂缓']}});assert.equal(completed.task.workflow.partial,true);assert.equal(completed.task.workflow.counts.completed,0);assert.equal(completed.task.workflow.frontier.presentation_step_ids.length,0);
});

test('workflow projection counts settled real tool operations without copying payloads or simulating execution',()=>{
  const turn={status:'running',plan_revision:5,generation:2,plan:[{...step('read'),status:'active',readiness:'ready'}],activity:[{kind:'tool',attempt:1,call_id:'a',status:'started',secret:'PRIVATE'},{kind:'tool',attempt:1,call_id:'a',status:'completed'},{kind:'tool',attempt:2,call_id:'a',status:'started'},{kind:'tool',attempt:1,call_id:'b',status:'failed'},{kind:'phase',status:'started',attempt:2,call_id:'ignore'}]};
  const result=projectAgentWorkflow(turn);assert.deepEqual(result.operations,{running:1,completed:1,failed:1,interrupted:0,retention:'complete'});assert.equal(result.counts.completed,0);assert.equal(result.revision,5);assert.equal(result.generation,2);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret/);
  const paused=projectAgentWorkflow({...turn,status:'awaiting_continuation',activity_truncated:true});assert.deepEqual(paused.operations,{running:0,completed:1,failed:1,interrupted:1,retention:'recent'});
});

test('transaction input bounds and accessor fields reject before durable mutation',async()=>{
  const {session,writes}=await fixture(),before=writes();let accessed=false;
  for(const args of [null,{expected_revision:-1,edits:[]},{expected_revision:0,edits:[]},{expected_revision:0,edits:Array(7).fill(edit('set',[step('a')]))},{expected_revision:0,edits:[edit('set',[step('a')])],extra:true},Object.defineProperty({edits:[edit('set',[step('a')])]},'expected_revision',{enumerable:true,get(){accessed=true;return 0;}})])await assert.rejects(session.planTransaction(args),{code:'invalid_task_plan_transaction'});
  assert.equal(accessed,false);assert.equal(writes(),before);
});

test('durable workflow recovery does not relabel an interrupted prior-window tool as running',async()=>{
  const {runtime,session}=await fixture();await session.planTransaction({expected_revision:0,edits:[edit('set',[step('read',['rounds']),step('present',[],['read'],'present')])]});
  await session.activity({kind:'tool',name:'read_rounds',attempt:1,call_id:'old',status:'started'});assert.equal(session.public().task.workflow.operations.running,1);
  await session.pause();const paused=await runtime.read(session.record.id);assert.equal(paused.task.workflow.operations.interrupted,1);
  const resumed=await runtime.begin({question:session.turn.question,context:session.turn.context,task:session.turn.task,source,conversation:{id:session.record.id,turn_id:session.turn.id,action:'resume'}});
  assert.equal(resumed.public().task.workflow.operations.running,0);assert.equal(resumed.public().task.workflow.operations.interrupted,1);assert.equal(resumed.public().task.workflow.revision,1);
  await resumed.activity({kind:'tool',name:'read_rounds',attempt:2,call_id:'new',status:'started'});assert.equal(resumed.public().task.workflow.operations.running,1);
  await resumed.activity({kind:'tool',name:'read_rounds',attempt:2,call_id:'new',status:'completed'});const saved=await runtime.read(session.record.id);assert.deepEqual(saved.task.workflow.operations,{running:0,completed:1,failed:0,interrupted:1,retention:'complete'});
});

test('a changed source rebuilds the frontier and invalidates completed evidence while preserving graph revision history',async()=>{
  const {runtime,session}=await fixture();await session.planTransaction({expected_revision:0,edits:[edit('set',[step('read',['rounds']),step('present',[],['read'],'present')])]});
  await session.observed({resource:'rounds'},'rounds:old');await session.pause();const old=session.public().task;assert.deepEqual(old.workflow.frontier.presentation_step_ids,['present']);
  const changed=await runtime.begin({question:session.turn.question,context:session.turn.context,task:session.turn.task,source:{...source,source_revision:'c'.repeat(40)},conversation:{id:session.record.id,turn_id:session.turn.id,action:'resume'}}),current=changed.public().task;
  assert.equal(current.workflow.generation,1);assert.equal(current.workflow.counts.completed,0);assert.deepEqual(current.workflow.frontier.read_step_ids,['read']);assert.deepEqual(current.workflow.frontier.presentation_step_ids,[]);assert.equal(current.plan_revisions.at(-1).action,'source_changed');
  assert.equal(old.workflow.counts.completed,1);
});
