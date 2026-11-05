import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {makeWorker} from '../worker/server.mjs';
const empty={schema_version:'1.0',generated_at:'2000-01-01T00:00:00Z',profile:{steamid64:'76561198000000000',name:'Synthetic Player'},matches:[],source:{analysis_version:'2.6'},summary:{matches:0,rounds:0},coverage:{},player_directory:[],training_plan:[],limitations:[]};
test('independent empty owner Dashboard and MCP need no model key',async()=>{
 const worker=makeWorker({initial:empty,page:'<!doctype html><title>CS2</title>',assets:{}});
 const health=await(await worker.fetch(new Request('https://sample.test/health'),{})).json();assert.equal(health.status,'ok');
 const rpc=(method,params={})=>new Request('https://sample.test/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const discovery=await(await worker.fetch(rpc('tools/list'),{})).json();assert.ok(discovery.result.tools.some(tool=>tool.name==='query_dashboard_data'));assert.ok(discovery.result.tools.some(tool=>tool.name==='read_data_catalog'));assert.equal(discovery.result.tools.some(tool=>JSON.stringify(tool).includes(empty.profile.steamid64)),false);
 const denied=await worker.fetch(rpc('tools/call',{name:'read_dashboard_status',arguments:{}}),{});assert.equal(denied.status,401);
 const coach=await(await worker.fetch(new Request('https://sample.test/api/coach'),{})).json();assert.equal(coach.status,'not_configured');assert.equal(coach.model,null);
});
test('repository bootstrap contains zero matches rather than author data',async()=>{
 const data=JSON.parse(await fs.readFile(new URL('../data/dashboard.json',import.meta.url),'utf8'));assert.deepEqual(data.matches,[]);assert.equal(data.schema_version,'1.0');
 const manifest=JSON.parse(await fs.readFile(new URL('../.openai/hosting.json',import.meta.url),'utf8'));assert.ok(manifest.capabilities.includes('mcp'));assert.equal(manifest.r2,'BUCKET');
});
