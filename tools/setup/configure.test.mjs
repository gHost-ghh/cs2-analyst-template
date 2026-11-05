import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateConfig,configure} from './configure.mjs';
import {inspectSetup} from './doctor.mjs';
const cfg={github_repository:'sample-owner/private-cs2',steamid64:'76561198000000000',display_name:'Example Player',site_origin:'https://sample.chatgpt.site',sites_project_id:'appgprj_synthetic'};
test('configuration validates exact user origin and rejects injection or placeholder identity',()=>{
 assert.equal(validateConfig(cfg).steamid64,cfg.steamid64);
 for(const value of [{...cfg,github_repository:'owner/repo;echo key'},{...cfg,steamid64:'YOUR_STEAMID64'},{...cfg,site_origin:'https://sample.chatgpt.site/path'},{...cfg,site_origin:'https://user:secret@sample.chatgpt.site'},{...cfg,site_origin:'http://sample.test'},{...cfg,site_origin:"https://x');evil.example"},{...cfg,site_origin:'https://your-site.example'}])assert.throws(()=>validateConfig(value));
});
test('clean setup binds own identity once and never rewrites an existing owner or Site',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs2-template-'));try{
  for(const folder of ['dashboard/data','dashboard/.openai','dashboard/worker','tools/local-render'])await fs.mkdir(path.join(dir,folder),{recursive:true});
  await fs.writeFile(path.join(dir,'dashboard/data/dashboard.json'),JSON.stringify({profile:{steamid64:'__STEAMID64__'},matches:[],source:{repository:'__GITHUB_REPOSITORY__'}}));
  await fs.writeFile(path.join(dir,'dashboard/.openai/hosting.json'),JSON.stringify({project_id:null,r2:'BUCKET',capabilities:['mcp']}));
  await fs.writeFile(path.join(dir,'dashboard/worker/sample.mjs'),"const owner='__STEAMID64__', repo='__GITHUB_REPOSITORY__', origin='https://your-site.example';");
  await configure(cfg,{target:dir});await configure(cfg,{target:dir});
  const source=await fs.readFile(path.join(dir,'dashboard/worker/sample.mjs'),'utf8');assert.ok(source.includes(cfg.github_repository));assert.ok(source.includes(cfg.site_origin));
  await assert.rejects(configure({...cfg,steamid64:'76561198000000001'},{target:dir}),/different identity/);
  const status=await inspectSetup({target:dir,environment:{DEEPSEEK_API_KEY:'PRIVATE_NOT_FOR_OUTPUT'}});assert.equal(status.dashboard.registered,true);assert.equal(status.local_environment_names_only.DEEPSEEK_API_KEY,true);assert.ok(!JSON.stringify(status).includes('PRIVATE_NOT_FOR_OUTPUT'));assert.equal(status.remote_secrets_checked,false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
