import test from 'node:test';
import assert from 'node:assert/strict';
import {mountSync} from '../ui/sync.js';

const runId='38101234567';
const timestamp='2026-01-10T03:04:05.000Z';
const timing={started_at:timestamp,completed_at:null};
const run=(status='in_progress',id=runId)=>({id,status,created_at:timestamp,updated_at:timestamp,...(status==='completed'?{conclusion:'success'}:{})});
const progress=(demo,id=runId)=>({run_id:id,steps:[{id:'discover',state:'in_progress',...timing}],...(demo?{demo}:{})});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function harness(fetcher,{stored=new Map()}={}){
  const views=[],calls=[],tasks=new Map();
  let next=0,reloads=0;
  const makeButton=()=>({dataset:{},attrs:{},setAttribute(name,value){this.attrs[name]=value;},addEventListener(){},removeEventListener(){}});
  const button=makeButton(),resultButton=makeButton();
  const controller=mountSync({
    button,resultButton,showProgress:(view,options)=>views.push({view,...options}),reload:()=>{reloads++;},
    storage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    timers:{setTimeout(fn,delay){tasks.set(++next,{fn,delay});return next;},clearTimeout(id){tasks.delete(id);}},
    fetcher(url,options){calls.push({url,method:options.method||'GET'});return fetcher(url,options);},
  });
  return {
    controller,button,resultButton,calls,stored,tasks,views,get reloads(){return reloads;},get delay(){return tasks.values().next().value?.delay;},
    async tick(){
      const item=tasks.entries().next().value;
      assert.ok(item,'Expected one scheduled status read');
      tasks.delete(item[0]);item[1].fn();await flush();
    },
  };
}

test('Data Center observes a scheduled run read-only, polls less often after completion, and stops after closing',async()=>{
  const feed=[
    {status:'queued',run:run('queued')},
    {status:'in_progress',run:run(),progress:progress()},
    {status:'idle',latest_run:run('completed'),progress:progress({attempted_this_run:2,completed_this_run:0,run_outcome:'waiting_for_replays'})},
  ];
  const h=harness(async()=>Response.json(feed.shift()));
  assert.equal(h.calls.length,0);
  h.controller.watch(true);
  await h.tick();
  assert.equal(h.views.at(-1).view.status,'queued');
  assert.equal(h.button.dataset.syncState,'queued');
  assert.equal(h.button.attrs['aria-busy'],'true');
  await h.tick();
  assert.equal(h.views.at(-1).view.progress.steps[0].state,'in_progress');
  assert.equal(h.views.at(-1).view.progress.demo,undefined);
  h.controller.watch(false);
  assert.equal(h.tasks.size,0);assert.equal(h.button.disabled,false);
  h.controller.watch(true);
  await h.tick();
  assert.equal(h.views.at(-1).view.status,'completed');
  assert.equal(h.views.at(-1).view.progress.demo.completed_this_run,0);
  assert.equal(h.button.dataset.syncState,'waiting');
  assert.equal(h.reloads,0);
  assert.deepEqual(h.calls,Array.from({length:3},()=>({url:'/api/sync?detail=1',method:'GET'})));
  assert.equal(h.tasks.size,1);assert.equal(h.delay,50000);
  h.controller.watch(false);assert.equal(h.tasks.size,0);
  h.controller.dispose();
});

test('a manual sync keeps its tracked poll outside Data Center, exposes import counts and restores the result without replay',async()=>{
  const feed=[
    {status:'in_progress',run:run(),progress:progress({attempted_this_run:1,selected_this_run:2})},
    {status:'publishing',run:run('completed'),publication:{status:'publishing',staged_count:5,total_shards:12,token:'not retained'}},
    {status:'completed',run:run('completed'),publication:{status:'updated',match_count:18},progress:progress({attempted_this_run:2,completed_this_run:2,run_outcome:'ok'})},
  ];
  const h=harness(async(_url,options)=>options.method==='POST'
    ?Response.json({status:'dispatching',request_id:JSON.parse(options.body).request_id})
    :Response.json(feed.shift()));
  h.controller.watch(true);
  await h.controller.refresh();
  h.controller.watch(false);
  assert.match(h.calls[0].url,/^\/api\/sync$/);
  await h.tick();
  assert.equal(h.views.at(-1).view.source,'manual');
  assert.equal(h.views.at(-1).view.progress.demo.selected_this_run,2);
  assert.match(h.calls[1].url,/request_id=[^&]+&detail=1$/);
  await h.controller.review();
  assert.equal(h.views.at(-1).open,true);
  assert.equal(h.calls.length,2);
  await h.tick();
  assert.equal(h.views.at(-1).view.status,'publishing');
  assert.deepEqual(h.views.at(-1).view.publication,{status:'publishing',staged_count:5,total_shards:12});
  assert.equal(h.reloads,0);
  await h.tick();
  assert.equal(h.reloads,1);
  assert.equal(h.tasks.size,0);
  h.controller.dispose();
  const restored=harness(()=>assert.fail('Restoring and inspecting a result must stay local'),{stored:h.stored});
  await restored.controller.review();
  assert.equal(restored.views.at(-1).open,true);
  assert.equal(restored.views.at(-1).view.progress.demo.completed_this_run,2);
  assert.equal(restored.views.at(-1).view.publication.match_count,18);
  assert.equal(restored.calls.length,0);
  restored.controller.dispose();
});

test('cancelled background reads cannot override a new manual dispatch or leak a mismatched run receipt',async()=>{
  let resolveRead;
  const h=harness(async(_url,options)=>options.method==='POST'
    ?Response.json({status:'queued',request_id:JSON.parse(options.body).request_id,run:run('queued'),progress:progress({completed_this_run:20},'38101234568')})
    :new Promise(resolve=>{resolveRead=resolve;}));
  h.controller.watch(true);await h.tick();
  await h.controller.refresh();
  resolveRead(Response.json({status:'in_progress',run:run('in_progress','38101234568')}));
  await flush();
  assert.equal(h.views.at(-1).view.source,'manual');
  assert.equal(h.views.at(-1).view.run.id,runId);
  assert.equal(h.views.at(-1).view.progress,null);
  assert.equal(h.tasks.size,1);
  h.controller.dispose();
});

test('terminal manual results survive empty and older reads while background observation resumes without leaving the route',async()=>{
  const feed=[
    {status:'completed',run:run('completed'),progress:progress({run_outcome:'ok',completed_this_run:2}),publication:{status:'updated',match_count:18}},
    {status:'idle'},
    {status:'idle',latest_run:run('completed','38101234566'),progress:progress({completed_this_run:9},'38101234566')},
    {status:'idle',latest_run:run('completed')},
    {status:'in_progress',run:run('in_progress','38101234568')},
  ];
  const h=harness(async(_url,options)=>options.method==='POST'
    ?Response.json({status:'dispatching',request_id:JSON.parse(options.body).request_id})
    :Response.json(feed.shift()));
  h.controller.watch(true);
  await h.controller.refresh();
  await h.tick();
  assert.equal(h.views.at(-1).view.progress.demo.completed_this_run,2);
  assert.equal(h.delay,50000);
  for(let index=0;index<3;index++){
    await h.tick();
    const view=h.views.at(-1).view;
    assert.equal(view.run.id,runId);
    assert.equal(view.progress.demo.completed_this_run,2);
    assert.equal(view.publication.match_count,18);
    assert.equal(h.delay,50000);
  }
  assert.equal(h.views.at(-1).view.progress_stale,true);
  await h.tick();
  const active=h.views.at(-1).view;
  assert.equal(active.run.id,'38101234568');
  assert.equal(active.progress,null);
  assert.equal(active.publication,null);
  assert.equal(h.delay,15000);
  assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
  h.controller.dispose();
});

test('a rerun with the same GitHub ID does not inherit the previous attempt’s milestones',async()=>{
  const feed=[
    {status:'idle',latest_run:{...run('completed'),run_attempt:1},progress:progress({completed_this_run:4})},
    {status:'in_progress',run:{...run(),run_attempt:2}},
  ];
  const h=harness(async()=>Response.json(feed.shift()));
  h.controller.watch(true);
  await h.tick();
  assert.equal(h.views.at(-1).view.progress.demo.completed_this_run,4);
  await h.tick();
  const rerun=h.views.at(-1).view;
  assert.equal(rerun.run.id,runId);
  assert.equal(rerun.run.run_attempt,2);
  assert.equal(rerun.progress,null);
  assert.equal(rerun.progress_stale,undefined);
  h.controller.dispose();
});

test('an uncertain dispatch has inspectable feedback and polls the original UUID without a second POST',async()=>{
  let original;
  const h=harness(async(url,options)=>{
    if(options.method==='POST'){
      original=JSON.parse(options.body).request_id;
      throw new Error('private transport detail');
    }
    assert.equal(url,`/api/sync?request_id=${original}&detail=1`);
    return Response.json({status:'queued',request_id:original,run:run('queued')});
  });
  await h.controller.refresh();
  assert.equal(h.views.at(-1).view.status,'unknown');
  assert.equal(h.views.at(-1).view.read_error,'github_unavailable');
  assert.doesNotMatch(JSON.stringify(h.views.at(-1)),/private transport detail/);
  await h.tick();
  assert.equal(h.views.at(-1).view.status,'queued');
  assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
  h.controller.dispose();
});
