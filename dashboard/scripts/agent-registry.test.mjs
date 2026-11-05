import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentToolRegistry} from '../worker/agent-registry.mjs';
const tool=(name,capability='read')=>({name,capability,...(capability==='read'?{resource:'analysis'}:{}),definition:{type:'function',name,description:'Trusted definition',parameters:{type:'object',properties:{},required:[],additionalProperties:false},strict:true}});
const plugin=(id,tools,requires=[])=>({id,tools,requires});

test('registry composes trusted capabilities deterministically and limits presentation stage',()=>{
  const registry=createAgentToolRegistry();registry.register(plugin('data',[tool('read_rounds'),tool('read_statistics')]));registry.register(plugin('workflow',[tool('edit_plan','plan'),tool('publish_progress','progress')],['data']));registry.register(plugin('visuals',[tool('validate_visual','validate'),tool('present_report','present')],['data','workflow']));
  const read=registry.snapshot();assert.deepEqual(read.tools.map(item=>item.name),['read_rounds','read_statistics','edit_plan','publish_progress','validate_visual','present_report']);assert.deepEqual(read.capabilities.read,['read_rounds','read_statistics']);assert.deepEqual(read.plugins[2].requires,['data','workflow']);assert.equal(read.directory[0].plugin_id,'data');assert.equal(read.directory[0].resource,'analysis');
  const present=registry.snapshot({stage:'present'});assert.deepEqual(present.tools.map(item=>item.name),['present_report']);assert.deepEqual(present.capabilities.read,[]);assert.equal(present.directory[0].capability,'present');assert.throws(()=>registry.snapshot({stage:'anything'}),{code:'agent_registry_invalid'});
});

test('duplicate and unavailable dependency registrations are atomic and leave snapshots unchanged',()=>{
  const registry=createAgentToolRegistry();registry.register(plugin('data',[tool('existing')]));const before=registry.snapshot();
  for(const [value,code]of [[plugin('data',[tool('other')]),'agent_registry_duplicate_plugin'],[plugin('duplicate',[tool('new_one'),tool('existing')]),'agent_registry_duplicate_tool'],[plugin('internal',[tool('twice'),tool('twice')]),'agent_registry_duplicate_tool'],[plugin('dependent',[tool('new_one')],['missing']),'agent_registry_dependency_missing']]){assert.throws(()=>registry.register(value),{code});assert.deepEqual(registry.snapshot(),before);}
  registry.register(plugin('allowed',[tool('new_one')]));assert.equal(registry.snapshot().tools.length,2);
});

test('registrations unwind dependents first and stale disposal cannot remove a replacement',()=>{
  const registry=createAgentToolRegistry(),data=registry.register(plugin('data',[tool('read_data')])),child=registry.register(plugin('child',[tool('format_report','present')],['data']));
  assert.throws(()=>data.dispose(),{code:'agent_registry_plugin_in_use'});assert.equal(registry.snapshot().tools.length,2);assert.equal(child.dispose(),true);assert.equal(data.dispose(),true);assert.equal(data.dispose(),false);const replacement=registry.register(plugin('data',[tool('new_data')]));assert.equal(data.dispose(),false);assert.deepEqual(registry.snapshot().tools.map(item=>item.name),['new_data']);assert.equal(replacement.dispose(),true);
});

test('frozen snapshots and cloned registrations cannot be mutated through retained references',()=>{
  const registry=createAgentToolRegistry(),declaration=plugin('data',[tool('read_data')]);registry.register(declaration);declaration.tools[0].definition.description='changed';declaration.requires.push('missing');
  const snapshot=registry.snapshot();assert.equal(snapshot.tools[0].description,'Trusted definition');assert.deepEqual(snapshot.plugins[0].requires,[]);assert.equal(Object.isFrozen(snapshot.tools[0].parameters.properties),true);assert.throws(()=>snapshot.tools.push({}),TypeError);assert.throws(()=>snapshot.plugins[0].requires.push('bad'),TypeError);assert.notEqual(snapshot,registry.snapshot());
});

test('registry rejects executable or secret-bearing declarations and never invokes getters',()=>{
  const registry=createAgentToolRegistry();let reads=0;const getter={id:'unsafe',get tools(){reads++;return [];}};
  const invalid=[getter,plugin('unsafe',[{...tool('read_data'),handler(){}}]),plugin('unsafe',[{...tool('read_data'),definition:{...tool('read_data').definition,token:'private'}}]),plugin('unsafe',[{...tool('read_data'),definition:{...tool('read_data').definition,parameters:{type:'object',properties:{api_key:{type:'string'}}}}}]),plugin('unsafe',[{...tool('read_data'),capability:'execute'}]),plugin('unsafe',[{...tool('read_data'),definition:{...tool('other').definition}}]),plugin('unsafe',[],['unsafe'])];
  for(const value of invalid)assert.throws(()=>registry.register(value),{code:'agent_registry_invalid'});assert.equal(reads,0);assert.deepEqual(registry.snapshot().tools,[]);
  const nested=tool('nested');Object.defineProperty(nested.definition.parameters,'x',{enumerable:true,get(){reads++;return 1;}});assert.throws(()=>registry.register(plugin('getter',[nested])),{code:'agent_registry_invalid'});assert.equal(reads,0);
});
