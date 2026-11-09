import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentRuntime,createMemoryAgentStore} from '../worker/agent-runtime.mjs';
import {prepareStatisticsPack} from '../worker/agent-bulk.mjs';
const owner='76561198000000000',revision='a'.repeat(40),id='b'.repeat(24),source={source_revision:revision,generated_at:'2026-11-05T00:00:00Z',content_sha256:'c'.repeat(64)};
const ref=kind=>({schema_version:'1.0',match_id:id,source_revision:revision,content_sha256:(kind==='statistics'?'d':'e').repeat(64),decoded_bytes:2000,path:`reports/dashboard.${kind}/${id}.json`});
function pack(){return prepareStatisticsPack({match_id:id,player:{steamid:owner},rounds:Array.from({length:30},(_,i)=>({round_number:i+1,evidence_id:`match:${id}:r${i+1}:original`,side:'T',damage:i,kills:0,deaths:1}))},{statisticsRef:ref('statistics'),detailRef:ref('matches')});}
test('bulk source registration avoids per-round alias shard I/O and still resolves exact source evidence',async()=>{
 const base=createMemoryAgentStore(),keys=[],store={...base,async load(key){keys.push(['read',key]);return base.load(key);},async write(key,...args){keys.push(['write',key]);return base.write(key,...args);}},runtime=createAgentRuntime({owner,store}),session=await runtime.begin({question:'核对全部比赛',context:{view:'coach'},task:{mode:'diagnose'},source}),value=pack();
 await session.rememberStatisticsPack(ref('statistics'),ref('matches'),value);keys.length=0;
 const query={resource:'rounds',match_id:id,offset:0,limit:100},result={resource:'rounds',source,statistics_pack:value,evidence_refs:[`match:${id}`,...value.round_evidence_refs,...value.round_numbers.map(n=>`match:${id}:r${n}`)]},[entry]=await session.rememberQueryBatch([{query,result}]);
 assert.equal(keys.filter(([,key])=>key.includes('/refs/')).length,0,'No per-round alias trie reads or writes for a sealed statistics pack');assert.ok(keys.filter(([op])=>op==='write').length<=4);
 for(const reference of [`match:${id}`,`match:${id}:r1`,`match:${id}:r30:original`]){const restored=await session.restoreQuery(reference,{requireUnique:true});assert.equal(restored.reference,entry.reference);assert.equal(restored.result.statistics_pack.match_id,id);}
 assert.equal(await session.restoreQuery(`match:${id}:r99`),null);assert.equal(await session.restoreQuery(`match:${id}:r1:forged`),null);
 const progress=session.turn.query_success_sequence;await session.rememberQueryBatch([{query,result}]);assert.equal(session.turn.query_success_sequence,progress,'Repeating the same source grants no new automatic continuation credit');
});
test('a second turn reuses source-verified prepared packs but creates new exact archive references',async()=>{
 const store=createMemoryAgentStore(),runtime=createAgentRuntime({owner,store}),first=await runtime.begin({question:'第一轮',context:{view:'coach'},task:{mode:'diagnose'},source}),value=pack();await first.rememberStatisticsPack(ref('statistics'),ref('matches'),value);
 const second=await runtime.begin({question:'另一会话',context:{view:'coach'},task:{mode:'diagnose'},source});assert.deepEqual(await second.cachedStatisticsPack(ref('statistics'),ref('matches')),value);assert.equal(await second.restoreQuery(`turn:${first.turn.id}:g0:query:1`),null);
 const foreign=createAgentRuntime({owner:'76561198000000001',store}),third=await foreign.begin({question:'独立用户',context:{view:'coach'},task:{mode:'diagnose'},source});assert.equal(await third.cachedStatisticsPack(ref('statistics'),ref('matches')),null);
 assert.equal(await second.cachedStatisticsPack({...ref('statistics'),content_sha256:'f'.repeat(64)},ref('matches')),null);
});

async function registerPack(session){
 const value=pack();await session.rememberStatisticsPack(ref('statistics'),ref('matches'),value);
 const [entry]=await session.rememberQueryBatch([{query:{resource:'rounds',match_id:id,offset:0,limit:100},result:{resource:'rounds',source,statistics_pack:value,evidence_refs:[`match:${id}`,...value.round_evidence_refs,...value.round_numbers.map(n=>`match:${id}:r${n}`)]}}]);return entry;
}

test('detailed aim aliases remain addressable after a complete statistics pack is registered',async()=>{
 const runtime=createAgentRuntime({owner}),session=await runtime.begin({question:'详细瞄准证据',source}),bulk=await registerPack(session),alias=`match:${id}:r1:aim:r1:b100`;
 const detail=await session.rememberQuery({resource:'aim',match_id:id,round_number:1},{resource:'aim',source,items:[{clip_id:'r1:b100',evidence_ref:alias}],evidence_refs:[alias]});
 const restored=await session.restoreQuery(alias,{requireUnique:true});assert.equal(restored.reference,detail.reference);assert.notEqual(restored.reference,bulk.reference);assert.equal(restored.query.resource,'aim');assert.equal(restored.result.items[0].clip_id,'r1:b100');assert.equal(restored.ambiguous,undefined);
 assert.deepEqual(await session.restoreQuery(detail.reference,{requireUnique:true}),restored);assert.equal(await session.restoreQuery(`match:${id}:r1:aim:r1:b101`),null);
});

test('whole-pack and paginated aliases preserve ambiguity and exact query selection',async()=>{
 const runtime=createAgentRuntime({owner}),session=await runtime.begin({question:'分页证据',source}),bulk=await registerPack(session),alias=`match:${id}:r1`;
 const page=await session.rememberQuery({resource:'rounds',match_id:id,offset:0,limit:1},{resource:'rounds',source,items:[{round_number:1,damage:0,evidence_ref:alias}],evidence_refs:[alias]});
 await assert.rejects(session.restoreQuery(alias,{requireUnique:true}),error=>error.code==='query_archive_ambiguous');
 const restored=await session.restoreQuery(alias);assert.equal(restored.reference,bulk.reference);assert.equal(restored.ambiguous,true);
 assert.equal((await session.restoreQuery(page.reference,{requireUnique:true})).result.items[0].round_number,1);assert.equal((await session.restoreQuery(bulk.reference,{requireUnique:true})).result.statistics_pack.match_id,id);
});

test('an earlier detailed page keeps first-reference ordering when a later complete pack overlaps it',async()=>{
 const runtime=createAgentRuntime({owner}),session=await runtime.begin({question:'先读取分页再读取全库',source}),alias=`match:${id}:r1`;
 const page=await session.rememberQuery({resource:'rounds',match_id:id,offset:0,limit:1},{resource:'rounds',source,items:[{round_number:1,evidence_ref:alias}],evidence_refs:[alias]});await registerPack(session);
 const restored=await session.restoreQuery(alias);assert.equal(restored.reference,page.reference);assert.equal(restored.ambiguous,true);await assert.rejects(session.restoreQuery(alias,{requireUnique:true}),error=>error.code==='query_archive_ambiguous');
});
