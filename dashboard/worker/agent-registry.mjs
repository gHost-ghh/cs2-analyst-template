// Trusted, build-time tool composition. This registry deliberately has no
// loader, network client or executable handlers: browser/model input cannot
// install plugins or obtain capabilities by supplying a declaration.
const ID=/^[a-z][a-z0-9_-]{0,79}$/;
const NAME=/^[a-z][a-z0-9_]{0,127}$/;
const CAPABILITIES=Object.freeze(['read','plan','progress','validate','present']);
const FORBIDDEN=new Set(['__proto__','prototype','constructor','api_key','authorization','cookie','password','secret','access_token','refresh_token']);
const encoder=new TextEncoder();
export class AgentRegistryError extends Error{constructor(code='agent_registry_invalid'){super(code);this.name='AgentRegistryError';this.code=code;}}
const reject=code=>{throw new AgentRegistryError(code);};
function plain(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))reject();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(descriptors[key],'value')))reject();
  return Object.fromEntries(Object.entries(descriptors).map(([key,item])=>[key,item.value]));
}
function copyData(value,depth=0,seen=new Set()){
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(!value||typeof value!=='object'||depth>24||seen.has(value))reject();
  seen.add(value);let result;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Array.isArray(value)){
    if(value.length>10000||Reflect.ownKeys(descriptors).some(key=>key!=='length'&&(typeof key!=='string'||!/^(?:0|[1-9]\d*)$/.test(key))))reject();
    result=[];for(let i=0;i<value.length;i++){const item=descriptors[i];if(!item||!Object.hasOwn(item,'value'))reject();result.push(copyData(item.value,depth+1,seen));}
  }else{
    if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))reject();
    result={};for(const key of Reflect.ownKeys(descriptors)){if(typeof key!=='string'||FORBIDDEN.has(key.toLowerCase())||!Object.hasOwn(descriptors[key],'value'))reject();Object.defineProperty(result,key,{value:copyData(descriptors[key].value,depth+1,seen),writable:true,enumerable:true,configurable:true});}
  }
  seen.delete(value);return result;
}
function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function declaration(value){
  const plugin=plain(value,['id','requires','tools']);
  if(!ID.test(plugin.id??'')||plugin.requires!=null&&(!Array.isArray(plugin.requires)||plugin.requires.length>32)||!Array.isArray(plugin.tools)||plugin.tools.length>128)reject();
  const requires=copyData(plugin.requires??[]);
  if(requires.some(id=>typeof id!=='string'||!ID.test(id)||id===plugin.id)||new Set(requires).size!==requires.length)reject();
  const tools=copyData(plugin.tools).map(item=>{
    const tool=plain(item,['name','resource','capability','definition']);
    if(!NAME.test(tool.name??'')||!CAPABILITIES.includes(tool.capability)||tool.resource!=null&&(typeof tool.resource!=='string'||!NAME.test(tool.resource)))reject();
    const definition=plain(tool.definition,['type','name','description','parameters','strict']);
    if(definition.type!=='function'||definition.name!==tool.name||typeof definition.description!=='string'||definition.description.length>16000||!definition.parameters||typeof definition.parameters!=='object'||Array.isArray(definition.parameters)||definition.parameters.type!=='object'||definition.strict!=null&&typeof definition.strict!=='boolean')reject();
    return {name:tool.name,capability:tool.capability,...(tool.resource!=null?{resource:tool.resource}:{}),definition};
  });
  if(new Set(tools.map(tool=>tool.name)).size!==tools.length)reject('agent_registry_duplicate_tool');
  const result={id:plugin.id,requires,tools};if(encoder.encode(JSON.stringify(result)).byteLength>512*1024)reject();return freeze(result);
}
export function createAgentToolRegistry(){
  const plugins=new Map(),names=new Map();
  function register(value){
    // Validate the entire candidate before publishing even its first tool.
    const candidate=declaration(value);
    if(plugins.has(candidate.id))reject('agent_registry_duplicate_plugin');
    if(candidate.requires.some(id=>!plugins.has(id)))reject('agent_registry_dependency_missing');
    if(candidate.tools.some(tool=>names.has(tool.name)))reject('agent_registry_duplicate_tool');
    const slot={value:candidate};plugins.set(candidate.id,slot);for(const tool of candidate.tools)names.set(tool.name,candidate.id);
    return Object.freeze({id:candidate.id,dispose(){
      if(plugins.get(candidate.id)!==slot)return false;
      if([...plugins.values()].some(item=>item.value.requires.includes(candidate.id)))reject('agent_registry_plugin_in_use');
      plugins.delete(candidate.id);for(const tool of candidate.tools)names.delete(tool.name);return true;
    }});
  }
  function snapshot({stage='read'}={}){
    if(!['read','present'].includes(stage))reject();
    const tools=[],directory=[],capabilities=Object.fromEntries(CAPABILITIES.map(key=>[key,[]])),manifest=[];
    for(const {value:plugin}of plugins.values()){
      const admitted=plugin.tools.filter(tool=>stage==='read'||tool.capability==='present');
      manifest.push({id:plugin.id,requires:[...plugin.requires],tool_names:admitted.map(tool=>tool.name)});
      for(const tool of admitted){tools.push(copyData(tool.definition));directory.push({name:tool.name,plugin_id:plugin.id,capability:tool.capability,...(tool.resource?{resource:tool.resource}:{})});capabilities[tool.capability].push(tool.name);}
    }
    return freeze({version:1,stage,plugins:manifest,tools,directory,capabilities});
  }
  return Object.freeze({register,snapshot});
}
