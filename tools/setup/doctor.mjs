import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateConfig} from './configure.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function inspectSetup({target=root,environment=process.env}={}){
 let config=null;try{config=validateConfig(JSON.parse(await fs.readFile(path.join(target,'template.config.json'),'utf8')));}catch{}
 const exists=file=>fs.access(path.join(target,file)).then(()=>true,()=>false);
 const names=['STEAMID64','STEAM_REFRESH_TOKEN','LEETIFY_API_KEY','STEAM_WEB_API_KEY','STEAM_MATCH_AUTH_CODE','STEAM_KNOWNCODE','GITHUB_ACTIONS_TOKEN','DEEPSEEK_API_KEY'];
 const secret_names=Object.fromEntries(names.map(name=>[name,Boolean(environment[name])]));
 let manifest=null;try{manifest=JSON.parse(await fs.readFile(path.join(target,'dashboard/.openai/hosting.json'),'utf8'));}catch{}
 return {configuration:config?'ready':'needs_configuration',node_major:Number(process.versions.node.split('.')[0]),workflow:{enabled_by_default:false,required_repository_variable:'CS2_SYNC_ENABLED=true',configured_github_repository:Boolean(config?.github_repository)},local_environment_names_only:secret_names,remote_secrets_checked:false,dashboard:{registered:Boolean(config?.sites_project_id&&manifest?.project_id===config.sites_project_id),mcp_declared:manifest?.capabilities?.includes('mcp')===true,r2_binding:manifest?.r2==='BUCKET',bootstrap_present:await exists('dashboard/data/dashboard.json')},native:{optional:true,helper_archive_present:await exists('dashboard/assets/local-render/cs2lab-windows.zip')},optional_deepseek:secret_names.DEEPSEEK_API_KEY?'configured_locally':'not_required_for_sync_or_mcp',notes:['This check does not read remote secrets or prove Steam login, ingestion, deployment or private-access acceptance.']};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await inspectSetup(),null,2));
