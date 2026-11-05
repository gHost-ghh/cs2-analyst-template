// Deterministic computations over private, lossless statistics packs. No code,
// SQL, source download or model execution occurs in this module.
export const STATISTICS_COMPUTE_VERSION='1.1';
export const STATISTICS_COMPUTE_LIMITS=Object.freeze({page_rows:100,response_bytes:128*1024,groups:4096,selected_fields:32,metrics:16,filters:16,quantile_values:1000000});
const MISSING=Symbol('missing'),encoder=new TextEncoder();
const forbidden=new Set(['__proto__','prototype','constructor','toString','valueOf','hasOwnProperty','api_key','authorization','cookie','password','secret','access_token','refresh_token']);
const DATASETS=['owner_rounds','player_rounds','technical'];
const FILTERS=['eq','ne','gt','gte','lt','lte','in','is_null','is_missing'];
const OPERATIONS=['count','valid_count','null_count','missing_count','count_true','count_false','sum','mean','min','max','quantile','stddev'];
const METADATA=['match_id','map_name','match_started_at','round_number','side','player_id','owner_player_id'];
const ROUND_DERIVED_FIELDS=Object.freeze({zero_damage_death:Object.freeze({derived:true,formula:'damage === 0 && deaths > 0',inputs:['damage','deaths'],value_type:'boolean',quality:{valid:'Both inputs must be finite numbers. Counts qualifying rounds once, even if deaths is greater than one.',missing:'MISSING if either input is absent; takes precedence over invalid values in the other input.',null_or_invalid:'null when both inputs are present but either is null or is not a finite number. No string or boolean coercion and no default zero.'}})});
const derivedDefinition=(spec,name)=>['owner_rounds','player_rounds'].includes(spec.dataset)&&Object.hasOwn(ROUND_DERIVED_FIELDS,name)?ROUND_DERIVED_FIELDS[name]:null;
const scalar={anyOf:[{type:'string'},{type:'number'},{type:'boolean'},{type:'null'}]};
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
export const STATISTICS_QUERY_SCHEMA={type:'object',additionalProperties:false,properties:{
  dataset:{type:'string',enum:DATASETS},scope:nullable({type:'string',enum:['round','match']}),path:nullable({type:'string'}),
  filters:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,properties:{field:{type:'string'},op:{type:'string',enum:FILTERS},value:{anyOf:[...scalar.anyOf,{type:'array',maxItems:100,items:scalar}]}},required:['field','op','value']}},
  group_by:{type:'array',maxItems:3,items:{type:'string'}},
  metrics:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,properties:{name:{type:'string'},op:{type:'string',enum:OPERATIONS},field:nullable({type:'string'}),quantile:nullable({type:'number',minimum:0,maximum:1})},required:['name','op','field','quantile']}},
  select:{type:'array',maxItems:32,items:{type:'string'}},sort:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,properties:{field:{type:'string'},direction:{type:'string',enum:['asc','desc']}},required:['field','direction']}},
  offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100},
},required:['dataset','scope','path','filters','group_by','metrics','select','sort','offset','limit']};
export const STATISTICS_CATALOG_SCHEMA={type:'object',additionalProperties:false,properties:{dataset:{type:'string',enum:DATASETS},scope:nullable({type:'string',enum:['round','match']}),path:nullable({type:'string'}),prefix:nullable({type:'string'}),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},required:['dataset','scope','path','prefix','offset','limit']};
export class StatisticsComputeError extends Error{constructor(code,details={}){super(code);this.code=code;this.status=422;this.details=details;}}
const fail=(code,details)=>{throw new StatisticsComputeError(code,details);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(Object.getOwnPropertyDescriptors(value)).every(item=>Object.hasOwn(item,'value'));
const own=(value,key)=>Object.hasOwn(value,key);
const missing=value=>value===MISSING||object(value)&&value.missing===true&&Object.keys(value).length===1;
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const clone=value=>structuredClone(value);
function keys(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)||forbidden.has(key)))fail('invalid_statistics_query');}
function field(value){if(typeof value!=='string'||!value||value.length>240||!/^[$A-Za-z0-9_:-]+(?:\.[$A-Za-z0-9_:-]+)*$/.test(value)||value.split('.').some(part=>forbidden.has(part)))fail('invalid_statistics_field');return value;}
function pageSpec(value){const offset=value.offset??0,limit=value.limit??100;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('invalid_statistics_pagination');return {offset,limit};}
function tableSpec(value){const dataset=value.dataset??'owner_rounds';if(!DATASETS.includes(dataset))fail('invalid_statistics_dataset');const scope=value.scope??null,path=value.path??null;if(dataset==='technical'&&(!['round','match'].includes(scope)||!path))fail('statistics_table_required');if(scope!==null&&!['round','match'].includes(scope))fail('invalid_statistics_scope');if(path!==null)field(path);return {dataset,scope,path};}
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
async function hash(value){const digest=await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(canonical(value))));return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');}
function sourceEntries(entries){if(!Array.isArray(entries)||entries.some(entry=>!object(entry)||!object(entry.pack)||typeof entry.pack.match_id!=='string'||!entry.pack.round_statistics||!entry.pack.match_statistics))fail('invalid_statistics_packs');const refs=new Set(),rounds=new Map();for(const entry of entries){if(typeof entry.reference!=='string'||!entry.reference||entry.reference.length>240||refs.has(entry.reference))fail('duplicate_statistics_pack');refs.add(entry.reference);const seen=rounds.get(entry.pack.match_id)??new Set();for(const number of entry.pack.round_numbers??[]){if(seen.has(number))fail('duplicate_statistics_round');seen.add(number);}rounds.set(entry.pack.match_id,seen);}return entries;}

// A reader retains encoded columns and small run indexes, never a Map per row.
class Columns{
  constructor(table){if(!object(table)||!Number.isSafeInteger(table.row_count)||table.row_count<0||!Array.isArray(table.columns))fail('invalid_statistics_pack');this.count=table.row_count;this.columns=new Map(table.columns);this.indexes=new Map();}
  has(path){return this.columns.has(path==='$value'?'':path);}
  at(path,index){if(!Number.isSafeInteger(index)||index<0||index>=this.count)return MISSING;const key=path==='$value'?'':path,col=this.columns.get(key);if(!col)return MISSING;let value;
    if(Array.isArray(col.values))value=col.values[index];
    else if(Array.isArray(col.indices))value=col.dictionary?.[col.indices[index]];
    else if(Array.isArray(col.runs)){let indexData=this.indexes.get(key);if(!indexData){let end=0;indexData=col.runs.map(([item,count])=>{if(!Number.isSafeInteger(count)||count<1)fail('invalid_statistics_pack');end+=count;return {end,value:item};});if(end!==this.count)fail('invalid_statistics_pack');this.indexes.set(key,indexData);}let low=0,high=indexData.length;while(low<high){const mid=(low+high)>>>1;if(index<indexData[mid].end)high=mid;else low=mid+1;}value=indexData[low]?.value;}
    else{value=col.default;const changes=col.changes??[];let low=0,high=changes.length;while(low<high){const mid=(low+high)>>>1;if(changes[mid][0]<index)low=mid+1;else high=mid;}if(changes[low]?.[0]===index)value=changes[low][1];}
    return value===undefined||missing(value)?MISSING:value;
  }
}

function contexts(pack,spec){
  const match=new Columns(pack.match_statistics),rounds=new Columns(pack.round_statistics),tables=new Map((pack.technical_tables??[]).map(table=>[table.scope+':'+table.path,table])),readers=new Map();
  const reader=definition=>{const key=definition.scope+':'+definition.path;if(!readers.has(key))readers.set(key,new Columns(definition.statistics));return readers.get(key);};
  let definition=null,current;
  if(spec.dataset==='owner_rounds')current=rounds;
  else if(spec.dataset==='player_rounds'){definition=[...tables.values()].find(table=>table.scope==='match'&&/^players(?:\.players)?\.rounds$/.test(table.path));current=definition?reader(definition):null;}
  else{definition=tables.get(spec.scope+':'+spec.path);current=definition?reader(definition):null;}
  const ancestors=(index)=>{const chain=[];let def=definition,row=index;const visited=new Set();while(def){const key=def.scope+':'+def.path;if(visited.has(key)||visited.size>32)fail('invalid_statistics_parent');visited.add(key);const cols=reader(def);chain.push({definition:def,reader:cols,index:row});if(!def.parent_path)break;row=cols.at('$parent',row);def=tables.get(def.scope+':'+def.parent_path);if(!def||!Number.isSafeInteger(row)||row<0||row>=reader(def).count)fail('invalid_statistics_parent');}return chain;};
  let ownerCached=false,ownerValue=MISSING;
  const ownId=()=>{if(ownerCached)return ownerValue;ownerCached=true;for(const name of ['player.steamid','player.steamid64','player.player_id','profile.steamid64']){const value=match.at(name,0);if(!missing(value)&&value!==null)return ownerValue=String(value);}const players=tables.get('match:players')??tables.get('match:players.players');if(players){const cols=reader(players);for(let row=0;row<cols.count;row++)if(cols.at('is_self',row)===true){for(const name of ['player_id','steamid64','steamid','id']){const value=cols.at(name,row);if(!missing(value)&&value!==null)return ownerValue=String(value);}}}return ownerValue;};
  const get=(index,name)=>{
    if(derivedDefinition(spec,name)){const damage=current?current.at('damage',index):MISSING,deaths=current?current.at('deaths',index):MISSING;if(missing(damage)||missing(deaths))return MISSING;return numeric(damage)&&numeric(deaths)?damage===0&&deaths>0:null;}
    const direct=current?current.at(name,index):MISSING;if(!missing(direct))return direct;if(!METADATA.includes(name))return MISSING;if(name==='match_id')return pack.match_id;if(name==='map_name'||name==='match_started_at')return match.at(name,0);if(name==='owner_player_id')return ownId();
    const chain=definition?ancestors(index):[],rootIndex=definition?current.at('$row',index):index;
    if(name==='player_id'){
      for(const item of chain)if(/^players(?:\.players)?$/.test(item.definition.path))for(const key of ['player_id','steamid64','steamid','id']){const value=item.reader.at(key,item.index);if(!missing(value))return String(value);}
      return spec.dataset==='owner_rounds'||definition?.scope==='round'||definition?.path.startsWith('analysis.')?ownId():MISSING;
    }
    for(const item of chain){const value=item.reader.at(name,item.index);if(!missing(value))return value;}
    return !definition||definition.scope==='round'?rounds.at(name,rootIndex):MISSING;
  };
  return {pack,spec,match,rounds,tables,current,definition,get,ancestors};
}

function fieldNames(ctx){return [...new Set([...(ctx.current?.columns.keys()??[])].map(name=>name||'$value').concat(METADATA,derivedDefinition(ctx.spec,'zero_damage_death')?Object.keys(ROUND_DERIVED_FIELDS):[]))].sort();}
function valueType(value){return missing(value)?'missing':value===null?'null':typeof value;}
function limitedPage(items,query,base){let selected=items.slice(query.offset,query.offset+query.limit);const output=()=>({...base,items:selected,pagination:{offset:query.offset,limit:query.limit,total:items.length,returned:selected.length,next_offset:query.offset+selected.length<items.length?query.offset+selected.length:null}});while(selected.length&&encoder.encode(JSON.stringify(output())).byteLength>STATISTICS_COMPUTE_LIMITS.response_bytes)selected.pop();if(!selected.length&&query.offset<items.length)fail('statistics_result_row_too_large');const result=output();if(encoder.encode(JSON.stringify(result)).byteLength>STATISTICS_COMPUTE_LIMITS.response_bytes)fail('statistics_result_metadata_too_large');return result;}

export async function catalogStatistics(entries,options={}){
  sourceEntries(entries);keys(options,['dataset','scope','path','prefix','offset','limit','source','legacyProjection']);const spec=tableSpec(options),page=pageSpec(options),prefix=options.prefix??'';if(prefix)field(prefix);const fields=new Map(),tables=new Map(),unavailable=[];let rows=0;
  for(const {pack}of entries){for(const table of pack.technical_tables??[]){const key=table.scope+':'+table.path,found=tables.get(key)??{scope:table.scope,path:table.path,parent_path:table.parent_path??null,rows:0,matches:0};found.rows+=table.statistics.row_count;found.matches++;tables.set(key,found);}const ctx=contexts(pack,spec);if(!ctx.current){unavailable.push(pack.match_id);continue;}rows+=ctx.current.count;for(const name of fieldNames(ctx))if(!prefix||name.startsWith(prefix))if(!fields.has(name))fields.set(name,{field:name,types:new Set(),present:0,nulls:0,missing:0});}
  for(const {pack}of entries){const ctx=contexts(pack,spec);if(!ctx.current)continue;for(const [name,item]of fields)for(let row=0;row<ctx.current.count;row++){const value=ctx.get(row,name),type=valueType(value);item.types.add(type);if(type==='missing')item.missing++;else{item.present++;if(type==='null')item.nulls++;}}}
  const items=[...fields.values()].map(item=>({...item,types:[...item.types].sort(),...(derivedDefinition(spec,item.field)?clone(derivedDefinition(spec,item.field)):{} )}));return limitedPage(items,page,{version:STATISTICS_COMPUTE_VERSION,resource:'statistics_catalog',dataset:spec,source:clone(options.source??{}),rows,table_catalog:[...tables.values()],unavailable_match_ids:[...new Set(unavailable)],legacy_projection:options.legacyProjection===true,model_exposure:'schema_and_counts_only'});
}

export async function computeStatistics(entries,query,options={}){
  sourceEntries(entries);keys(query,['dataset','scope','path','filters','group_by','metrics','select','sort','offset','limit']);keys(options,['source','scope','side','signal','legacyProjection']);
  const spec=tableSpec(query),page=pageSpec(query),normalized={...spec,filters:query.filters??[],group_by:query.group_by??[],metrics:query.metrics??[],select:query.select??[],sort:query.sort??[],...page};
  return runComputation(entries,normalized,options);
}

function validateComputation(query){
  for(const [name,max]of [['filters',16],['group_by',3],['metrics',16],['select',32],['sort',3]])if(!Array.isArray(query[name])||query[name].length>max)fail('invalid_statistics_'+name);
  query.group_by.forEach(field);query.select.forEach(field);if(new Set(query.group_by).size!==query.group_by.length||new Set(query.select).size!==query.select.length)fail('duplicate_statistics_field');
  for(const name of [...query.group_by,...query.select])if(['evidence_ref','evidence_refs','missing_fields','metric_samples','row_locator'].includes(name))fail('statistics_output_field_reserved',{field:name});
  if(query.select.length&&(query.metrics.length||query.group_by.length))fail('statistics_projection_aggregate_conflict');if(!query.select.length&&!query.metrics.length)fail('statistics_metrics_required');
  const metricNames=new Set();for(const metric of query.metrics){keys(metric,['name','op','field','quantile']);field(metric.name);if(metric.name.includes('.')||metricNames.has(metric.name)||query.group_by.includes(metric.name)||['evidence_ref','evidence_refs','missing_fields','metric_samples'].includes(metric.name))fail('invalid_statistics_metric_name');metricNames.add(metric.name);if(!OPERATIONS.includes(metric.op))fail('invalid_statistics_operation');if(metric.op==='count'){if(metric.field!=null)fail('statistics_count_field_must_be_null');}else field(metric.field);if(metric.op==='quantile'){if(!numeric(metric.quantile)||metric.quantile<0||metric.quantile>1)fail('invalid_statistics_quantile');}else if(metric.quantile!=null)fail('invalid_statistics_quantile');}
  for(const filter of query.filters){keys(filter,['field','op','value']);field(filter.field);if(!FILTERS.includes(filter.op))fail('invalid_statistics_filter');if(filter.op==='in'){if(!Array.isArray(filter.value)||filter.value.length>100||filter.value.some(value=>!isScalar(value)))fail('invalid_statistics_filter_value');}else if(!isScalar(filter.value??null))fail('invalid_statistics_filter_value');}
  for(const sort of query.sort){keys(sort,['field','direction']);field(sort.field);if(!['asc','desc'].includes(sort.direction))fail('invalid_statistics_sort');if(!query.select.length&&!query.group_by.includes(sort.field)&&!metricNames.has(sort.field))fail('statistics_sort_field_unavailable');}
  if(query.select.length&&query.sort.length&&query.offset+query.limit>4096)fail('statistics_working_set_too_large');
}
function isScalar(value){return value===null||typeof value==='string'||typeof value==='boolean'||numeric(value);}
function matchesFilter(value,filter){
  if(filter.op==='is_missing')return missing(value);if(filter.op==='is_null')return value===null;if(missing(value))return false;
  if(filter.op==='eq')return value===filter.value;if(filter.op==='ne')return value!==filter.value;if(filter.op==='in')return filter.value.some(item=>item===value);
  if(typeof value!==typeof filter.value||!['number','string'].includes(typeof value)||typeof value==='number'&&(!numeric(value)||!numeric(filter.value)))return false;
  return filter.op==='gt'?value>filter.value:filter.op==='gte'?value>=filter.value:filter.op==='lt'?value<filter.value:value<=filter.value;
}
function metricState(){return {rows:0,numeric_count:0,valid_count:0,null_count:0,missing_count:0,invalid_count:0,true_count:0,false_count:0,sum:0,compensation:0,mean:0,m2:0,min:Infinity,max:-Infinity,values:null};}
function accumulate(state,value,metric,memory){
  state.rows++;if(metric.op==='count')return;if(missing(value)){state.missing_count++;return;}if(value===null){state.null_count++;return;}if(isScalar(value))state.valid_count++;
  if(typeof value==='boolean'){if(value)state.true_count++;else state.false_count++;}
  if(!numeric(value)){if(!['count_true','count_false'].includes(metric.op)||typeof value!=='boolean')state.invalid_count++;return;}
  if(['count_true','count_false'].includes(metric.op)){state.invalid_count++;return;}
  state.numeric_count++;const next=value-state.compensation,total=state.sum+next;state.compensation=(total-state.sum)-next;state.sum=total;
  const delta=value-state.mean;state.mean+=delta/state.numeric_count;state.m2+=delta*(value-state.mean);state.min=Math.min(state.min,value);state.max=Math.max(state.max,value);
  if(metric.op==='quantile'){if(++memory.quantile_values>STATISTICS_COMPUTE_LIMITS.quantile_values)fail('statistics_quantile_memory_limit');(state.values??=[]).push(value);}
}
function metricResult(state,metric){
  const op=metric.op;if(op==='count')return state.rows;if(op==='valid_count')return state.valid_count;if(op==='null_count')return state.null_count;if(op==='missing_count')return state.missing_count;if(op==='count_true')return state.true_count;if(op==='count_false')return state.false_count;
  if(!state.numeric_count)return null;let value;if(op==='sum')value=state.sum;else if(op==='mean')value=state.mean;else if(op==='min')value=state.min;else if(op==='max')value=state.max;else if(op==='stddev')value=state.numeric_count<2?null:Math.sqrt(Math.max(0,state.m2)/(state.numeric_count-1));
  else{state.values.sort((a,b)=>a-b);const rank=(state.values.length-1)*metric.quantile,low=Math.floor(rank),high=Math.ceil(rank);value=state.values[low]+(state.values[high]-state.values[low])*(rank-low);}
  if(value!==null&&!numeric(value))fail('statistics_numeric_overflow');return value;
}
function compareValues(a,b){if(missing(a)||a===null)return missing(b)||b===null?0:1;if(missing(b)||b===null)return -1;if(typeof a!==typeof b)return typeof a<typeof b?-1:1;return a<b?-1:a>b?1:0;}
function recordComparator(sort){return (a,b)=>{for(let index=0;index<sort.length;index++){const result=compareValues(a.sort[index],b.sort[index]);if(result)return sort[index].direction==='desc'?-result:result;}return a.ordinal-b.ordinal;};}
function emptyDeclared(ctx,spec){
  if(spec.dataset==='owner_rounds')return false;const path=spec.dataset==='player_rounds'?'players.rounds':spec.path,scope=spec.dataset==='player_rounds'?'match':spec.scope;
  const possible=[...ctx.tables.values()].filter(table=>table.scope===scope&&path.startsWith(table.path+'.')).sort((a,b)=>b.path.length-a.path.length),parent=possible[0],relative=parent?path.slice(parent.path.length+1):path;
  const details=new Columns(parent?parent.detail_index:scope==='round'?ctx.pack.round_detail_index:ctx.pack.match_detail_index);if(!details.has(relative))return false;for(let index=0;index<details.count;index++)if(details.at(relative,index)!==0)return false;return true;
}
async function runComputation(entries,query,options){
  validateComputation(query);if(options.side!=null&&!['all','T','CT'].includes(options.side))fail('invalid_statistics_side');const source=clone(options.source??{}),source_refs=[],packHashes=[];
  const names=new Set(),availability=[],unavailable=[];let totalRows=0;
  for(const entry of entries){const ctx=contexts(entry.pack,query);availability.push(Boolean(ctx.current)||emptyDeclared(ctx,query));if(!availability.at(-1))unavailable.push(entry.pack.match_id);if(ctx.current){totalRows+=ctx.current.count;fieldNames(ctx).forEach(name=>names.add(name));}const pack_hash=await hash(entry.pack);packHashes.push({reference:entry.reference,pack_hash});source_refs.push({match_id:entry.pack.match_id,query_ref:entry.reference,statistics_ref:clone(entry.pack.statistics_ref??null),detail_ref:clone(entry.pack.detail_ref??null),pack_sha256:pack_hash});}
  const fields=[...new Set([...query.group_by,...query.select,...query.metrics.filter(metric=>metric.field!=null).map(metric=>metric.field),...query.filters.map(filter=>filter.field),...(query.select.length?query.sort.map(sort=>sort.field):[])])];for(const name of fields)if(!names.has(name)&&availability.some(Boolean))fail(options.legacyProjection?'statistics_field_unavailable':'statistics_field_not_found',{field:name});
  const source_hash=await hash({source,entries:packHashes}),{offset,limit,...semanticQuery}=query,computation_hash=await hash({version:STATISTICS_COMPUTE_VERSION,source_hash,query:semanticQuery,scope:options.scope??'all_matches',side:options.side??'all',legacy_projection:options.legacyProjection===true});
  const groups=new Map(),projection=[],memory={quantile_values:0,projection_bytes:0,group_bytes:0},scannedMatches=new Set(),selectedMatches=new Set(),selectedRounds=new Set();let scanned=0,selected=0,ordinal=0;const compare=recordComparator(query.sort),keep=query.offset+query.limit;
  const makeGroup=values=>{const key=JSON.stringify(values.map(value=>missing(value)?['missing']:['value',value]));let group=groups.get(key);if(!group){if(groups.size>=STATISTICS_COMPUTE_LIMITS.groups)fail('statistics_group_limit');memory.group_bytes+=encoder.encode(key).byteLength;if(memory.group_bytes>4*1024*1024)fail('statistics_working_set_too_large');group={values,states:query.metrics.map(metricState),refs:new Set()};groups.set(key,group);}return group;};
  if(!query.select.length&&!query.group_by.length)makeGroup([]);
  for(const entry of entries){const ctx=contexts(entry.pack,query);if(!ctx.current)continue;scannedMatches.add(entry.pack.match_id);
    for(let index=0;index<ctx.current.count;index++){
      if((scanned&1023)===0&&options.signal?.aborted)fail('statistics_computation_cancelled');scanned++;const rowValues=new Map(),get=name=>{if(!rowValues.has(name))rowValues.set(name,ctx.get(index,name));return rowValues.get(name);};
      if(options.side&&options.side!=='all'&&get('side')!==options.side||query.filters.some(filter=>!matchesFilter(get(filter.field),filter)))continue;
      selected++;selectedMatches.add(entry.pack.match_id);const roundNumber=get('round_number');if(Number.isSafeInteger(roundNumber))selectedRounds.add(entry.pack.match_id+':'+roundNumber);
      if(query.select.length){
        if(!query.sort.length&&(selected<=query.offset||selected>keep))continue;
        const values={},absent=[];for(const name of query.select){const value=get(name);if(missing(value)){values[name]=null;absent.push(name);}else values[name]=value;}if(absent.length)values.missing_fields=absent;
        const candidate={values,sort:query.sort.map(item=>get(item.field)),ordinal:ordinal++,reference:entry.reference,match_id:entry.pack.match_id,round_number:Number.isSafeInteger(roundNumber)?roundNumber:null};candidate.bytes=encoder.encode(JSON.stringify(values)).byteLength;
        if(query.sort.length){let low=0,high=projection.length;while(low<high){const mid=(low+high)>>>1;if(compare(projection[mid],candidate)<=0)low=mid+1;else high=mid;}if(low<keep){projection.splice(low,0,candidate);memory.projection_bytes+=candidate.bytes;if(projection.length>keep)memory.projection_bytes-=projection.pop().bytes;}}
        else{projection.push(candidate);memory.projection_bytes+=candidate.bytes;}
        if(memory.projection_bytes>8*1024*1024)fail('statistics_working_set_too_large');
      }else{const group=makeGroup(query.group_by.map(get));group.refs.add(entry.reference);for(let metric=0;metric<query.metrics.length;metric++)accumulate(group.states[metric],query.metrics[metric].field==null?MISSING:get(query.metrics[metric].field),query.metrics[metric],memory);}
    }
  }
  if(options.signal?.aborted)fail('statistics_computation_cancelled');
  const definitions={count:'all selected rows',valid_count:'present, non-null finite scalar values; strings and booleans retain their types',count_true:'strict boolean true only',count_false:'strict boolean false only',numeric_operations:'finite numbers only; null, missing, booleans and strings are not zero',quantile:'exact Type 7 linear interpolation, rank=(n-1)*q',stddev:'sample standard deviation, denominator n-1; n<2 gives null',empty_numeric:'sum/mean/min/max/quantile/stddev return null without numeric values'};
  const derivedFields=fields.filter(name=>derivedDefinition(query,name));if(derivedFields.length)definitions.derived_fields=Object.fromEntries(derivedFields.map(name=>[name,clone(derivedDefinition(query,name))]));
  let items;
  if(query.select.length){const selectedRows=query.sort.length?projection.slice(query.offset):projection;items=selectedRows.map((row,index)=>({...row.values,evidence_ref:`statistics:${computation_hash}:row:${query.offset+index}`,evidence_refs:[row.reference],row_locator:{match_id:row.match_id,round_number:row.round_number}}));}
  else{items=[...groups.values()].map((group,index)=>{const item={},absent=[];for(let fieldIndex=0;fieldIndex<query.group_by.length;fieldIndex++){const name=query.group_by[fieldIndex],value=group.values[fieldIndex];item[name]=missing(value)?null:value;if(missing(value))absent.push(name);}if(absent.length)item.missing_fields=absent;item.metric_samples={};for(let metricIndex=0;metricIndex<query.metrics.length;metricIndex++){const metric=query.metrics[metricIndex],state=group.states[metricIndex];item[metric.name]=metricResult(state,metric);item.metric_samples[metric.name]={rows:state.rows,n:['count','valid_count','null_count','missing_count'].includes(metric.op)?state.rows:['count_true','count_false'].includes(metric.op)?state.true_count+state.false_count:state.numeric_count,numeric_n:state.numeric_count,valid_count:state.valid_count,null_count:state.null_count,missing_count:state.missing_count,invalid_count:state.invalid_count};}item.evidence_ref=`statistics:${computation_hash}:group:${index}`;item.evidence_refs=[...group.refs];return item;});if(query.sort.length)items=items.map((values,ordinal)=>({values,ordinal,sort:query.sort.map(item=>Object.hasOwn(values,item.field)?values[item.field]:MISSING)})).sort(compare).map(item=>item.values);}
  if(!availability.some(Boolean))items=[];
  const complete=unavailable.length===0&&options.legacyProjection!==true,coverage={scope:options.scope??'all_matches',dataset:query.dataset,table:query.dataset==='technical'?{scope:query.scope,path:query.path}:null,loaded_matches:new Set(entries.map(entry=>entry.pack.match_id)).size,scanned_match_ids:[...scannedMatches],selected_match_ids:[...selectedMatches],scanned_rows:scanned,selected_rows:selected,selected_rounds:selectedRounds.size,groups:query.select.length?null:groups.size,unavailable_match_ids:[...new Set(unavailable)],complete,legacy_projection:options.legacyProjection===true,raw_arrays_read:false,model_exposure:query.select.length?'selected_statistics_rows_only':'computed_results_only'};
  const base={version:STATISTICS_COMPUTE_VERSION,resource:'statistics_compute',available:availability.some(Boolean),source,source_hash,computation_hash,query:clone(query),source_refs,evidence_refs:entries.map(entry=>entry.reference),coverage,definitions,model_exposure:coverage.model_exposure};
  if(encoder.encode(JSON.stringify(base)).byteLength>STATISTICS_COMPUTE_LIMITS.response_bytes)fail('statistics_result_metadata_too_large');
  if(query.select.length){const total=selected,baseWithPage={...base,pagination:{offset:query.offset,limit:query.limit,total,returned:items.length,next_offset:query.offset+items.length<total?query.offset+items.length:null}};while(items.length&&encoder.encode(JSON.stringify({...baseWithPage,items})).byteLength>STATISTICS_COMPUTE_LIMITS.response_bytes)items.pop();if(!items.length&&query.offset<total)fail('statistics_result_row_too_large');baseWithPage.pagination.returned=items.length;baseWithPage.pagination.next_offset=query.offset+items.length<total?query.offset+items.length:null;return {...baseWithPage,items};}
  if(encoder.encode(JSON.stringify(base)).byteLength>STATISTICS_COMPUTE_LIMITS.response_bytes)fail('statistics_result_metadata_too_large');return limitedPage(items,{offset,limit},base);
}
