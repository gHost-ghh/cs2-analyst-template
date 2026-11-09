import test from 'node:test';
import assert from 'node:assert/strict';
import {projectAgentWorkflow,renderAgentWorkflow} from '../ui/agent-workflow.js';

test('parallel dependency lanes retain actual completion and do not predict elapsed-time progress',()=>{
  const task={plan_revision:4,plan:[
    {id:'scope',label:'核对范围',status:'complete',depends_on:[]},
    {id:'aim',label:'定位分析',status:'active',depends_on:['scope']},
    {id:'trade',label:'协同分析',status:'pending',readiness:'ready',depends_on:['scope']},
    {id:'report',label:'提交结果',status:'pending',readiness:'blocked',depends_on:['aim','trade']},
  ]};
  const projected=projectAgentWorkflow(task);
  assert.deepEqual(projected.lanes.map(lane=>lane.steps.map(step=>step.id)),[['scope'],['aim','trade'],['report']]);
  assert.deepEqual(projected.totals,{complete:1,active:1,ready:1,waiting:1,retired:0});
  assert.equal(projected.lanes[2].steps[0].display,'blocked');
  const html=renderAgentWorkflow(task);assert.match(html,/1 \/ 4 已完成/);assert.match(html,/aria-label="任务依赖路线"/);assert.doesNotMatch(html,/%|progressbar|animation/);
});

test('missing or cyclic dependencies are visible unresolved lanes and never become executable',()=>{
  const projected=projectAgentWorkflow({plan:[
    {id:'a',status:'pending',readiness:'ready',depends_on:['b']},
    {id:'b',status:'pending',readiness:'ready',depends_on:['a']},
    {id:'c',status:'pending',readiness:'ready',depends_on:['missing']},
  ]});
  assert.equal(projected.lanes.length,1);assert.equal(projected.lanes[0].depth,null);
  assert.equal(projected.totals.ready,0);assert.equal(projected.totals.waiting,3);
  assert.equal(projected.lanes[0].steps[2].dependencies[0].missing,true);
  assert.match(renderAgentWorkflow({plan:[{id:'c',label:'C',depends_on:['missing']}]}),/未知依赖/);
});

test('retry availability and deferred tasks stay distinct from completion',()=>{
  const projected=projectAgentWorkflow({plan:[
    {id:'failed-read',status:'blocked',readiness:'ready',depends_on:[]},
    {id:'later',status:'deferred',depends_on:[]},
    {id:'unused',status:'cancelled',depends_on:[]},
    {id:'child',status:'pending',readiness:'ready',depends_on:['later']},
  ]});
  assert.equal(projected.lanes[0].steps[0].display,'retry');
  assert.equal(projected.totals.complete,0);assert.equal(projected.totals.retired,2);
  assert.equal(projected.lanes[1].steps[0].display,'blocked');
});

test('tool summary settles duplicate lifecycle records by attempt and marks partial history',()=>{
  const projected=projectAgentWorkflow({activity_truncated:true,plan:[{id:'read',label:'读取',status:'active'}],activity:[
    {kind:'tool',attempt:1,call_id:'one',status:'started'},
    {kind:'tool',attempt:1,call_id:'one',status:'completed'},
    {kind:'tool',attempt:2,call_id:'one',status:'failed'},
    {kind:'tool',attempt:2,call_id:'two',status:'started'},
    {kind:'commentary',attempt:2,call_id:'invented',status:'completed'},
  ]});
  assert.deepEqual(projected.recentTools,{active:0,complete:1,failed:1,interrupted:1});assert.equal(projected.toolHistoryPartial,true);
  const html=renderAgentWorkflow({activity_truncated:true,plan:[{id:'read',label:'读取',status:'active'}],activity:[{kind:'tool',attempt:1,call_id:'one',status:'completed'}]});
  assert.match(html,/近期工具 · 运行中 0 · 已返回 1 · 未取得结果 0 · 中断 0 · 较早记录已省略/);
});

test('server operations preserve interrupted calls across pause and resume without reviving stale starts',()=>{
  const task={id:'same-turn',plan:[{id:'read',label:'读取',status:'active'}],activity:[{kind:'tool',attempt:1,call_id:'old',status:'started'}],workflow:{operations:{running:0,completed:2,failed:1,interrupted:1,retention:'complete'}}};
  for(const status of ['awaiting_continuation','running']){
    const view=projectAgentWorkflow({...task,status});
    assert.deepEqual(view.recentTools,{active:0,complete:2,failed:1,interrupted:1});assert.equal(view.toolHistoryPartial,false);
    assert.match(renderAgentWorkflow({...task,status}),/运行中 0 · 已返回 2 · 未取得结果 1 · 中断 1/);
  }
  const live=projectAgentWorkflow({...task,status:'running',workflow:{operations:{running:1,completed:2,failed:1,interrupted:1,retention:'recent'}}});
  assert.deepEqual(live.recentTools,{active:1,complete:2,failed:1,interrupted:1});assert.equal(live.toolHistoryPartial,true);
});

test('legacy activity cannot claim live execution without a window epoch even when the task resumes',()=>{
  const task={activity:[{kind:'tool',attempt:1,call_id:'interrupted-call',status:'started'}]};
  for(const status of ['awaiting_continuation','running','completed','failed'])assert.deepEqual(projectAgentWorkflow({...task,status}).recentTools,{active:0,complete:0,failed:0,interrupted:1});
});

test('malformed or inconsistent server operations fall back to bounded settled activity',()=>{
  const task={status:'awaiting_continuation',activity_truncated:true,activity:[{kind:'tool',attempt:1,call_id:'old',status:'started'},{kind:'tool',attempt:1,call_id:'done',status:'completed'}]},valid={running:0,completed:3,failed:0,interrupted:0,retention:'complete'};
  const accessor={...valid};Object.defineProperty(accessor,'running',{get(){throw Error('must not evaluate accessors');},enumerable:true});
  for(const operations of [null,{...valid,running:1},{...valid,completed:'3'},{...valid,failed:-1},{...valid,interrupted:1.5},{...valid,completed:161},{...valid,completed:100,failed:100},{...valid,retention:'all'},{...valid,extra:true},accessor]){
    const view=projectAgentWorkflow({...task,workflow:{operations}});
    assert.deepEqual(view.recentTools,{active:0,complete:1,failed:0,interrupted:1});assert.equal(view.toolHistoryPartial,true);
  }
});

test('text-only rendering escapes model labels and handles empty/duplicate plans without invalid counters',()=>{
  assert.equal(renderAgentWorkflow(null),'');
  const task={plan:[{id:'a',label:'<img src=x onerror=alert(1)>',detail:'<script>bad()</script>',status:'<bad>'},{id:'a',label:'duplicate',status:'complete'}]};
  const html=renderAgentWorkflow(task);assert.doesNotMatch(html,/<img|<script|duplicate|<bad>/);assert.match(html,/&lt;img/);assert.match(html,/0 \/ 1 已完成/);
});
