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
  assert.deepEqual(projected.recentTools,{active:1,complete:1,failed:1});assert.equal(projected.toolHistoryPartial,true);
  const html=renderAgentWorkflow({activity_truncated:true,plan:[{id:'read',label:'读取',status:'active'}],activity:[{kind:'tool',attempt:1,call_id:'one',status:'completed'}]});
  assert.match(html,/近期工具 · 运行中 0 · 已返回 1 · 未取得结果 0 · 较早记录已省略/);
});

test('text-only rendering escapes model labels and handles empty/duplicate plans without invalid counters',()=>{
  assert.equal(renderAgentWorkflow(null),'');
  const task={plan:[{id:'a',label:'<img src=x onerror=alert(1)>',detail:'<script>bad()</script>',status:'<bad>'},{id:'a',label:'duplicate',status:'complete'}]};
  const html=renderAgentWorkflow(task);assert.doesNotMatch(html,/<img|<script|duplicate|<bad>/);assert.match(html,/&lt;img/);assert.match(html,/0 \/ 1 已完成/);
});
