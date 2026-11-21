import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const app=await fs.readFile(new URL('../ui/app.js',import.meta.url),'utf8');
const source=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end));
const {syncRunContent,describeSyncJob}=vm.runInNewContext(
  source('const $ =','const weaponNames =')+
  source('const jobStatus=','function showSyncProgress')+
  '\n({syncRunContent,describeSyncJob})',
);

const run={id:'101',status:'in_progress',created_at:'2026-11-21T14:00:00Z'};
const phase={id:'process',label:'下载和解析录像',state:'in_progress',started_at:'2026-11-21T14:03:00Z'};

test('the batch bar counts only confirmed attempts and deferrals with a known denominator',()=>{
  const activity={status:'in_progress',run,progress:{run_id:run.id,steps:[phase],demo:{
    attempted_this_run:2,completed_this_run:1,deferred_this_run:1,selected_this_run:8,
    status_counts:{pending:4,retry:2,unavailable:1,blocked_auth:0},last_run_at:'2026-11-21T14:05:00Z',
  }}};
  const markup=syncRunContent(activity);
  assert.match(markup,/aria-valuenow="3" aria-valuemin="0" aria-valuemax="8"/);
  assert.match(markup,/aria-current="step"[^>]*>.*下载和解析录像/);
  assert.match(markup,/<dt>已解析<\/dt><dd>1<\/dd>/);
  assert.match(markup,/任务队列 · <time/);
  assert.match(markup,/<dt>待重试<\/dt><dd>2<\/dd>/);
  assert.doesNotMatch(markup,/is-indeterminate/);
  const matchingSnapshot={status_counts:activity.progress.demo.status_counts};
  assert.doesNotMatch(syncRunContent(activity,matchingSnapshot),/任务队列/);
  assert.match(syncRunContent(activity,matchingSnapshot,{dialog:true}),/任务队列/);
});

test('new and uncorrelated runs never inherit an older result or fabricate a percentage',()=>{
  const saved={run_outcome:'waiting_for_replays',attempted_this_run:5,completed_this_run:0};
  const idle=syncRunContent({status:'idle',source:'background'},saved);
  assert.match(idle,/上次同步 · 等待录像/);

  const starting=syncRunContent({status:'queued'},saved);
  assert.match(starting,/任务已排队/);
  assert.match(starting,/is-indeterminate/);
  assert.doesNotMatch(starting,/aria-valuenow|上次同步 · 等待录像|已尝试/);

  const unrelated=syncRunContent({status:'in_progress',run,progress:{
    run_id:'100',steps:[phase],demo:{attempted_this_run:5,selected_this_run:5},
  }});
  assert.match(unrelated,/is-indeterminate/);
  assert.doesNotMatch(unrelated,/aria-valuenow|下载和解析录像/);
});

test('publication shows real shard counts and preserves a non-successful Demo result',()=>{
  const publishing=syncRunContent({status:'publishing',run,publication:{status:'publishing',staged_count:9,total_shards:14}});
  assert.match(publishing,/aria-valuenow="9" aria-valuemin="0" aria-valuemax="14"/);
  const terminal={status:'completed',run:{...run,status:'completed',conclusion:'success',url:'https://github.com/example/private/actions/runs/101'},progress_stale:true,progress:{
    run_id:run.id,steps:[{...phase,state:'completed'}],demo:{run_outcome:'waiting_for_replays',attempted_this_run:4,completed_this_run:0},
  }};
  const markup=syncRunContent(terminal,null,{dialog:true});
  assert.match(markup,/<h3>等待录像<\/h3>/);
  assert.match(markup,/同步状态暂未更新/);
  assert.match(markup,/<dt>已解析<\/dt><dd>0<\/dd>/);
  assert.match(markup,/href="https:\/\/github\.com\/example\/private\/actions\/runs\/101"/);
  assert.doesNotMatch(markup,/aria-valuenow|同步已完成/);
});

test('queued, backoff, due, unavailable and authentication rows have separate labels',()=>{
  const past=Date.parse('2026-11-21T14:00:00Z');
  const future='2026-11-21T14:30:00Z';
  assert.equal(describeSyncJob({status:'pending'},past).label,'排队中');
  assert.equal(describeSyncJob({status:'retry',next_attempt_at:future},past).label,'等待重试');
  assert.equal(describeSyncJob({status:'retry',next_attempt_at:future},past+3600000).label,'可在下轮重试');
  assert.equal(describeSyncJob({status:'unavailable',last_error_code:'http_404',next_attempt_at:future},past).label,'等待录像');
  assert.equal(describeSyncJob({status:'retry',last_error_code:'steam_playing_elsewhere'},past).label,'Steam 会话暂缓');
  assert.equal(describeSyncJob({status:'blocked_auth',last_error_code:'steam_refresh_token_expired'},past).detail,'Steam 登录已过期');
});
