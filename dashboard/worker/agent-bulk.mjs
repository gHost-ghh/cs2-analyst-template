// Plain JSON statistics transport. Sparse columns preserve every scalar value;
// only event/trajectory arrays are represented by an explicit unread index.
export const BULK_STATISTICS_VERSION='1.0';
export const BULK_STATISTICS_LIMITS=Object.freeze({concurrency:3,inflight_source_bytes:6*1024*1024,pack_bytes:384*1024,input_bytes:3*1024*1024});
const textEncoder=new TextEncoder();
const MISSING=Object.freeze({missing:true});
const rawArrays=new Set(['trace','trajectory','points','targets','geometry','samples','frames','positions','events','alive_timeline','timeline','death_positions','engagement_positions','shot_markers','hit_details']);
const hidden=new Set(['__proto__','prototype','constructor','api_key','authorization','cookie','password','secret','access_token','refresh_token']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const bytes=value=>textEncoder.encode(JSON.stringify(value)).byteLength;
export class BulkStatisticsError extends Error{constructor(code){super(code);this.code=code;}}
function fields(value,path='',result=new Map(),arrays=new Map(),tables=null,rowIndex=0,basePath='',parentIndex=null){
  if(value===null||['string','number','boolean'].includes(typeof value)){result.set(path,typeof value==='number'&&!Number.isFinite(value)?null:value);return {result,arrays};}
  if(Array.isArray(value)){
    arrays.set(path,value.length);
    // Technical observations, components, weapon/shot-index breakdowns and
    // burst-window scalars are all readable. Only dense geometry and event
    // streams are deferred; their original paths/counts remain addressable.
    if(!rawArrays.has(path.split('.').at(-1))){
      if(tables){const tablePath=basePath?basePath+'.'+path:path;if(!tables.has(tablePath))tables.set(tablePath,{parent_path:basePath||null,entries:[]});const table=tables.get(tablePath);for(let index=0;index<value.length;index++){const entryIndex=table.entries.length;table.entries.push(null);const entry=fields(value[index],'',new Map(),new Map(),tables,rowIndex,tablePath,entryIndex);entry.result.set('$row',rowIndex);entry.result.set('$index',index);if(parentIndex!==null)entry.result.set('$parent',parentIndex);table.entries[entryIndex]=entry;}}
      else for(let index=0;index<value.length;index++)fields(value[index],path+'.'+index,result,arrays);
    }
    return {result,arrays};
  }
  if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){
    if(hidden.has(key))continue;
    if(key==='_cs2_deferred'){for(const [name,descriptor]of Object.entries(child??{}))arrays.set((path?path+'.':'')+name,Number.isSafeInteger(descriptor.count)?descriptor.count:{deferred:true,kind:descriptor.kind??'object'});continue;}
    // Compressed source bytes are never presented as model-readable statistics.
    if(key==='data'&&value.encoding==='gzip-base64-json'){arrays.set((path?path+'.':'')+'data',{deferred:true,kind:'compressed_data'});continue;}
    fields(child,path?path+'.'+key:key,result,arrays,tables,rowIndex,basePath,parentIndex);
  }
  return {result,arrays};
}
function encodeStatisticsColumn(path,values){
  const keys=values.map(value=>JSON.stringify(value)),counts=new Map();let commonKey=null,maxCount=0,adjacent=false;
  for(let index=0;index<values.length;index++){const key=keys[index],entry=counts.get(key)??{value:values[index],count:0,index:counts.size,size:textEncoder.encode(key).byteLength};entry.count++;counts.set(key,entry);if(entry.count>maxCount){commonKey=key;maxCount=entry.count;}if(index&&key===keys[index-1])adjacent=true;}
  const common=counts.get(commonKey)?.value??(commonKey==='null'?null:MISSING);if(counts.size<=1)return [path,{default:common,changes:[]}];
  // Calculate candidate byte sizes without first allocating every dense,
  // sparse and run representation of a large column simultaneously.
  const comma=count=>Math.max(0,count-1);let denseContent=comma(values.length),dictionaryContent=comma(counts.size),indicesContent=comma(values.length),changesContent=0,changeCount=0;
  for(const entry of counts.values()){denseContent+=entry.count*entry.size;dictionaryContent+=entry.size;indicesContent+=entry.count*String(entry.index).length;}
  for(let index=0;index<values.length;index++)if(keys[index]!==commonKey){changesContent+=3+String(index).length+counts.get(keys[index]).size;changeCount++;}
  const sizes={values:bytes([path,{values:[]}])+denseContent,sparse:bytes([path,{default:common,changes:[]}])+changesContent+comma(changeCount),dictionary:bytes([path,{dictionary:[],indices:[]}])+dictionaryContent+indicesContent};
  let runs=null;if(adjacent){runs=[];let runContent=0;for(let index=0;index<values.length;index++){if(index&&keys[index]===keys[index-1])runs.at(-1)[1]++;else runs.push([values[index],1]);}for(const [value,count]of runs)runContent+=3+textEncoder.encode(JSON.stringify(value)).byteLength+String(count).length;sizes.runs=bytes([path,{runs:[]}])+runContent+comma(runs.length);}
  const kind=Object.keys(sizes).reduce((best,key)=>sizes[key]<sizes[best]?key:best,'sparse');
  if(kind==='values')return [path,{values}];if(kind==='runs')return [path,{runs}];if(kind==='dictionary')return [path,{dictionary:[...counts.values()].map(entry=>entry.value),indices:keys.map(key=>counts.get(key).index)}];
  const changes=[];for(let index=0;index<values.length;index++)if(keys[index]!==commonKey)changes.push([index,values[index]]);return [path,{default:common,changes}];
}
export function encodeStatisticsColumns(rows){
  const paths=new Set(rows.flatMap(row=>[...row.keys()]));return {row_count:rows.length,columns:[...paths].sort().map(path=>encodeStatisticsColumn(path,rows.map(row=>row.has(path)?row.get(path):MISSING)))};
}
function columnValues(column,count){
  if(!column)return Array(count).fill(MISSING);if(column.values)return column.values;
  const values=column.indices?column.indices.map(index=>column.dictionary[index]):column.runs?column.runs.flatMap(([value,length])=>Array(length).fill(value)):Array(count).fill(column.default);for(const [index,value]of column.changes??[])values[index]=value;return values;
}
// A column at a time, without allocating one Map per decoded row. This also
// handles highly compressible arrays whose readable row count is very large.
function mergeStatisticsColumns(sources){
  const count=sources.reduce((sum,source)=>sum+(source.indices?.length??source.table.row_count),0),paths=new Set();for(const source of sources){source.columns=new Map(source.table.columns);for(const path of source.columns.keys())paths.add(path);}
  const columns=[];for(const path of [...paths].sort()){
    const values=new Array(count);let next=0;
    for(const source of sources){const original=columnValues(source.columns.get(path),source.table.row_count);if(source.indices){for(const index of source.indices)values[next++]=source.remap?source.remap(path,original[index]):original[index];}else for(let index=0;index<original.length;index++)values[next++]=source.remap?source.remap(path,original[index]):original[index];}
    columns.push(encodeStatisticsColumn(path,values));
  }
  return {row_count:count,columns};
}
export function decodeStatisticsColumns(table){
  const rows=Array.from({length:table.row_count},()=>new Map());
  for(const [path,column]of table.columns){
    const values=column.values??(column.indices?column.indices.map(index=>column.dictionary[index]):column.runs?column.runs.flatMap(([value,count])=>Array(count).fill(value)):Array(table.row_count).fill(column.default));for(const [index,value]of column.changes??[])values[index]=value;
    for(let index=0;index<rows.length;index++){const value=values[index];if(!(value&&typeof value==='object'&&value.missing===true))rows[index].set(path,value);}
  }
  return rows;
}
function setField(root,path,value){if(!path)return value;const parts=path.split('.');let parent=root;for(let index=0;index<parts.length-1;index++){const key=parts[index];if(!Object.hasOwn(parent,key)||parent[key]===null||typeof parent[key]!=='object')parent[key]=/^\d+$/.test(parts[index+1])?[]:{};parent=parent[key];}parent[parts.at(-1)]=value;return root;}
function getField(root,path){let value=root;if(!path)return value;for(const key of path.split('.')){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
// Recreate the complete readable statistics view, including player rounds and
// replay outcomes. Dense unread arrays remain deferred at their original paths.
export function restoreStatisticsPack(pack){
  const scalarRows=table=>decodeStatisticsColumns(table).map(row=>{let value={};for(const [path,item]of row)value=setField(value,path,item);return value;});
  const roots={round:scalarRows(pack.round_statistics),match:scalarRows(pack.match_statistics)},tables=new Map(),tablePaths=new Map(),pendingDetails=[];
  for(const table of pack.technical_tables??[])tables.set(table.scope+':'+table.path,table);
  const join=(base,path)=>base&&path?base+'.'+path:base||path;
  const defer=(scope,rowIndex,path,count,observed=false)=>{
    const root=roots[scope][rowIndex];if(getField(root,path)!==undefined)return;
    if(observed&&count===0){setField(root,path,[]);return;}
    const parts=path.split('.'),key=parts.pop(),parentPath=parts.join('.');if(parentPath&&getField(root,parentPath)===undefined)setField(root,parentPath,{});
    const parent=parentPath?getField(root,parentPath):root;
    (parent._cs2_deferred??={})[key]={path:[...(scope==='round'?['rounds',String(rowIndex)]:[]),...path.split('.')],kind:typeof count==='number'?'array':count?.kind??'object',...(typeof count==='number'?{count}:{})};
  };
  const restoreTable=key=>{
    if(tablePaths.has(key))return tablePaths.get(key);const table=tables.get(key);if(!table)throw new BulkStatisticsError('statistics_pack_invalid');
    const parentPaths=table.parent_path?restoreTable(table.scope+':'+table.parent_path):null,values=decodeStatisticsColumns(table.statistics),details=decodeStatisticsColumns(table.detail_index),paths=[];
    for(let index=0;index<values.length;index++){
      const value=values[index],rowIndex=value.get('$row'),item=value.get('$index'),root=roots[table.scope]?.[rowIndex];
      if(!root||!Number.isSafeInteger(item)||item<0)throw new BulkStatisticsError('statistics_pack_invalid');
      const parentPath=parentPaths?.[value.get('$parent')];if(parentPaths&&parentPath===undefined)throw new BulkStatisticsError('statistics_pack_invalid');
      const path=table.parent_path?join(parentPath,table.path.slice(table.parent_path.length+1))+'.'+item:table.path+'.'+item;paths.push(path);
      let entry={};for(const [name,child]of value)if(!name.startsWith('$'))entry=setField(entry,name,child);setField(root,path,entry);
      for(const [name,count]of details[index])pendingDetails.push([table.scope,rowIndex,join(path,name),count,tables.has(table.scope+':'+join(table.path,name))]);
    }
    tablePaths.set(key,paths);return paths;
  };
  for(const key of tables.keys())restoreTable(key);
  for(const detail of pendingDetails)defer(...detail);
  for(const [scope,table]of [['round',pack.round_detail_index],['match',pack.match_detail_index]])for(const [index,details]of decodeStatisticsColumns(table).entries())for(const [path,count]of details)defer(scope,index,path,count,tables.has(scope+':'+path));
  for(const row of roots.round)for(const [alias,path]of Object.entries(pack.round_aliases??{}))setField(row,alias,structuredClone(getField(row,path)));
  const match=roots.match[0]??{};match.match_id=pack.match_id;match.rounds=roots.round;if(pack.detail_ref!=null)match.detail_ref=structuredClone(pack.detail_ref);return match;
}
// Retain the existing owner-round interface for callers that need only rows.
export function statisticsRoundRows(pack){return restoreStatisticsPack(pack).rounds;}
export function prepareStatisticsPack(match,{statisticsRef=null,detailRef=null}={}){
  if(!match||!Array.isArray(match.rounds)||match.rounds.length>100||new Set(match.rounds.map(row=>row.round_number)).size!==match.rounds.length||match.rounds.some(row=>!Number.isSafeInteger(row.round_number)||row.round_number<1||row.round_number>100))throw new BulkStatisticsError('statistics_unavailable');
  const aliases={};for(const key of ['aim','economy','positioning','utility'])if(match.rounds.length&&match.rounds.every(row=>Object.hasOwn(row,key)&&Object.hasOwn(row.analysis??{},key)&&same(row[key],row.analysis[key])))aliases[key]='analysis.'+key;
  const roundRows=[],roundArrays=[],roundTables=new Map(),matchTables=new Map();
  for(const [index,row]of match.rounds.entries()){const input={...row};for(const key of Object.keys(aliases))delete input[key];const {result,arrays}=fields(input,'',new Map(),new Map(),roundTables,index);roundRows.push(result);roundArrays.push(arrays);}
  const metadata={...match};for(const key of ['rounds','detail_ref','statistics_ref'])delete metadata[key];
  const meta=fields(metadata,'',new Map(),new Map(),matchTables),technicalTables=[];
  for(const [scope,tables]of [['round',roundTables],['match',matchTables]])for(const [path,table]of tables)technicalTables.push({scope,path,parent_path:table.parent_path,statistics:encodeStatisticsColumns(table.entries.map(entry=>entry.result)),detail_index:encodeStatisticsColumns(table.entries.map(entry=>entry.arrays))});
  const pack={version:BULK_STATISTICS_VERSION,match_id:match.match_id,statistics_ref:statisticsRef,detail_ref:detailRef??match.detail_ref??null,round_numbers:match.rounds.map(row=>row.round_number),round_evidence_refs:match.rounds.map(row=>row.evidence_id??`match:${match.match_id}:r${row.round_number}`),round_aliases:aliases,round_statistics:encodeStatisticsColumns(roundRows),round_detail_index:encodeStatisticsColumns(roundArrays),match_statistics:encodeStatisticsColumns([meta.result]),match_detail_index:encodeStatisticsColumns([meta.arrays]),technical_tables:technicalTables};
  if(bytes(pack)>BULK_STATISTICS_LIMITS.pack_bytes)throw new BulkStatisticsError('bulk_statistics_pack_too_large');return pack;
}
export function combineStatisticsPacks(entries,{source,scope,side='all',complete=true}={}){
  const matches=[],technicalTables=new Map(),roundOffsets=[],packTables=[],roundSources=[],roundDetailSources=[],matchSources=[],matchDetailSources=[];let totalRounds=0;
  const mapped=(mapping,index)=>mapping&&Number.isSafeInteger(index)&&index>=0&&index<mapping.source_count?(mapping.positions?mapping.positions[index]:mapping.start+index):undefined;
  const mapping=(start,count,indices=null)=>{const result={start,source_count:count,indices,count:indices?.length??count};if(indices){result.positions=[];for(let index=0;index<indices.length;index++)result.positions[indices[index]]=start+index;}return result;};
  for(const {pack,reference}of entries){
    const count=pack.round_statistics.row_count,sides=side==='all'?null:columnValues(new Map(pack.round_statistics.columns).get('side'),count),indices=sides?Array.from({length:count},(_,index)=>index).filter(index=>sides[index]===side):null,rowOffsets=mapping(totalRounds,count,indices);roundOffsets.push(rowOffsets);
    roundSources.push({table:pack.round_statistics,indices});roundDetailSources.push({table:pack.round_detail_index,indices});matchSources.push({table:pack.match_statistics});matchDetailSources.push({table:pack.match_detail_index});
    const byPath=new Map();for(const table of pack.technical_tables??[]){const key=table.scope+':'+table.path;byPath.set(key,table);if(!technicalTables.has(key))technicalTables.set(key,{scope:table.scope,path:table.path,parent_path:table.parent_path});}packTables.push(byPath);
    matches.push({match_id:pack.match_id,round_offset:totalRounds,round_count:rowOffsets.count,rounds_observed:count,query_evidence_ref:reference,statistics_ref:pack.statistics_ref,detail_ref:pack.detail_ref,round_aliases:pack.round_aliases});totalRounds+=rowOffsets.count;
  }
  const roundStatistics=mergeStatisticsColumns(roundSources),matchStatistics=mergeStatisticsColumns(matchSources),roundDetailIndex=mergeStatisticsColumns(roundDetailSources),matchDetailIndex=mergeStatisticsColumns(matchDetailSources);
  const combinedTables=[],parentOffsets=new Map();
  const ordered=[],visited=new Set(),visiting=new Set(),visit=key=>{if(visited.has(key))return;if(visiting.has(key)||!technicalTables.has(key))throw new BulkStatisticsError('statistics_pack_invalid');visiting.add(key);const table=technicalTables.get(key);if(table.parent_path)visit(table.scope+':'+table.parent_path);visiting.delete(key);visited.add(key);ordered.push([key,table]);};for(const key of technicalTables.keys())visit(key);
  for(const [key,definition]of ordered){
    const sources=[],detailSources=[],offsetsByPack=[];parentOffsets.set(key,offsetsByPack);let count=0;
    for(let packIndex=0;packIndex<entries.length;packIndex++){
      const table=packTables[packIndex].get(key);if(!table){offsetsByPack.push(null);continue;}
      const parent=table.parent_path?parentOffsets.get(table.scope+':'+table.parent_path)?.[packIndex]:null,columns=new Map(table.statistics.columns);let indices=null;
      if(side!=='all'&&table.scope==='round'){
        const roots=columnValues(columns.get('$row'),table.statistics.row_count),parents=parent?columnValues(columns.get('$parent'),table.statistics.row_count):null;indices=[];
        for(let index=0;index<table.statistics.row_count;index++)if(mapped(roundOffsets[packIndex],roots[index])!==undefined&&(!parents||mapped(parent,parents[index])!==undefined))indices.push(index);
      }
      const offsets=mapping(count,table.statistics.row_count,indices);offsetsByPack.push(offsets);count+=offsets.count;
      const remap=(path,value)=>path==='$row'?(table.scope==='round'?mapped(roundOffsets[packIndex],value):packIndex):path==='$parent'&&parent?mapped(parent,value):value;
      sources.push({table:table.statistics,indices,remap});detailSources.push({table:table.detail_index,indices});
    }
    combinedTables.push({...definition,statistics:mergeStatisticsColumns(sources),detail_index:mergeStatisticsColumns(detailSources)});
  }
  const result={version:BULK_STATISTICS_VERSION,format:'sparse_columns_json',source,scope,side,complete,scalar_coverage:{match_metadata:true,owner_rounds:true,other_player_statistics:true,replay_metadata_and_round_results:true,technical_observations:true,raw_arrays_read:false,deferred_array_names:[...rawArrays]},match_count:new Set(entries.map(entry=>entry.pack.match_id)).size,segment_count:entries.length,matches,round_statistics:roundStatistics,match_statistics:matchStatistics,technical_tables:combinedTables,raw_detail_index:{read:false,rounds:roundDetailIndex,matches:matchDetailIndex,locator:{round:{resource:'inspect',scope:'round',match_id:'matches entry covering the row',round_number:'round_statistics.round_number',path:'column path split on dot; numeric segments are array indexes',offset:0,limit:100},match:{resource:'inspect',scope:'match',match_id:'matching matches entry',path:'column path split on dot',offset:0,limit:100}},note:'Counts and deferred descriptors index arrays. Technical array scalars are in technical_tables; only their geometry/event subarrays remain unread. No raw event/frame coverage is inferred. Use read_data_batch for multiple actual windows; follow each returned pagination/window.'},encoding:{rows:'Round rows are concatenated in matches order. Match rows use matches order.',columns:'Each [path,column] contains values, default plus [row_index,value] changes, dictionary plus indices, or runs of [literal_value,count]. {missing:true} means absent, not null. Every other value is a literal scalar.',technical_tables:'A table contains every scalar of each original array entry. $row points to its round or match row, $index is the original array index. For nested arrays, parent_path names the parent table and $parent points to its row; reconstruct the original path by inserting each parent $index. Numeric path segments are array indexes.',aliases:'For each match, round_aliases maps an exactly equal original subtree to its retained path; applies to statistics and detail indexes.'}};
  result.input_bytes=bytes(result);if(result.input_bytes>BULK_STATISTICS_LIMITS.input_bytes)throw new BulkStatisticsError('bulk_statistics_input_too_large');return result;
}
// Batches bound both object count and declared decoded source bytes. The caller
// serializes session checkpoints; only source/cache I/O runs concurrently.
export function statisticsLoadBatch(targets,start){
  const batch=[];let size=0;for(const target of targets.slice(start)){const next=target.statistics_ref?.decoded_bytes??0;if(next>BULK_STATISTICS_LIMITS.inflight_source_bytes){if(batch.length)break;throw new BulkStatisticsError('statistics_source_too_large');}if(batch.length&&(batch.length>=BULK_STATISTICS_LIMITS.concurrency||size+next>BULK_STATISTICS_LIMITS.inflight_source_bytes))break;batch.push(target);size+=next;if(size>=BULK_STATISTICS_LIMITS.inflight_source_bytes)break;}return batch;
}
