import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncHandler,SYNC_TARGET} from '../worker/sync.mjs';

const runId='123456789';
const requestId='555b627b-a26f-4981-a2af-a94e13095571';
const token='backend-fixture-only';
const time='2026-11-02T12:00:00Z';
const next='2026-11-02T12:01:00Z';
const now=Date.parse(next);
const env={GITHUB_ACTIONS_TOKEN:token};
const repository=`/repos/${SYNC_TARGET.owner}/${SYNC_TARGET.repo}`;
const runPath=`${repository}/actions/runs/${runId}`;
const jobsPath=`${runPath}/attempts/2/jobs`;
const demoPath=`${repository}/contents/reports/demo_status.json`;
const livePath=`${repository}/contents/demo-sync-progress.json`;
const get=parameters=>new Request(`https://sync.test/api/sync?${parameters}`);

function fixture({run={},ahead=[],jobs,report,live,publications,observedAt=now}={}) {
  const calls=[];
  const current={id:Number(runId),head_branch:SYNC_TARGET.ref,path:'.github/workflows/sync.yml',
    run_attempt:2,event:'workflow_dispatch',display_title:`CS2 Dashboard ${requestId}`,status:'in_progress',created_at:time,conclusion:null,...run};
  const handler=createSyncHandler({now:()=>observedAt,onComplete:publications,fetcher:async(input,options)=>{
    const url=new URL(input);
    calls.push(url);
    assert.equal(url.origin,'https://api.github.com');
    assert.equal(options.headers.Authorization,`Bearer ${token}`);
    assert.equal(options.redirect,'manual');
    assert.equal(options.method,undefined);
    if(url.pathname===runPath)return Response.json(current);
    if(url.pathname===jobsPath){
      assert.equal(url.searchParams.get('per_page'),'10');
      return jobs instanceof Response?jobs:Response.json({jobs:jobs??[]});
    }
    if(url.pathname===demoPath){
      assert.equal(url.searchParams.get('ref'),SYNC_TARGET.ref);
      assert.equal(options.headers.Accept,'application/vnd.github.raw+json');
      return report instanceof Response?report:Response.json(report??{});
    }
    if(url.pathname===livePath){
      assert.equal(url.searchParams.get('ref'),'cs2-sync-progress');
      assert.equal(options.headers.Accept,'application/vnd.github.raw+json');
      return live instanceof Response?live:Response.json(live??{});
    }
    assert.equal(url.pathname,`${repository}/actions/workflows/sync.yml/runs`);
    return Response.json({workflow_runs:[...ahead.map(value=>({...current,...value})),current]});
  }});
  return {calls,handler};
}

const step=(name,status='completed',conclusion='success',started_at=time,completed_at=next)=>({name,status,conclusion,started_at,completed_at});
const job=(steps=[],extra={})=>({name:'sync',run_id:Number(runId),run_attempt:2,steps,...extra});
const report=(extra={})=>({workflow_run_id:runId,workflow_run_attempt:2,run_outcome:'partial',last_run_at:next,...extra});
const live=(extra={})=>({schema_version:1,workflow_run_id:runId,workflow_run_attempt:2,sequence:4,updated_at:next,phase:'downloading',...extra});
const privateRun={repository:{private:true},run_started_at:time};
const firstJob='eefa123456789aabbccdde00';

test('detailed status returns observed stages and the exact run attempt’s settled checkpoint',async()=>{
  const {handler,calls}=fixture({jobs:[job([step('Install replay worker')],{run_attempt:1}),job([
    step('Set up job'),step('Run actions/setup-node@v12','in_progress',null,next,null),
    step('Install replay worker','pending',null,null,null),
    step('Sync Steam codes and Leetify stats','pending',null,null,null),
    step('Download, parse and analyze Demo jobs','pending',null,null,null),
    step('private job input', 'in_progress', null, time, null),
  ])],report:report({selected_this_run:6,attempted_this_run:4,completed_this_run:3,deferred_this_run:1,
    gc_discovery_status:'discovered',status_counts:{complete:33,unavailable:1,other:'private report text'},download_url:'https://private.invalid'})});
  const response=await handler(get(`run_id=${runId}&detail=1`),env);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const result=await response.json();
  assert.equal(result.run.id,runId);
  assert.equal(result.progress.run_id,runId);
  assert.deepEqual(result.progress.steps.map(({id,state,started_at,completed_at})=>[id,state,started_at,completed_at]),[
    ['prepare','in_progress','2026-11-02T12:00:00.000Z',null],['discover','queued',null,null],['process','queued',null,null],
  ]);
  assert.deepEqual(result.progress.demo,{run_outcome:'partial',last_run_at:'2026-11-02T12:01:00.000Z',
    attempted_this_run:4,completed_this_run:3,deferred_this_run:1,selected_this_run:6,gc_discovery_status:'discovered',status_counts:{complete:33,unavailable:1}});
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(new Set(calls.map(url=>url.pathname)),new Set([runPath,jobsPath,demoPath]));
});

test('latest detailed read is read-only even when a successful run could trigger publication',async()=>{
  const {handler}=fixture({run:{status:'completed',conclusion:'success'},
    jobs:[job([step('Refresh the private Netlify snapshot','completed','skipped',null,null),
      step('Propagate service errors after saving progress','completed','success')])],
    publications:()=>assert.fail('An unscoped latest read cannot publish'),report:report({run_outcome:'ok'})});
  const result=await(await handler(get('detail=1'),env)).json();
  assert.equal(result.status,'idle');
  assert.equal(result.latest_run.id,runId);
  assert.equal(result.progress.demo.run_outcome,'ok');
  assert.deepEqual(result.progress.steps.map(({id,state})=>[id,state]),[['publish','skipped'],['finish','completed']]);
});

test('other runs, earlier attempts and reports without attempt identity cannot supply Demo counts',async()=>{
  for(const mismatch of [{workflow_run_id:'222333444'},{workflow_run_attempt:1},{workflow_run_attempt:null},
    {last_run_at:'2026-11-02T11:58:00Z'},{last_run_at:'2026-11-02T12:03:00Z'}]){
    const {handler}=fixture({jobs:[job([step('Download, parse and analyze Demo jobs')],{run_attempt:1}),
      job([step('Download, parse and analyze Demo jobs')],{run_id:222333444})],report:report(mismatch)});
    const result=await(await handler(get(`request_id=${requestId}&detail=1`),env)).json();
    assert.deepEqual(result.progress,{run_id:runId,steps:[]});
    assert.equal(result.status,'in_progress');
  }
});

test('malformed optional values cannot manufacture totals, error labels, or successful phases',async()=>{
  const {handler}=fixture({jobs:[job([
    step('Download, parse and analyze Demo jobs','completed','failure','not a date'),
    step('Add Demo worker report to run summary','completed','unknown-conclusion'),
  ])],report:report({attempted_this_run:7,completed_this_run:11,deferred_this_run:2,selected_this_run:8,
    status_counts:{complete:-1,unavailable:3,pending:'21'},gc_discovery_error_code:'custom_internal_token'})});
  const result=await(await handler(get(`run_id=${runId}&detail=1`),env)).json();
  assert.deepEqual(result.progress.steps.map(({id,state,started_at})=>[id,state,started_at]),[['process','failed',null]]);
  assert.deepEqual(result.progress.demo,{run_outcome:'partial',last_run_at:'2026-11-02T12:01:00.000Z',
    attempted_this_run:7,deferred_this_run:2,status_counts:{unavailable:3}});
});

test('unavailable optional details leave scoped completion and publication behavior intact',async()=>{
  let publications=0,cancelled=false;
  const {handler}=fixture({run:{status:'completed',conclusion:'success'},jobs:new Response(null,{status:403}),
    report:new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'20000'}}),
    publications:async()=>{publications++;return {status:'publishing'};}});
  const result=await(await handler(get(`run_id=${runId}&detail=1`),env)).json();
  assert.equal(publications,1);
  assert.equal(cancelled,true);
  assert.equal(result.status,'publishing');
  assert.deepEqual(result.progress,{run_id:runId,steps:[]});
});

test('details are opt-in and only use a run from the fixed workflow',async()=>{
  const {handler,calls}=fixture();
  assert.equal((await(await handler(get(`run_id=${runId}`),env)).json()).progress,undefined);
  assert.ok(calls.every(url=>url.pathname===runPath));
  calls.length=0;
  for(const invalid of ['detail=2','detail=1&detail=1','detail=',`run_id=${runId}&request_id=${requestId}&detail=1`,'run_id=&detail=1']){
    assert.equal((await handler(get(invalid),env)).status,400);
  }
  assert.deepEqual(calls,[]);
  const foreign=fixture({run:{path:'.github/workflows/other.yml'}});
  assert.equal((await foreign.handler(get(`run_id=${runId}&detail=1`),env)).status,404);
  assert.ok(foreign.calls.every(url=>url.pathname===runPath));
  const queued=fixture({run:{status:'queued'}});
  const result=await(await queued.handler(get(`run_id=${runId}&detail=1`),env)).json();
  assert.deepEqual(result.progress,{run_id:runId,steps:[]});
  assert.ok(queued.calls.every(url=>url.pathname===runPath));
});

test('the private live ledger exposes bounded progress and run-bound job result evidence',async()=>{
  const {handler,calls}=fixture({run:privateRun,live:live({job_id:firstJob,job_index:1,attempt:2,
    received_bytes:16*1024,total_bytes:32*1024,selected_this_run:3,attempted_this_run:1,
    completed_this_run:0,run_outcome:'ok',download_url:'https://private.invalid',recent:[
      {at:time,phase:'resolving',job_index:1},
      {at:next,phase:'parsing',parser_stage:'events',job_index:1,error_code:'parser_event_schema_events',secret:'private'},
      {at:time,phase:'saving'},
      {at:next,phase:'unknown_phase'},
    ]}),report:report({checkpoint_state:'processing',selected_this_run:3,job_results:[
      {job_id:firstJob,job_index:1,status:'retry',error_code:'http_404',retry_at:'2026-11-02T13:01:00Z',url:'https://private.invalid'},
      {job_id:'3fa34e123456789aabbccdde',job_index:3,status:'unavailable',error_code:'private_value',retry_at:'private data'},
      {job_id:'37ef123456789aabbccdde002',job_index:4,status:'verified'},
      {job_id:firstJob,job_index:1,status:'complete'},
    ]})});
  const result=await(await handler(get(`run_id=${runId}&detail=1`),env)).json();
  assert.deepEqual(result.progress.live,{
    schema_version:1,workflow_run_id:runId,workflow_run_attempt:2,sequence:4,updated_at:'2026-11-02T12:01:00.000Z',phase:'downloading',
    job_id:firstJob,job_index:1,attempt:2,received_bytes:16384,total_bytes:32768,selected_this_run:3,attempted_this_run:1,completed_this_run:0,recent:[
      {at:'2026-11-02T12:00:00.000Z',phase:'resolving',job_index:1},
      {at:'2026-11-02T12:01:00.000Z',phase:'parsing',parser_stage:'events',job_index:1,error_code:'parser_event_schema_events'},
    ],
  });
  assert.equal(result.progress.demo.checkpoint_state,'processing');
  assert.deepEqual(result.progress.demo.job_results,[
    {job_id:firstJob,job_index:1,status:'retry',error_code:'http_404',retry_at:'2026-11-02T13:01:00.000Z'},
    {job_id:'3fa34e123456789aabbccdde',job_index:3,status:'unavailable'},
  ]);
  assert.doesNotMatch(JSON.stringify(result),/private/);
  assert.equal(calls.filter(url=>url.pathname===livePath).length,1);
});

test('old, future and foreign ledgers cannot be mistaken for the latest attempt',async()=>{
  for(const overrides of [
    {schema_version:2}, {workflow_run_id:'999999999'}, {workflow_run_attempt:1}, {sequence:0},
    {updated_at:'2026-11-02T11:58:00Z'}, {updated_at:'2026-11-02T12:03:00Z'}, {phase:'not-a-phase'},
  ]){
    const {handler}=fixture({run:privateRun,live:live(overrides),report:report({checkpoint_state:'final'})});
    const {progress}=await(await handler(get(`run_id=${runId}&detail=1`),env)).json();
    assert.equal(progress.live,undefined);
    assert.equal(progress.demo.checkpoint_state,'final');
  }
  for(const run of [{repository:{private:false}}, {}, {...privateRun,status:'queued'}]){
    const {handler,calls}=fixture({run,live:live()});
    const {progress}=await(await handler(get(`run_id=${runId}&detail=1`),env)).json();
    assert.equal(progress.live,undefined);
    assert.ok(calls.every(url=>url.pathname!==livePath));
  }
});

test('stale observations remain historical and a finished ledger survives the active freshness window',async()=>{
  for(const [run,overrides,clock,stale] of [
    [privateRun,{},now+90001,true],
    [{...privateRun,status:'completed'}, {},now,true],
    [{...privateRun,status:'completed'}, {phase:'finished',run_outcome:'waiting_for_replays'},now+3600000,undefined],
  ]){
    const {handler}=fixture({run,live:live({received_bytes:200,total_bytes:100,...overrides}),observedAt:clock});
    const {progress}=await(await handler(get(`run_id=${runId}&detail=1`),env)).json();
    assert.equal(progress.live.stale,stale);
    assert.equal(progress.live.total_bytes,undefined);
    assert.equal(progress.live.run_outcome,overrides.run_outcome);
  }
});

test('the background view follows the executing run before a newer run waiting in line',async()=>{
  const {handler,calls}=fixture({run:privateRun,ahead:[{id:123456790,status:'queued'}],live:live()});
  const result=await(await handler(get('detail=1'),env)).json();
  assert.equal(result.status,'in_progress');
  assert.equal(result.run.id,runId);
  assert.equal(result.progress.live.workflow_run_id,runId);
  assert.ok(calls.some(url=>url.pathname===livePath));
});
