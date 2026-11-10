import test from 'node:test';
import assert from 'node:assert/strict';
import {bindAgentVisualizations,validateBoundAgentVisualization,evaluateAgentVisualScene} from '../shared/agent-visual.mjs';
import {createAgentRuntime,createMemoryAgentStore} from '../worker/agent-runtime.mjs';
import {createAgentStreamResponse,readSseEvents} from '../worker/agent-stream.mjs';
import {prepareCoachStageArtifact} from '../ui/coach.js';

const owner='76561198000000000',match='a'.repeat(24),source={source_revision:'b'.repeat(40),generated_at:'2026-11-10T00:00:00Z',content_sha256:'c'.repeat(64)};
const query={resource:'rounds',match_id:match,offset:0,limit:20};
function candidate(reference,{projected=true}={}){return {title:'封存回合伤害',description:'使用当前来源的实际字段。',evidence_refs:[reference],document:{version:1,kind:'observed',assumptions:[],dataBindings:[{name:'rows',evidence_ref:reference,...(projected?{path:['items']}:{})}],params:[],lets:[],nodes:[{id:'damage',parent:null,tag:'span',attrs:[],style:[],text:null,bindings:[{target:'text',expr:projected?'data.rows[0].damage':'data.rows.items[0].damage'}],when:null,repeat:null,action:null}],actions:[]}};}
async function fixture({projected=true,legacySource=false}={}){
 const store=createMemoryAgentStore(),runtime=createAgentRuntime({owner,store}),session=await runtime.begin({question:'复核来源与投影',source}),originalSource={...source,repository:'fixture/private-data',analysis_versions:['2.6']};if(legacySource)delete originalSource.content_sha256;
 const result={resource:'rounds',source:originalSource,items:[{round_number:1,damage:80}],query_input:query},entry=await session.rememberQuery(query,result);await session.checkpoint({queries:[entry]});
 const modelCandidate=candidate(entry.reference,{projected}),visuals=bindAgentVisualizations([modelCandidate],{evidence:new Map([[entry.reference,{id:entry.reference,resource:'rounds',query_ref:entry.reference,query}]]),queryResults:new Map([[entry.reference,result]]),source}),artifact=await session.stageArtifact({source,visualizations:visuals,evidence:[]});
 return {store,runtime,session,result,entry,artifact,modelCandidate,binding:{session:{id:session.record.id,turn_id:session.turn.id},source,attempt:1}};
}
async function stream(value,binding){const response=createAgentStreamResponse({binding,execute:async({emit})=>emit('artifact',value)}).response,result=[];for await(const frame of readSseEvents(response.body))result.push(JSON.parse(frame.data));return result;}

test('projected stage source attestations come from the original server query and survive paused recovery',async()=>{
 const f=await fixture(),proof=f.artifact.visualizations[0].provenance[0],before=JSON.stringify(f.result);
 assert.deepEqual(proof.source,source);assert.deepEqual(proof.path,['items']);assert.deepEqual(Object.keys(proof.source).sort(),['content_sha256','generated_at','source_revision']);assert.equal(Object.hasOwn(f.modelCandidate.document.dataBindings[0],'source'),false);assert.equal(Object.hasOwn(f.artifact.visualizations[0].data.rows,'source'),false);
 const sent=await stream(f.artifact,f.binding);assert.equal(sent[0].type,'artifact');assert.equal(sent[0].payload.visualizations[0].data.rows[0].damage,80);assert.ok(prepareCoachStageArtifact(f.artifact,source,f.session.turn.id));
 await f.session.pause();const recovered=await f.runtime.read(f.session.record.id,source);assert.deepEqual(recovered.task.stage_artifact,f.artifact);assert.equal((await stream(recovered.task.stage_artifact,f.binding))[0].type,'artifact');assert.equal(JSON.stringify(f.result),before);
});

test('projected stage streams reject absent, malformed, unknown or mismatched source attestations and foreign turns',async()=>{
 const f=await fixture(),variants=[];
 const missing=structuredClone(f.artifact);delete missing.visualizations[0].provenance[0].source;variants.push(missing);
 for(const [field,value]of [['source_revision','d'.repeat(40)],['generated_at','2026-11-09T00:00:00Z'],['content_sha256','e'.repeat(64)],['content_sha256',null]]){const changed=structuredClone(f.artifact);changed.visualizations[0].provenance[0].source[field]=value;variants.push(changed);}
 const malformed=structuredClone(f.artifact);malformed.visualizations[0].provenance[0].source.extra='PRIVATE_SOURCE';variants.push(malformed);
 const partial=structuredClone(f.artifact);delete partial.visualizations[0].provenance[0].source.generated_at;variants.push(partial);
 const foreign=structuredClone(f.artifact);foreign.visualizations[0].provenance[0].query_ref=`turn:${crypto.randomUUID()}:g0:query:1`;variants.push(foreign);
 let reads=0;const accessor=structuredClone(f.artifact);Object.defineProperty(accessor.visualizations[0].provenance[0].source,'source_revision',{enumerable:true,get(){reads++;return source.source_revision;}});variants.push(accessor);
 for(const value of variants){const sent=await stream(value,f.binding);assert.deepEqual(sent.map(event=>event.type),['error']);assert.equal(sent[0].payload.error,'agent_stream_event_invalid');assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_SOURCE/);assert.equal(prepareCoachStageArtifact(value,source,f.session.turn.id),null);}
 assert.equal(reads,0);
});

test('a stage attestation cannot be substituted for the sealed original query source',async()=>{
 const f=await fixture(),changed=structuredClone(f.artifact);changed.visualizations[0].provenance[0].source.content_sha256='e'.repeat(64);assert.equal(validateBoundAgentVisualization(changed.visualizations[0]),true,'A well-shaped source is validated against the archive by the session boundary');
 await assert.rejects(f.session.stageArtifact(changed),error=>error.code==='invalid_stage_artifact');
 const foreignGeneration=structuredClone(f.artifact);foreignGeneration.visualizations[0].provenance[0].query_ref=f.entry.reference.replace(':g0:',':g1:');await assert.rejects(f.session.stageArtifact(foreignGeneration),error=>error.code==='invalid_stage_artifact');
 assert.deepEqual(f.session.public().task.stage_artifact,f.artifact);
});

test('old formal projected visuals stay renderable without rewriting their provenance, and legacy full-data stage sources still work',async()=>{
 const f=await fixture(),legacy=structuredClone(f.artifact.visualizations[0]);delete legacy.provenance[0].source;const serialized=JSON.stringify(legacy);assert.equal(validateBoundAgentVisualization(legacy),true);assert.equal(evaluateAgentVisualScene(legacy).nodes[0].text,'80');assert.equal(JSON.stringify(legacy),serialized);
 const complete=await fixture({projected:false,legacySource:true});delete complete.artifact.visualizations[0].provenance[0].source;const sent=await stream(complete.artifact,complete.binding);assert.equal(sent[0].type,'artifact');assert.ok(prepareCoachStageArtifact(complete.artifact,source,complete.session.turn.id));assert.equal(Object.hasOwn(sent[0].payload.visualizations[0].data.rows.source,'content_sha256'),false,'Unknown historical hashes remain unknown');
 const stale=structuredClone(complete.artifact);stale.visualizations[0].data.rows.source.source_revision='d'.repeat(40);assert.equal((await stream(stale,complete.binding))[0].type,'error');
});
