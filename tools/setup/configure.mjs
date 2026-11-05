import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const configFile=path.join(root,'template.config.json');
export function validateConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Configuration object required');
 const {github_repository,steamid64,display_name='CS2 Player',site_origin=null,sites_project_id=null}=value;
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(github_repository)||github_repository.includes('YOUR_'))throw Error('Use your own GitHub OWNER/PRIVATE_REPO');
 if(!/^7656119[0-9]{10}$/.test(steamid64))throw Error('Valid SteamID64 required');
 if(typeof display_name!=='string'||!display_name.trim()||display_name.length>128||/[\x00-\x1f]/.test(display_name))throw Error('Display name must contain 1-128 visible characters');
 if(site_origin!==null){let url;try{url=new URL(site_origin);}catch{throw Error('Valid HTTPS Site origin required');}if(url.protocol!=='https:'||url.origin!==site_origin||url.username||url.password||url.hostname==='your-site.example'||!url.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)))throw Error('Use the exact HTTPS origin of your own registered Site');}
 if(sites_project_id!==null&&(typeof sites_project_id!=='string'||!/^appgprj_[A-Za-z0-9]+$/.test(sites_project_id)))throw Error('Copy the exact Sites project id returned by registration');
 return {github_repository,steamid64,display_name:display_name.trim(),site_origin,sites_project_id};
}
async function walk(dir,prefix=''){
 const result=[];
 for(const e of await fs.readdir(path.join(dir,prefix),{withFileTypes:true})){
  const file=prefix?`${prefix}/${e.name}`:e.name;
  if(e.isSymbolicLink())throw Error('Refusing a symbolic link in managed configuration targets');
  if(e.isDirectory()){if(!['.git','node_modules','dist','.private','.sites-runtime','__pycache__'].includes(e.name))result.push(...await walk(dir,file));}
  else if(e.isFile())result.push(file);
 }return result;
}
export async function configure(value,{target=root}={}){
 const cfg=validateConfig(value),privateConfig=path.join(target,'template.config.json');
 const previous=await fs.readFile(privateConfig,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(previous&&['github_repository','steamid64','site_origin','sites_project_id'].some(key=>previous[key]!=null&&previous[key]!==cfg[key]))throw Error('This checkout already has a different identity or deployment; use a new private checkout');
 const [owner,repo]=cfg.github_repository.split('/');
 const replacements={'__GITHUB_REPOSITORY__':cfg.github_repository,'__GITHUB_OWNER__':owner,'__GITHUB_REPO__':repo,'__STEAMID64__':cfg.steamid64,...(cfg.site_origin?{'https://your-site.example':cfg.site_origin}:{})};
 const targets=(await walk(target)).filter(file=>/^(?:cs2demo\/|dashboard\/(?:ui|worker|shared|data)\/|tools\/local-render\/)/.test(file)&&/\.(?:py|mjs|js|json|css|html|ps1|cmd|md)$/.test(file));
 const writes=[];
 for(const file of targets){const before=await fs.readFile(path.join(target,file),'utf8');let after=before;for(const [token,replacement] of Object.entries(replacements))after=after.replaceAll(token,replacement);if(after!==before)writes.push([file,after]);}
 // The initial profile can be edited only before any matches are present.
 const dataPath=path.join(target,'dashboard/data/dashboard.json'),data=JSON.parse(await fs.readFile(dataPath,'utf8'));
 if((data.matches??[]).length&&data.profile?.steamid64!==cfg.steamid64)throw Error('Existing matches belong to another account');
 if(!(data.matches??[]).length){data.profile={steamid64:cfg.steamid64,name:cfg.display_name};data.source={...data.source,repository:cfg.github_repository};writes.push(['dashboard/data/dashboard.json',JSON.stringify(data)+'\n']);}
 const manifestPath=path.join(target,'dashboard/.openai/hosting.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
 if(manifest.project_id&&manifest.project_id!==cfg.sites_project_id)throw Error('Registered Site differs; preserve its identity');
 writes.push(['dashboard/.openai/hosting.json',JSON.stringify({...manifest,project_id:cfg.sites_project_id},null,2)+'\n']);
 for(const [file,text] of writes)await fs.writeFile(path.join(target,file),text);
 await fs.writeFile(privateConfig,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
 return {status:'configured',github_repository:cfg.github_repository,steam_identity_set:true,site_registered:Boolean(cfg.sites_project_id),native_origin_set:Boolean(cfg.site_origin),changed_files:writes.length};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const argv=process.argv.slice(2),read=key=>{const i=argv.indexOf(key);return i>=0?argv[i+1]:undefined;};let existing={};try{existing=JSON.parse(await fs.readFile(configFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const supplied=Object.fromEntries([['github_repository',read('--repository')],['steamid64',read('--steamid')],['display_name',read('--display-name')],['site_origin',read('--site-origin')],['sites_project_id',read('--sites-project-id')]].filter(([,v])=>v!==undefined));
 console.log(JSON.stringify(await configure({...existing,...supplied})));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
