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
const get=parameters=>new Request(`https://sync.test/api/sync?${parameters}`);

function fixture({run={},jobs,report,publications}={}) {
  const calls=[];
  const current={id:Number(runId),head_branch:SYNC_TARGET.ref,path:'.github/workflows/sync.yml',
    run_attempt:2,event:'workflow_dispatch',display_title:`CS2 Dashboard ${requestId}`,status:'in_progress',created_at:time,conclusion:null,...run};
  const handler=createSyncHandler({now:()=>now,onComplete:publications,fetcher:async(input,options)=>{
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
    assert.equal(url.pathname,`${repository}/actions/workflows/sync.yml/runs`);
    return Response.json({workflow_runs:[current]});
  }});
  return {calls,handler};
}

const step=(name,status='completed',conclusion='success',started_at=time,completed_at=next)=>({name,status,conclusion,started_at,completed_at});
const job=(steps=[],extra={})=>({name:'sync',run_id:Number(runId),run_attempt:2,steps,...extra});
const report=(extra={})=>({workflow_run_id:runId,workflow_run_attempt:2,run_outcome:'partial',last_run_at:next,...extra});

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
  for(const mismatch of [{workflow_run_id:'222333444'},{workflow_run_attempt:1},{workflow_run_attempt:null}]){
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
