// A deterministic projection of the evidence-backed task graph. This module
// schedules no work and interprets no model text. In particular a ready step
// is permission to attempt an operation, never a claim it has been executed.
export function projectAgentWorkflow(turn={}){
  const plan=Array.isArray(turn.plan)?turn.plan:[],byId=new Map(plan.map(step=>[step.id,step])),depths=new Map(),visiting=new Set();
  function depth(id){
    if(depths.has(id))return depths.get(id);
    if(visiting.has(id))throw Error('task_plan_cycle');
    const step=byId.get(id);if(!step)throw Error('task_plan_dependency_missing');
    visiting.add(id);const dependencies=step.depends_on??[],value=dependencies.length?1+Math.max(...dependencies.map(depth)):0;visiting.delete(id);depths.set(id,value);return value;
  }
  const layers=[],edges=[];
  for(const step of plan){const value=depth(step.id);layers[value]??={depth:value,step_ids:[]};layers[value].step_ids.push(step.id);for(const id of step.depends_on??[])edges.push({from:id,to:step.id,satisfied:byId.get(id)?.status==='complete'});}
  const complete=step=>step.status==='complete',held=step=>['deferred','cancelled'].includes(step.status)||['deferred','cancelled'].includes(step.disposition);
  const ready=plan.filter(step=>!complete(step)&&!held(step)&&step.readiness==='ready'&&(step.depends_on??[]).every(id=>complete(byId.get(id))));
  const frontier={read_step_ids:[],validation_step_ids:[],presentation_step_ids:[]};
  for(const step of ready)frontier[step.operation==='validate_visual'?'validation_step_ids':step.operation==='present'?'presentation_step_ids':'read_step_ids'].push(step.id);
  const settled=new Map();
  for(const item of Array.isArray(turn.activity)?turn.activity:[]){if(item.kind!=='tool'||!Number.isSafeInteger(item.attempt)||typeof item.call_id!=='string'||!['started','completed','failed'].includes(item.status))continue;const sequence=Number(/:activity:(\d+)$/.exec(item.id??'')?.[1]);settled.set(`${item.attempt}:${item.call_id}`,{status:item.status,current:turn.window_activity_start==null||Number.isSafeInteger(sequence)&&sequence>turn.window_activity_start});}
  const status=Object.fromEntries(['running','completed','failed','interrupted'].map(key=>[key,0]));
  for(const value of settled.values())status[value.status==='started'?turn.status==='running'&&value.current?'running':'interrupted':value.status]++;
  const counts={total:plan.length,completed:plan.filter(complete).length,ready:ready.length,blocked:plan.filter(step=>!complete(step)&&!held(step)&&!ready.includes(step)).length,deferred:plan.filter(step=>step.status==='deferred').length,cancelled:plan.filter(step=>step.status==='cancelled').length};
  const waiting=plan.filter(step=>!complete(step)&&!held(step)).map(step=>({step_id:step.id,dependency_ids:(step.depends_on??[]).filter(id=>!complete(byId.get(id)))})).filter(step=>step.dependency_ids.length);
  return {version:1,revision:turn.plan_revision??0,generation:turn.generation??0,state:turn.status??'running',layers,edges,frontier,waiting,counts,operations:{...status,retention:turn.activity_truncated===true?'recent':'complete'},partial:turn.status==='completed'&&counts.completed<counts.total};
}
