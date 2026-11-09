/** Declarative Agent visuals. This module never executes model JavaScript or HTML. */
export const AGENT_VISUAL_LIMITS=Object.freeze({specBytes:32768,dataBytes:65536,visuals:2,controls:8,selectOptions:256,nodes:160,renderedNodes:2000,expressionLength:512,expressionDepth:16,expressionSteps:12000,array:1000});
const PROTOTYPE_KEYS=new Set(['__proto__','prototype','constructor','caller','callee','arguments','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__']);
// Ambient identifiers are forbidden at expression roots. Equally named JSON fields
// (for example a native capture's tick window) carry no browser or process authority.
const FORBIDDEN=new Set([...PROTOTYPE_KEYS,'eval','globalThis','window','document','process','Function']);
const NAME=/^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const TAGS=['div','section','p','span','strong','em','small','h3','h4','figure','figcaption','table','thead','tbody','tr','th','td','ul','ol','li','button','svg','g','path','line','polyline','polygon','circle','ellipse','rect','text','tspan','title'];
const SVG_TAGS=new Set(['svg','g','path','line','polyline','polygon','circle','ellipse','rect','text','tspan','title']);
const ATTRS=new Set(['viewBox','preserveAspectRatio','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-dasharray','stroke-linecap','stroke-linejoin','opacity','fill-opacity','stroke-opacity','transform','text-anchor','dominant-baseline','font-size','font-weight','role','aria-label','colspan','rowspan','scope']);
const STYLES=new Set(['display','grid-template-columns','grid-template-rows','gap','row-gap','column-gap','align-items','justify-content','flex-direction','flex-wrap','flex','width','height','min-width','max-width','min-height','max-height','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','color','background-color','border','border-color','border-width','border-style','border-radius','font-size','font-weight','font-family','line-height','text-align','white-space','overflow','overflow-x','overflow-y','opacity','aspect-ratio']);
const ACTIONS=['open_evidence','open_match','open_round','open_aim','open_replay','request_render'];
const scalar={anyOf:[{type:'string'},{type:'number'},{type:'boolean'}]},nullableNumber={anyOf:[{type:'number'},{type:'null'}]},nullableString={anyOf:[{type:'string'},{type:'null'}]};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const pairs=names=>({type:'array',maxItems:24,items:object({name:{type:'string',enum:[...names]},value:{anyOf:[{type:'string'},{type:'number'}]}})});
const bindingIdentity={name:{type:'string'},evidence_ref:{type:'string'}};
const bindingPath={anyOf:[{type:'array',minItems:1,maxItems:12,items:{type:'string',minLength:1,maxLength:160}},{type:'null'}]};
/** Bounded shape feedback. Paths and expected fields come only from our schema;
 * unknown keys, rejected values and expression text never enter an issue. */
export function inspectAgentJsonSchema(value,schema,{path='value',maxIssues=8}={}){
  const issues=[],limit=Number.isInteger(maxIssues)?Math.max(1,Math.min(16,maxIssues)):8;let visits=0,truncated=false;
  const add=(code,path,extra={})=>{if(issues.length>=limit){truncated=true;return;}issues.push({code,path:path.slice(0,220),...extra});};
  const typeOf=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
  const matches=(value,type)=>type==='integer'?Number.isSafeInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):typeOf(value)===type;
  const visit=(item,definition,current,depth)=>{
    if(++visits>10000||depth>24){add('complexity_limit',current);truncated=true;return;}
    if(issues.length>=limit){truncated=true;return;}
    if(definition.anyOf){
      const compatible=definition.anyOf.filter(option=>option.type&&matches(item,option.type));
      if(compatible.length===1)return visit(item,compatible[0],current,depth+1);
      if(compatible.length){
        // Nullable schemas normally have one compatible type. Object unions
        // must try their actual shapes rather than rejecting a valid later arm.
        let best=null;for(const option of compatible){const start=issues.length,wasTruncated=truncated;visit(item,option,current,depth+1);const branch=issues.splice(start),branchTruncated=truncated;truncated=wasTruncated;if(!branch.length&&!branchTruncated)return;const shapeCost=option.type==='object'?Object.keys(Object.getOwnPropertyDescriptors(item)).filter(key=>!Object.hasOwn(option.properties??{},key)).length+(option.required??[]).filter(key=>!Object.hasOwn(item,key)).length:0;if(!best||branch.length<best.issues.length||branch.length===best.issues.length&&shapeCost<best.shapeCost)best={issues:branch,truncated:branchTruncated,shapeCost};if(visits>10000)break;}for(const issue of best.issues)if(issues.length<limit)issues.push(issue);truncated||=best.truncated;return;
      }
      add('type',current,{expected:definition.anyOf.map(option=>option.type??'value').join(' | '),actual_type:typeOf(item)});return;
    }
    if(definition.type&&!matches(item,definition.type)){add('type',current,{expected:definition.type,actual_type:typeOf(item)});return;}
    if(definition.enum&&!definition.enum.includes(item))add('enum',current,{allowed_values:definition.enum});
    if(typeof item==='string'){
      if(definition.minLength!=null&&item.trim().length<definition.minLength)add('min_length',current,{limit:definition.minLength});
      if(definition.maxLength!=null&&item.length>definition.maxLength)add('max_length',current,{limit:definition.maxLength});
    }
    if(typeof item==='number'){
      if(definition.minimum!=null&&item<definition.minimum)add('minimum',current,{limit:definition.minimum});
      if(definition.maximum!=null&&item>definition.maximum)add('maximum',current,{limit:definition.maximum});
    }
    if(Array.isArray(item)){
      const descriptors=Object.getOwnPropertyDescriptors(item),length=descriptors.length?.value??0;
      if(definition.minItems!=null&&length<definition.minItems)add('min_items',current,{limit:definition.minItems});
      if(definition.maxItems!=null&&length>definition.maxItems)add('max_items',current,{limit:definition.maxItems});
      for(let index=0;index<Math.min(length,1000)&&issues.length<limit;index++){
        const descriptor=descriptors[index];if(!descriptor||!Object.hasOwn(descriptor,'value')){add('type',`${current}.${index}`,{expected:'JSON value',actual_type:'accessor'});continue;}
        if(definition.items)visit(descriptor.value,definition.items,`${current}.${index}`,depth+1);
      }
      if(length>1000){add('complexity_limit',current,{limit:1000});truncated=true;}
    }else if(item!==null&&typeof item==='object'){
      const descriptors=Object.getOwnPropertyDescriptors(item),properties=definition.properties??{},allowed=Object.keys(properties);
      for(const key of definition.required??[])if(!Object.hasOwn(descriptors,key))add('required',`${current}.${key}`);
      if(definition.additionalProperties===false&&Object.keys(descriptors).some(key=>!Object.hasOwn(properties,key)))add('additional_property',current,{allowed_fields:allowed});
      for(const key of allowed){const descriptor=descriptors[key];if(!descriptor)continue;if(!Object.hasOwn(descriptor,'value')){add('type',`${current}.${key}`,{expected:'JSON value',actual_type:'accessor'});continue;}visit(descriptor.value,properties[key],`${current}.${key}`,depth+1);}
    }
  };
  try{visit(value,schema,path,0);}catch{add('invalid_json_value',path);}
  return {valid:issues.length===0&&!truncated,issues,truncated};
}
export const AGENT_VISUAL_DOCUMENT_SCHEMA=object({
  version:{type:'integer',enum:[1]},kind:{type:'string',enum:['illustration','observed']},assumptions:{type:'array',items:{type:'string'}},
  dataBindings:{type:'array',maxItems:8,items:{anyOf:[object(bindingIdentity),object({...bindingIdentity,path:bindingPath})]}},
  params:{type:'array',maxItems:AGENT_VISUAL_LIMITS.controls,items:object({name:{type:'string'},type:{type:'string',enum:['range','select','toggle']},label:{type:'string'},value:scalar,min:nullableNumber,max:nullableNumber,step:nullableNumber,options:{type:'array',maxItems:AGENT_VISUAL_LIMITS.selectOptions,items:object({label:{type:'string'},value:{anyOf:[{type:'string'},{type:'number'}]}})}})},
  lets:{type:'array',maxItems:24,items:object({name:{type:'string'},expr:{type:'string'}})},
  nodes:{type:'array',maxItems:AGENT_VISUAL_LIMITS.nodes,items:object({id:{type:'string'},parent:nullableString,tag:{type:'string',enum:TAGS},attrs:pairs(ATTRS),style:pairs(STYLES),text:nullableString,bindings:{type:'array',maxItems:16,items:object({target:{type:'string'},expr:{type:'string'}})},when:nullableString,repeat:{anyOf:[object({expr:{type:'string'},as:{type:'string'},index:{type:'string'}}),{type:'null'}]},action:nullableString})},
  actions:{type:'array',maxItems:8,items:object({id:{type:'string'},label:{type:'string'},kind:{type:'string',enum:ACTIONS},evidence_ref:{type:'string'}})}
});
export function inspectAgentVisualCandidate(candidate,{path='visualizations.0'}={}){
  const shape=object({title:{type:'string',minLength:1,maxLength:160},description:{type:'string',maxLength:800},evidence_refs:{type:'array',maxItems:16,items:{type:'string',minLength:1,maxLength:240}},document:AGENT_VISUAL_DOCUMENT_SCHEMA});
  const result=inspectAgentJsonSchema(candidate,shape,{path});if(!result.valid)return result;
  const cited=new Set();for(let index=0;index<candidate.evidence_refs.length;index++){
    const reference=candidate.evidence_refs[index];if(cited.has(reference))return {valid:false,issues:[{code:'unique_items',path:`${path}.evidence_refs.${index}`,expected:'List each visualization citation once. Multiple data bindings or actions may reuse that same listed citation; remove only the repeated list entry, preserving the bindings, actions and graph.'}],truncated:false};cited.add(reference);
  }
  if(!validateAgentVisualDocument(candidate.document)){
    const first=inspectDocumentConstraint(candidate.document,`${path}.document`);
    // One invalid formula should not hide the remaining repairable formula
    // errors until another paid model round. Keep shape/declaration ordering,
    // then provide bounded static expression feedback in document order.
    if(/\.(?:expr|when)$/.test(first.path))return {valid:false,...inspectDocumentExpressions(candidate.document,`${path}.document`)};
    return {valid:false,issues:[first],truncated:false};
  }
  if(bytes(candidate)>AGENT_VISUAL_LIMITS.specBytes)return {valid:false,issues:[{code:'max_bytes',path,limit:AGENT_VISUAL_LIMITS.specBytes}],truncated:false};
  return result;
}
export const AGENT_VISUAL_GUIDANCE=`交互文档语法：只输出 Schema 中的声明式 JSON，不写 HTML 字符串、JavaScript、URL、网络请求或代码块。HTML/SVG 基础节点可自由组合为本次问题需要的图解，而非挑选固定卡片。节点 parent 必须引用前面节点 id；SVG 图形放在 svg 节点内。attrs/style 是 {name,value} 数组，bindings 是 {target,expr} 数组，target 为 text、attr:cx、attr:d、style:opacity 等。无值字段使用 null 或 []。
表达式只读作用域：params.<参数名>、vars.<let 名>、data.<dataBinding 名> 是服务器本次实际查询的完整响应（通常有 items/source）。参数、let 和数据名用英文字母开头的字母数字下划线，节点 id 还可用连字符。lets 依次求值；repeat:{expr:'data.samples.items',as:'item',index:'index'} 为该节点和子树建立逐行作用域；when 是布尔表达式。支持数值/字符串/布尔/null、数组、字段/索引、+ - * / %、比较、&& || ??、条件 ? :。辅助函数 min/max(数值参数或数组及可选字段名)、abs/round(value,decimals)/floor/ceil/sqrt/pow/sin/cos/tan/atan2/log/exp/clamp/lerp/len、sum/avg(array,可选字段名)、column(array,字段名)、where(array,字段名,相等值)、take(array,数量)、slice(array,起点,终点)、sortBy(array,字段名,'asc'或'desc')、linePath(array,x字段名,y字段名,x比例,y比例,x偏移,y偏移)。不能使用对象方法、Math、箭头函数、map/filter、toFixed 或赋值。小数显示用 round(value,decimals)，筛选用 where(array,字段名,相等值)。单条表达式最多 512 字符、16 层；重复计算或长条件应拆成按顺序求值的 lets，再引用 vars.<名称>，不要反复复制整个公式。修复反馈的 expected 会给出具体语法原因，并在可以定位时给出从 0 开始的字符位置；该位置指向未通过校验的原表达式。
同一 visualizations.evidence_refs 中每条引用只列一次；多个绑定或动作可以复用它，不能为去重删除图解或绑定。
params 的 type 为 range/select/toggle。range 用数值 value/min/max/step，options:[]；select 用字符串或数值 value，min/max/step:null，options:[{label,value}]；toggle 用布尔 value，其余数值:null，options:[]。控件变化会重新计算 lets 和所有绑定，无需额外代码。
服务器会先按默认参数求值全部 lets、repeat、when 和 bindings。text 绑定必须得到标量，repeat 必须得到数组，数值属性必须得到实际数值；缺失字段返回 null，应按真实缺口处理，不能用 0 冒充观测。默认值也须避开除零、无效函数参数及越过渲染预算的重复展开。
配色应适应宿主深色和浅色主题。普通 HTML 文字继承 color；SVG text/tspan 的普通标签用 fill:'currentColor'，未声明也未继承显式 fill 时运行时也以 currentColor 跟随文字前景。不要把普通文字固定为黑色或白色；fill/stroke 不支持 CSS var()。系列与状态保留明确语义色；自设面板背景时同时设置对比清晰的文字色，检查数值、轴标签和图例在实际背景及图形上均可读。
自定义图解最小例：document={version:1,kind:'illustration',assumptions:['滑块调整的是解释用假设角度，非实测瞄准。'],dataBindings:[],params:[{name:'angle',type:'range',label:'假设角度（度）',value:20,min:0,max:90,step:1,options:[]}],lets:[{name:'x',expr:'100 + 75 * cos(params.angle * 0.017453293)'},{name:'y',expr:'90 - 75 * sin(params.angle * 0.017453293)'}],nodes:[{id:'diagram',parent:null,tag:'svg',attrs:[{name:'viewBox',value:'0 0 220 110'}],style:[],text:null,bindings:[],when:null,repeat:null,action:null},{id:'ray',parent:'diagram',tag:'line',attrs:[{name:'x1',value:100},{name:'y1',value:90},{name:'stroke',value:'currentColor'}],style:[],text:null,bindings:[{target:'attr:x2',expr:'vars.x'},{target:'attr:y2',expr:'vars.y'}],when:null,repeat:null,action:null},{id:'label',parent:'diagram',tag:'text',attrs:[{name:'x',value:5},{name:'y',value:18}],style:[],text:null,bindings:[{target:'text',expr:"'假设角度 ' + params.angle + '°'"}],when:null,repeat:null,action:null}],actions:[]}。可将该自由图解改造成问题所需的多个图层、曲线、可调解释或实测数据视图。observed 文档必须通过 dataBindings:[{name:'samples',evidence_ref:'本次真实引用'}] 使用真实查询结果，不能把编造值写成实测；说明性几何必须标为 illustration 并声明假设。统计图优先显式绑定 {name:'samples',evidence_ref:'精确计算引用',path:['items']}，此时 data.samples 本身是行数组，使用 data.samples[0].字段或 repeat.expr='data.samples'，不能继续访问 data.samples.items。省略 path 或填 null 维持完整结果；其他所需元数据应另起具名绑定和精确路径。全部绑定合计仍须不超过 65536 字节。actions 只定义引用证据的站内动作，按钮 node.action 指定其 id，只有用户点击才会执行。
预算：默认 1 个，最多 2 个文档；每个 32 KiB、8 个参数、160 个节点；每个 select 最多 ${AGENT_VISUAL_LIMITS.selectOptions} 个选项；数据 64 KiB，表达式 512 字符/16 层，实际渲染最多 2000 节点。优先 3–12 节点和 1–3 参数；只为有解释价值的问题生成控件。`;
const own=(obj,key)=>obj!==null&&typeof obj==='object'&&Object.hasOwn(obj,key);
const keys=(obj,names)=>!!obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).length===names.length&&names.every(key=>Object.hasOwn(obj,key));
const safeName=name=>typeof name==='string'&&NAME.test(name)&&!FORBIDDEN.has(name)&&!['data','params','vars','item','index'].includes(name);
const safeId=name=>typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name)&&!FORBIDDEN.has(name);
const string=(value,max=1000,empty=true)=>typeof value==='string'&&value.length<=max&&(empty||value.trim().length>0);
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const fail=()=>{throw new Error('Invalid Agent visual document');};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
const cleanScalar=value=>(typeof value==='string'&&value.length<=4096)||finite(value)||typeof value==='boolean'||value===null;
function cloneData(value,state={steps:0,depth:0}){
  if(++state.steps>18000||state.depth>24)fail();
  if(cleanScalar(value))return value;
  const isArray=Array.isArray(value);
  if(!value||typeof value!=='object'||!(isArray?[Array.prototype]:[Object.prototype,null]).includes(Object.getPrototypeOf(value)))fail();
  const descriptors=Object.getOwnPropertyDescriptors(value),entries=Object.entries(descriptors);
  for(const [key,descriptor] of entries)if(PROTOTYPE_KEYS.has(key)||!string(key,160)||!Object.hasOwn(descriptor,'value'))fail();
  if(isArray){
    const length=descriptors.length.value;if(length>AGENT_VISUAL_LIMITS.array||entries.length!==length+1)fail();
    const result=[];state.depth++;for(let i=0;i<length;i++){if(!Object.hasOwn(descriptors,String(i)))fail();result.push(cloneData(descriptors[i].value,state));}state.depth--;return result;
  }
  if(entries.length>300)fail();const result={};state.depth++;
  for(const [key,descriptor] of entries)result[key]=cloneData(descriptor.value,state);state.depth--;return result;
}
function bindingPathCopy(path){
  if(path==null)return null;if(!Array.isArray(path)||Object.getPrototypeOf(path)!==Array.prototype)fail();const descriptors=Object.getOwnPropertyDescriptors(path),length=descriptors.length.value;if(length<1||length>12||Object.keys(descriptors).length!==length+1)fail();const result=[];for(let index=0;index<length;index++){const descriptor=descriptors[index],key=descriptor?.value;if(!descriptor||!Object.hasOwn(descriptor,'value')||!string(key,160,false)||PROTOTYPE_KEYS.has(key)||/[\u0000-\u001f]/.test(key))fail();result.push(key);}return result;
}
const bindingPathValid=path=>{try{bindingPathCopy(path);return true;}catch{return false;}};
const bindingValid=binding=>(keys(binding,['name','evidence_ref'])||keys(binding,['name','evidence_ref','path'])&&binding.path!==undefined)&&safeName(binding.name)&&string(binding.evidence_ref,240,false)&&bindingPathValid(binding.path);
function ownDataDescriptor(value,key){
  if(!value||typeof value!=='object'||!(Array.isArray(value)?[Array.prototype]:[Object.prototype,null]).includes(Object.getPrototypeOf(value)))fail();
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor&&!Object.hasOwn(descriptor,'value'))fail();return descriptor;
}
function bindingSource(source){
  if(source==null)return null;const result={};
  for(const key of ['source_revision','generated_at','content_sha256']){const value=ownDataDescriptor(source,key)?.value??null;if(value!==null&&!string(value,240))fail();result[key]=value;}
  return result;
}
// A declared projection is an exact subtree of the immutable query result.
// Never execute getters, follow prototypes, flatten arrays or silently prune it.
export function projectAgentVisualBindingData(result,path=null){
  const segments=bindingPathCopy(path);let selected=result;
  for(const key of segments??[]){let descriptor;try{descriptor=ownDataDescriptor(selected,key);}catch{const error=new Error('Invalid Agent visual data path');error.visual_data_code='data_path_invalid';throw error;}if(!descriptor){const error=new Error('Invalid Agent visual data path');error.visual_data_code='data_path_invalid';throw error;}selected=descriptor.value;}
  return cloneData(selected);
}

// Pratt parser: calls can target only the explicit helper table, members are reads only.
const PRECEDENCE={'??':1,'||':2,'&&':3,'==':4,'!=':4,'===':4,'!==':4,'<':5,'>':5,'<=':5,'>=':5,'+':6,'-':6,'*':7,'/':7,'%':7};
const compiled=new Map();
const EXPRESSION_FAILURES=Object.freeze({
  empty:'Use a nonempty expression from the documented grammar.',
  length:'Expression exceeds 512 characters. Factor repeated calculations into sequential lets and reference vars instead of repeating them.',
  number:'Numeric literals must be finite and have absolute value at most 1e12.',
  escape:'String escapes are limited to newline, carriage return, tab, backslash and the two quote characters.',
  string:'Close the quoted string with the matching quote; template literals are unavailable.',
  forbidden_name:'Prototype keys and ambient browser/process identifiers are unavailable.',
  token:'Unsupported syntax. Use literals, field/index reads, documented operators and helpers; no objects, assignment, arrows, optional chaining or template literals.',
  tokens:'Expression exceeds 256 tokens. Factor repeated calculations into sequential lets.',
  depth:'Expression exceeds 16 nesting levels. Split deeply nested conditions or arithmetic into sequential lets.',
  operand:'Expected a literal, identifier, helper call, array or parenthesized expression; every operator needs an operand.',
  helper:'Call only documented helpers such as round, min, max, where, column, sum, avg and len; arbitrary functions are unavailable.',
  arguments:'A helper accepts at most 8 arguments. Move intermediate values into sequential lets.',
  array:'An array literal accepts at most 32 elements. Bind observed rows or use a documented array helper.',
  close_parenthesis:'Expected a closing parenthesis. Check helper argument separators and grouped expressions.',
  close_bracket:'Expected a closing bracket after an array literal or index expression.',
  conditional:'Expected a colon between the true and false branches of a conditional expression.',
  member:'A dotted field read requires an allowed identifier. Use brackets for a computed field/index; prototype keys are unavailable.',
  method:'Object methods and Math calls are unavailable. Use round(value, decimals) instead of toFixed, abs(value) instead of Math.abs, and where/column instead of filter/map.',
  trailing:'Unexpected trailing syntax. Use documented operators between values; calls target only the documented standalone helpers.',
  complexity:'Expression exceeds its 256-node syntax budget. Split repeated work into sequential lets.',
});
export function compileAgentVisualExpression(expression){
  const reject=(code,offset)=>{const error=new Error('Invalid Agent visual expression');error.visual_expression_code=code;if(Number.isSafeInteger(offset))error.visual_expression_offset=Math.max(0,Math.min(typeof expression==='string'?expression.length:0,offset));throw error;};
  if(typeof expression!=='string'||!expression.trim())reject('empty');
  if(expression.length>AGENT_VISUAL_LIMITS.expressionLength)reject('length',AGENT_VISUAL_LIMITS.expressionLength);
  if(compiled.has(expression))return compiled.get(expression);
  const tokens=[];let position=0;
  while(position<expression.length){
    const start=position,rest=expression.slice(position);if(/^\s/.test(rest)){position++;continue;}
    const number=/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if(number){const value=Number(number[0]);if(!finite(value))reject('number',start);tokens.push({type:'literal',value,offset:start});position+=number[0].length;continue;}
    if(rest[0]==='"'||rest[0]==="'"){
      const quote=rest[0];let value='',closed=false;position++;
      while(position<expression.length){let char=expression[position++];if(char===quote){closed=true;break;}if(char==='\\'){char=expression[position++];const escapes={n:'\n',r:'\r',t:'\t','\\':'\\','"':'"',"'":"'"};if(!Object.hasOwn(escapes,char))reject('escape',position-1);char=escapes[char];}value+=char;}
      if(!closed)reject('string',start);tokens.push({type:'literal',value,offset:start});continue;
    }
    const identifier=/^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if(identifier){const name=identifier[0];if(PROTOTYPE_KEYS.has(name))reject('forbidden_name',start);tokens.push(['true','false','null'].includes(name)?{type:'literal',value:{true:true,false:false,null:null}[name],offset:start}:{type:'name',value:name,offset:start});position+=name.length;continue;}
    const op=/^(?:===|!==|==|!=|<=|>=|&&|\|\||\?\?|[+\-*/%<>()\[\].,?:!])/.exec(rest);if(!op)reject('token',start);tokens.push({type:'op',value:op[0],offset:start});position+=op[0].length;
  }
  if(tokens.length>256)reject('tokens',tokens[256].offset);let index=0;
  const offset=()=>tokens[index]?.offset??expression.length;
  const peek=value=>tokens[index]?.value===value;
  const expect=value=>{if(!peek(value))reject(value===')'?'close_parenthesis':value===']'?'close_bracket':value===':'?'conditional':'token',offset());index++;};
  function parse(min=0,depth=0){
    if(depth>AGENT_VISUAL_LIMITS.expressionDepth)reject('depth',offset());let token=tokens[index++],node;if(!token)reject('operand',expression.length);
    if(token.type==='literal')node={type:'literal',value:token.value};
    else if(token.type==='name'){
      if(FORBIDDEN.has(token.value))reject('forbidden_name',token.offset);
      if(peek('(')){
        if(!Object.hasOwn(HELPERS,token.value))reject('helper',token.offset);index++;const args=[];
        if(!peek(')')){do{if(args.length>=8)reject('arguments',offset());args.push(parse(0,depth+1));if(!peek(','))break;index++;}while(true);}expect(')');node={type:'call',name:token.value,args};
      }else node={type:'name',name:token.value};
    }else if(token.value==='('){node=parse(0,depth+1);expect(')');}
    else if(['!','+','-'].includes(token.value))node={type:'unary',op:token.value,value:parse(8,depth+1)};
    else if(token.value==='['){const values=[];if(!peek(']')){do{if(values.length>=32)reject('array',offset());values.push(parse(0,depth+1));if(!peek(','))break;index++;}while(true);}expect(']');node={type:'array',values};}
    else reject('operand',token.offset);
    while(index<tokens.length){
      if(peek('.')){index++;const key=tokens[index++];if(key?.type!=='name'||PROTOTYPE_KEYS.has(key.value))reject('member',key?.offset??expression.length);node={type:'member',value:node,key:{type:'literal',value:key.value}};continue;}
      if(peek('[')){index++;const key=parse(0,depth+1);expect(']');node={type:'member',value:node,key};continue;}
      if(peek('(')&&node.type==='member')reject('method',offset());
      const op=tokens[index]?.value,p=PRECEDENCE[op];if(p===undefined||p<min)break;index++;node={type:'binary',op,left:node,right:parse(p+1,depth+1)};
    }
    if(min===0&&peek('?')){index++;const yes=parse(0,depth+1);expect(':');const no=parse(0,depth+1);node={type:'ternary',condition:node,yes,no};}
    return node;
  }
  const tree=parse();if(index!==tokens.length)reject('trailing',offset());
  let count=0;function check(node,depth=0){if(depth>AGENT_VISUAL_LIMITS.expressionDepth)reject('depth');if(++count>256)reject('complexity');for(const child of Object.values(node)){if(child&&typeof child==='object'){if(Array.isArray(child))for(const part of child)check(part,depth+1);else check(child,depth+1);}}}check(tree);
  if(compiled.size>=300)compiled.delete(compiled.keys().next().value);compiled.set(expression,tree);return tree;
}
function field(value,key){
  if((typeof key!=='string'&&typeof key!=='number')||PROTOTYPE_KEYS.has(String(key)))fail();
  if(Array.isArray(value)){if(key==='length')return value.length;const index=Number(key);if(!Number.isInteger(index)||index<0||index>=value.length)return null;key=String(index);}
  if(typeof value==='string'&&key==='length')return value.length;
  if(!own(value,key))return null;const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!Object.hasOwn(descriptor,'value'))fail();return descriptor.value;
}
function array(value){if(!Array.isArray(value)||value.length>AGENT_VISUAL_LIMITS.array)fail();return value;}
function num(value){if(!finite(value))fail();return value;}
function values(value,key=null){return array(value).map(item=>num(key===null?item:field(item,key)));}
function charge(state,amount=1){state.steps+=amount;if(state.steps>state.limit)throw new Error('Agent visual expression budget exceeded');}
function extremum(state,args,fn){const v=Array.isArray(args[0])?values(args[0],args[1]??null):args.map(num);if(Array.isArray(args[0])&&args.length>2)fail();charge(state,v.length);return v.length?fn(...v):null;}
const HELPERS={
  min:(s,...args)=>extremum(s,args,Math.min),max:(s,...args)=>extremum(s,args,Math.max),abs:(s,a)=>Math.abs(num(a)),round:(s,a,d=0)=>{num(d);if(!Number.isInteger(d)||d<0||d>6)fail();const p=10**d;return Math.round(num(a)*p)/p;},floor:(s,a)=>Math.floor(num(a)),ceil:(s,a)=>Math.ceil(num(a)),sqrt:(s,a)=>Math.sqrt(num(a)),pow:(s,a,b)=>Math.pow(num(a),num(b)),sin:(s,a)=>Math.sin(num(a)),cos:(s,a)=>Math.cos(num(a)),tan:(s,a)=>Math.tan(num(a)),atan2:(s,a,b)=>Math.atan2(num(a),num(b)),log:(s,a)=>Math.log(num(a)),exp:(s,a)=>Math.exp(num(a)),clamp:(s,a,lo,hi)=>Math.min(num(hi),Math.max(num(lo),num(a))),lerp:(s,a,b,t)=>num(a)+(num(b)-num(a))*num(t),
  len:(s,a)=>typeof a==='string'?a.length:array(a).length,
  sum:(s,a,key=null)=>{const v=values(a,key);charge(s,v.length);return v.reduce((sum,value)=>sum+value,0);},avg:(s,a,key=null)=>{const v=values(a,key);charge(s,v.length);return v.length?v.reduce((sum,value)=>sum+value,0)/v.length:null;},
  column:(s,a,key)=>{const v=array(a);charge(s,v.length);return v.map(item=>field(item,key));},
  where:(s,a,key,value)=>{const v=array(a);charge(s,v.length);return v.filter(item=>field(item,key)===value);},
  take:(s,a,count)=>{const v=array(a);return v.slice(0,Math.max(0,Math.min(v.length,Math.floor(num(count)))));},slice:(s,a,start,end)=>array(a).slice(Math.floor(num(start)),end===undefined?undefined:Math.floor(num(end))),
  sortBy:(s,a,key,direction='asc')=>{const v=array(a);charge(s,v.length*Math.ceil(Math.log2(v.length+1)));return [...v].sort((left,right)=>{const a=field(left,key),b=field(right,key);if(!cleanScalar(a)||!cleanScalar(b))fail();return (a>b?1:a<b?-1:0)*(direction==='desc'?-1:1);});},
  linePath:(s,a,xKey='x',yKey='y',sx=1,sy=1,ox=0,oy=0)=>{const v=array(a);charge(s,v.length*2);[sx,sy,ox,oy].forEach(num);return v.map((point,i)=>`${i?'L':'M'}${num(field(point,xKey))*sx+ox},${num(field(point,yKey))*sy+oy}`).join(' ');}
};
export function evaluateAgentVisualExpression(expression,scope={},options={}){
  const ast=compileAgentVisualExpression(expression),state=options.budget||{steps:0,limit:Math.min(options.maxSteps||AGENT_VISUAL_LIMITS.expressionSteps,AGENT_VISUAL_LIMITS.expressionSteps)};
  function evaluate(node,depth=0){
    charge(state);if(depth>AGENT_VISUAL_LIMITS.expressionDepth)fail();let result;
    if(node.type==='literal')result=node.value;
    else if(node.type==='name'){if(FORBIDDEN.has(node.name)||!own(scope,node.name))fail();result=scope[node.name];}
    else if(node.type==='array')result=node.values.map(value=>evaluate(value,depth+1));
    else if(node.type==='member')result=field(evaluate(node.value,depth+1),evaluate(node.key,depth+1));
    else if(node.type==='call')result=HELPERS[node.name](state,...node.args.map(value=>evaluate(value,depth+1)));
    else if(node.type==='unary'){const value=evaluate(node.value,depth+1);result=node.op==='!'?!value:node.op==='-'?-num(value):num(value);}
    else if(node.type==='ternary')result=evaluate(evaluate(node.condition,depth+1)?node.yes:node.no,depth+1);
    else if(node.type==='binary'){
      const left=evaluate(node.left,depth+1);
      if(node.op==='&&')return left?evaluate(node.right,depth+1):left;
      if(node.op==='||')return left?left:evaluate(node.right,depth+1);
      if(node.op==='??')return left===null?evaluate(node.right,depth+1):left;
      const right=evaluate(node.right,depth+1);
      switch(node.op){
        case '+':if(typeof left==='string'||typeof right==='string'){if(!cleanScalar(left)||!cleanScalar(right))fail();result=String(left)+String(right);}else result=num(left)+num(right);break;
        case '-':result=num(left)-num(right);break;case '*':result=num(left)*num(right);break;case '/':result=num(left)/num(right);break;case '%':result=num(left)%num(right);break;
        case '==':case '===':result=left===right;break;case '!=':case '!==':result=left!==right;break;
        case '<':case '>':case '<=':case '>=':if(!cleanScalar(left)||!cleanScalar(right))fail();result=node.op==='<'?left<right:node.op==='>'?left>right:node.op==='<='?left<=right:left>=right;break;
        default:fail();
      }
    }else fail();
    if(typeof result==='number'&&!finite(result))fail();if(typeof result==='string'&&result.length>16000)fail();return result;
  }
  return evaluate(ast);
}

export function isSafeAgentVisualAttribute(name,value){
  if(!ATTRS.has(name)||(typeof value!=='string'&&!finite(value)))return false;const text=String(value);
  if(text.length>16000||/[<>\u0000-\u0008]/.test(text)||/url\s*\(|javascript\s*:|data\s*:|https?\s*:|expression\s*\(/i.test(text))return false;
  if(name==='d')return /^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\-\s]*$/.test(text);
  if(name==='points')return /^[0-9eE+.,\-\s]*$/.test(text);
  if(name==='transform')return /^(?:(?:translate|scale|rotate|matrix|skewX|skewY)\([0-9eE+.,\-\s]+\)\s*)*$/.test(text);
  if(['fill','stroke'].includes(name))return /^(?:none|currentColor|transparent|[a-zA-Z]{1,24}|#[a-fA-F0-9]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s/+-]+\))$/.test(text);
  if(name==='viewBox'){const v=text.trim().split(/[\s,]+/).map(Number);return v.length===4&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e6)&&v[2]>0&&v[3]>0;}
  return true;
}
export function isSafeAgentVisualStyle(name,value){
  if(!STYLES.has(name)||(typeof value!=='string'&&!finite(value)))return false;const text=String(value);
  return text.length<=240&&!/[<>;{}\\\u0000-\u0008]/.test(text)&&!/url\s*\(|expression\s*\(|(?:java|vb)script\s*:|https?\s*:|data\s*:|@import|(?:^|\W)(?:fixed|sticky|absolute)(?:$|\W)/i.test(text)&&!/[-]?\d+(?:\.\d+)?v(?:w|h|min|max)/i.test(text);
}
const exprValid=value=>{try{compileAgentVisualExpression(value);return true;}catch{return false;}};
function expressionConstraint(value,path){
  try{compileAgentVisualExpression(value);return null;}catch(error){
    const explanation=EXPRESSION_FAILURES[error?.visual_expression_code]??'Use only the documented expression grammar and helper functions.';
    const position=Number.isSafeInteger(error?.visual_expression_offset)?` Character offset ${error.visual_expression_offset} (zero-based).`:'';
    return {code:'document_constraint',path,expected:explanation+position};
  }
}
function inspectDocumentExpressions(doc,path){
  const issues=[];let truncated=false;
  const inspect=(expression,suffix)=>{const issue=expressionConstraint(expression,path+suffix);if(issue){if(issues.length<8)issues.push(issue);else truncated=true;}return !truncated;};
  // Shape inspection has verified indexed data descriptors. Do not call
  // instance iteration helpers: arrays may carry unrelated accessor properties.
  for(let i=0;i<doc.lets.length;i++)if(!inspect(doc.lets[i].expr,`.lets.${i}.expr`))return {issues,truncated};
  for(let i=0;i<doc.nodes.length;i++){
    const node=doc.nodes[i];
    if(node.when!==null&&!inspect(node.when,`.nodes.${i}.when`))break;
    for(let j=0;j<node.bindings.length;j++)if(!inspect(node.bindings[j].expr,`.nodes.${i}.bindings.${j}.expr`))return {issues,truncated};
    if(node.repeat!==null&&!inspect(node.repeat.expr,`.nodes.${i}.repeat.expr`))break;
  }
  return {issues,truncated};
}
function pairsValid(items,type){return Array.isArray(items)&&items.length<=24&&new Set(items.map(item=>item?.name)).size===items.length&&items.every(item=>keys(item,['name','value'])&&(type==='attr'?isSafeAgentVisualAttribute(item.name,item.value):isSafeAgentVisualStyle(item.name,item.value)));}
// Explain the first runtime constraint using schema-owned paths and fixed text.
// This diagnoses rejected declarations; the existing validator remains the gate.
function inspectDocumentConstraint(doc,path){
  const issue=(suffix,expected)=>({code:'document_constraint',path:`${path}${suffix}`,expected});
  if(bytes(doc)>AGENT_VISUAL_LIMITS.specBytes)return issue('','Document must be at most 32768 UTF-8 bytes.');
  if(doc.assumptions.length>6||doc.assumptions.some(value=>!string(value,400,false))||doc.kind==='illustration'&&!doc.assumptions.length)return issue('.assumptions','At most 6 nonempty assumptions, each at most 400 characters; illustration requires one.');
  if(doc.dataBindings.length>8||new Set(doc.dataBindings.map(v=>v.name)).size!==doc.dataBindings.length||doc.kind==='observed'&&!doc.dataBindings.length)return issue('.dataBindings','Use at most 8 uniquely named bindings; observed documents require a binding.');
  for(const [i,item] of doc.dataBindings.entries())if(!bindingValid(item))return issue(`.dataBindings.${i}`,'Use a unique allowed identifier, a real evidence reference, and an optional null or 1–12 own-field path segments; prototype keys are forbidden.');
  if(doc.params.length>8||new Set(doc.params.map(v=>v.name)).size!==doc.params.length)return issue('.params','Use at most 8 uniquely named parameters.');
  for(const [i,item] of doc.params.entries()){
    if(!safeName(item.name)||!string(item.label,100,false)||item.options.length>AGENT_VISUAL_LIMITS.selectOptions)return issue(`.params.${i}`,`Use an allowed identifier, a nonempty label of at most 100 characters and at most ${AGENT_VISUAL_LIMITS.selectOptions} options.`);
    if(item.type==='range'&&(![item.value,item.min,item.max,item.step].every(finite)||item.min>=item.max||item.value<item.min||item.value>item.max||item.step<=0||item.step>item.max-item.min||(item.max-item.min)/item.step>1e9||item.options.length))return issue(`.params.${i}`,'Range requires finite min < max, value in range, 0 < step <= max-min, at most 1e9 increments, and options=[].');
    if(item.type==='toggle'&&(typeof item.value!=='boolean'||item.min!==null||item.max!==null||item.step!==null||item.options.length))return issue(`.params.${i}`,'Toggle requires a boolean value, min/max/step=null and options=[].');
    if(item.type==='select'&&(item.min!==null||item.max!==null||item.step!==null||!item.options.length||!item.options.some(v=>v.value===item.value)||new Set(item.options.map(v=>v.value)).size!==item.options.length||item.options.some(v=>!string(v.label,100,false)||!string(v.value,100,false)&&!finite(v.value))))return issue(`.params.${i}`,'Select requires min/max/step=null, unique nonempty options and a value matching an option.');
  }
  if(doc.lets.length>24||new Set(doc.lets.map(v=>v.name)).size!==doc.lets.length)return issue('.lets','Use at most 24 uniquely named derived variables.');
  for(const [i,item] of doc.lets.entries()){
    if(!safeName(item.name))return issue(`.lets.${i}.name`,'Use an English letter followed by letters, digits or underscores, at most 40 characters; reserved names data/params/vars/item/index are unavailable.');
    const expressionIssue=expressionConstraint(item.expr,`${path}.lets.${i}.expr`);if(expressionIssue)return expressionIssue;
  }
  if(doc.actions.length>8||new Set(doc.actions.map(v=>v.id)).size!==doc.actions.length)return issue('.actions','Use at most 8 uniquely named actions.');
  for(const [i,item] of doc.actions.entries())if(!safeId(item.id)||!string(item.label,100,false)||!string(item.evidence_ref,240,false))return issue(`.actions.${i}`,'Use an allowed unique action id, nonempty label up to 100 characters and actual evidence reference.');
  if(!doc.nodes.length||doc.nodes.length>160)return issue('.nodes','Use 1 to 160 nodes.');
  const seen=new Map(),namespaces=new Map(),actions=new Set(doc.actions.map(v=>v.id));
  for(const [i,node] of doc.nodes.entries()){
    const prefix=`.nodes.${i}`;
    if(!safeId(node.id)||seen.has(node.id))return issue(`${prefix}.id`,'Use an allowed unique node id.');
    if(node.parent!==null&&!seen.has(node.parent))return issue(`${prefix}.parent`,'Parent must be null or the id of an earlier node.');
    for(const kind of ['attrs','style'])if(!pairsValid(node[kind],kind==='attrs'?'attr':'style')){
      const failed=node[kind].findIndex(pair=>!(kind==='attrs'?isSafeAgentVisualAttribute(pair.name,pair.value):isSafeAgentVisualStyle(pair.name,pair.value)));
      return issue(`${prefix}.${kind}${failed>=0?'.'+failed:''}`,kind==='attrs'?`Use at most 24 unique allowed attributes: ${[...ATTRS].join(', ')}. Values must satisfy SVG syntax; no URLs.`:`Use at most 24 unique allowed styles: ${[...STYLES].join(', ')}. No URLs, viewport units or positioned overlays.`);
    }
    if(node.text!==null&&!string(node.text,2000))return issue(`${prefix}.text`,'Text is null or at most 2000 characters.');
    if(node.when!==null){const expressionIssue=expressionConstraint(node.when,`${path}${prefix}.when`);if(expressionIssue)return expressionIssue;}
    if(node.action!==null&&(!actions.has(node.action)||node.tag!=='button'))return issue(`${prefix}.action`,'Only button nodes may reference an existing action id.');
    const svg=node.tag==='svg'||namespaces.get(node.parent)===true;
    if(svg!==SVG_TAGS.has(node.tag))return issue(`${prefix}.tag`,'SVG nodes must be within an svg root; HTML nodes cannot be inside SVG.');
    namespaces.set(node.id,svg);let depth=1,parent=node.parent;while(parent!==null){if(++depth>16)return issue(`${prefix}.parent`,'Node hierarchy depth must not exceed 16.');parent=seen.get(parent).parent;}
    if(node.bindings.length>16||new Set(node.bindings.map(v=>v.target)).size!==node.bindings.length)return issue(`${prefix}.bindings`,'Use at most 16 unique binding targets per node.');
    for(const [j,binding] of node.bindings.entries()){
      const expressionIssue=expressionConstraint(binding.expr,`${path}${prefix}.bindings.${j}.expr`);if(expressionIssue)return expressionIssue;
      if(binding.target!=='text'&&!(binding.target.startsWith('attr:')&&ATTRS.has(binding.target.slice(5)))&&!(binding.target.startsWith('style:')&&STYLES.has(binding.target.slice(6))))return issue(`${prefix}.bindings.${j}.target`,'Binding target must be text, attr:<allowed attribute> or style:<allowed style>.');
    }
    if(node.repeat!==null){const expressionIssue=expressionConstraint(node.repeat.expr,`${path}${prefix}.repeat.expr`);if(expressionIssue)return expressionIssue;if((!safeName(node.repeat.as)&&node.repeat.as!=='item')||(!safeName(node.repeat.index)&&node.repeat.index!=='index')||node.repeat.as===node.repeat.index)return issue(`${prefix}.repeat`,'Repeat requires distinct allowed as/index names; item/index are allowed here.');}
    seen.set(node.id,node);
  }
  return issue('','Allowed names, expressions, parameter ranges, node hierarchy and document size.');
}
export function validateAgentVisualDocument(document){
  try{
    if(!keys(document,['version','kind','assumptions','dataBindings','params','lets','nodes','actions'])||bytes(document)>AGENT_VISUAL_LIMITS.specBytes||document.version!==1||!['illustration','observed'].includes(document.kind))return false;
    if(!Array.isArray(document.assumptions)||document.assumptions.length>6||!document.assumptions.every(value=>string(value,400,false))||(document.kind==='illustration'&&!document.assumptions.length))return false;
    if(!Array.isArray(document.dataBindings)||document.dataBindings.length>8||!document.dataBindings.every(bindingValid)||new Set(document.dataBindings.map(item=>item.name)).size!==document.dataBindings.length||(document.kind==='observed'&&!document.dataBindings.length))return false;
    if(!Array.isArray(document.params)||document.params.length>AGENT_VISUAL_LIMITS.controls||new Set(document.params.map(item=>item?.name)).size!==document.params.length)return false;
    for(const param of document.params){
      if(!keys(param,['name','type','label','value','min','max','step','options'])||!safeName(param.name)||!string(param.label,100,false)||!['range','select','toggle'].includes(param.type)||!Array.isArray(param.options)||param.options.length>AGENT_VISUAL_LIMITS.selectOptions)return false;
      if(param.type==='range'){if(![param.value,param.min,param.max,param.step].every(finite)||param.min>=param.max||param.value<param.min||param.value>param.max||param.step<=0||param.step>param.max-param.min||(param.max-param.min)/param.step>1e9||param.options.length)return false;}
      else if(param.type==='toggle'){if(typeof param.value!=='boolean'||param.min!==null||param.max!==null||param.step!==null||param.options.length)return false;}
      else if(param.min!==null||param.max!==null||param.step!==null||!param.options.length||!param.options.every(item=>keys(item,['label','value'])&&string(item.label,100,false)&&(string(item.value,100,false)||finite(item.value)))||!param.options.some(item=>item.value===param.value)||new Set(param.options.map(item=>item.value)).size!==param.options.length)return false;
    }
    if(!Array.isArray(document.lets)||document.lets.length>24||new Set(document.lets.map(item=>item?.name)).size!==document.lets.length||!document.lets.every(item=>keys(item,['name','expr'])&&safeName(item.name)&&exprValid(item.expr)))return false;
    if(!Array.isArray(document.actions)||document.actions.length>8||new Set(document.actions.map(item=>item?.id)).size!==document.actions.length||!document.actions.every(item=>keys(item,['id','label','kind','evidence_ref'])&&safeId(item.id)&&string(item.label,100,false)&&ACTIONS.includes(item.kind)&&string(item.evidence_ref,240,false)))return false;
    if(!Array.isArray(document.nodes)||!document.nodes.length||document.nodes.length>AGENT_VISUAL_LIMITS.nodes)return false;
    const seen=new Map(),namespaces=new Map(),actions=new Set(document.actions.map(item=>item.id));
    for(const node of document.nodes){
      if(!keys(node,['id','parent','tag','attrs','style','text','bindings','when','repeat','action'])||!safeId(node.id)||seen.has(node.id)||!TAGS.includes(node.tag)||(node.parent!==null&&!seen.has(node.parent))||!pairsValid(node.attrs,'attr')||!pairsValid(node.style,'style')||(node.text!==null&&!string(node.text,2000))||(node.when!==null&&!exprValid(node.when))||(node.action!==null&&(!actions.has(node.action)||node.tag!=='button')))return false;
      const inSvg=node.tag==='svg'||namespaces.get(node.parent)===true;if(inSvg!==SVG_TAGS.has(node.tag))return false;namespaces.set(node.id,inSvg);
      let depth=1,parent=node.parent;while(parent!==null){if(++depth>16)return false;parent=seen.get(parent).parent;}
      if(!Array.isArray(node.bindings)||node.bindings.length>16||new Set(node.bindings.map(item=>item?.target)).size!==node.bindings.length||!node.bindings.every(binding=>keys(binding,['target','expr'])&&exprValid(binding.expr)&&(binding.target==='text'||(binding.target.startsWith('attr:')&&ATTRS.has(binding.target.slice(5)))||(binding.target.startsWith('style:')&&STYLES.has(binding.target.slice(6))))))return false;
      if(node.repeat!==null&&(!keys(node.repeat,['expr','as','index'])||!exprValid(node.repeat.expr)||(!safeName(node.repeat.as)&&node.repeat.as!=='item')||(!safeName(node.repeat.index)&&node.repeat.index!=='index')||node.repeat.as===node.repeat.index))return false;
      seen.set(node.id,node);
    }
    return true;
  }catch{return false;}
}
function mapGet(map,key){return map instanceof Map?map.get(key):own(map,key)?map[key]:undefined;}
function refsValid(refs){return Array.isArray(refs)&&refs.length<=16&&refs.every(ref=>string(ref,240,false))&&new Set(refs).size===refs.length;}
function wrapperValid(visual,bound=false){
  const names=['title','description','evidence_refs','document',...(bound?['data','provenance']:[])];
  return keys(visual,names)&&string(visual.title,160,false)&&string(visual.description,800)&&refsValid(visual.evidence_refs)&&validateAgentVisualDocument(visual.document)&&bytes({title:visual.title,description:visual.description,evidence_refs:visual.evidence_refs,document:visual.document})<=AGENT_VISUAL_LIMITS.specBytes;
}
/** Evaluate the exact bounded scene before any DOM is created on either host. */
export function evaluateAgentVisualScene(visual,parameterValues=null){
  if(!validateBoundAgentVisualization(visual))fail();
  const doc=visual.document,params=parameterValues??Object.fromEntries(doc.params.map(param=>[param.name,param.value]));
  if(!keys(params,doc.params.map(param=>param.name)))fail();
  for(const param of doc.params){const value=params[param.name];
    if(param.type==='range'&&(!finite(value)||value<param.min||value>param.max)||param.type==='toggle'&&typeof value!=='boolean'||param.type==='select'&&!param.options.some(option=>option.value===value))fail();
  }
  const vars=Object.create(null),base={data:visual.data,params,vars},children=new Map();
  for(const node of doc.nodes){if(!children.has(node.parent))children.set(node.parent,[]);children.get(node.parent).push(node);}
  const budget={steps:0,limit:AGENT_VISUAL_LIMITS.expressionSteps};let rendered=0,visits=0;
  const evaluate=(expression,scope)=>evaluateAgentVisualExpression(expression,scope,{budget});
  for(const item of doc.lets)vars[item.name]=evaluate(item.expr,base);
  const draw=(node,scope,inSvg=false)=>{
    if(++visits>AGENT_VISUAL_LIMITS.renderedNodes)throw new Error('Agent visual render budget exceeded');
    const drawOnce=local=>{
      if(node.when!==null&&!evaluate(node.when,local))return null;
      if(++rendered>AGENT_VISUAL_LIMITS.renderedNodes)throw new Error('Agent visual render budget exceeded');
      const svg=inSvg||node.tag==='svg';
      if(svg!==SVG_TAGS.has(node.tag))throw new Error('Invalid visual namespace');
      // Preserve write order, including repeated properties: a bound CSS
      // shorthand may intentionally override an earlier static longhand.
      const attrs=[],style=[];let text=null;
      const set=(target,value)=>{
        if(value!==null&&!['string','number','boolean'].includes(typeof value))throw new Error('Visual binding requires a scalar value');
        if(target==='text'){if(String(value??'').length>16000)throw new Error('Visual text budget exceeded');text=String(value??'');}
        else if(target.startsWith('attr:')){const name=target.slice(5);if(!isSafeAgentVisualAttribute(name,value))throw new Error('Invalid visual attribute');attrs.push({name,value:String(value)});}
        else if(target.startsWith('style:')){const name=target.slice(6);if(!isSafeAgentVisualStyle(name,value))throw new Error('Invalid visual style');style.push({name,value:String(value)});}
        else throw new Error('Invalid visual binding');
      };
      for(const item of node.attrs)set('attr:'+item.name,item.value);
      for(const item of node.style)set('style:'+item.name,item.value);
      if(node.text!==null)set('text',node.text);
      for(const binding of node.bindings)set(binding.target,evaluate(binding.expr,local));
      const nested=[];for(const child of children.get(node.id)||[])nested.push(...draw(child,local,svg));
      return {id:node.id,tag:node.tag,svg,attrs,style,text,action:node.action,children:nested};
    };
    if(node.repeat===null){const result=drawOnce(scope);return result?[result]:[];}
    const rows=evaluate(node.repeat.expr,scope);if(!Array.isArray(rows)||rows.length>AGENT_VISUAL_LIMITS.array)throw new Error('Invalid visual repeat');
    const result=[];
    for(let index=0;index<rows.length;index++){
      if(++visits>AGENT_VISUAL_LIMITS.renderedNodes)throw new Error('Agent visual render budget exceeded');
      const child=drawOnce({...scope,[node.repeat.as]:rows[index],[node.repeat.index]:index});if(child)result.push(child);
    }
    return result;
  };
  const nodes=[];for(const node of children.get(null)||[])nodes.push(...draw(node,base));
  return {nodes,vars};
}
const agentQueryReference=/^(?:query:[1-9]\d*|turn:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:g(?:0|[1-9]\d*):query:[1-9]\d*)$/i;
const visualFailure=(category,index,path,issues)=>{const error=new Error('Invalid Agent visual document');error.visual_category=category;error.visual_path=`visualizations.${index}.${path}`;if(issues?.length)error.visual_issues=issues;throw error;};
const referenceFailure=(category,index,path,code,expected)=>visualFailure(category,index,path,[{code,path:`visualizations.${index}.${path}`,expected}]);
export function bindAgentVisualizations(candidates,{evidence,queryResults,source,maxVisuals=1}={}){
  if(!Array.isArray(candidates)||candidates.length>AGENT_VISUAL_LIMITS.visuals||![1,2].includes(maxVisuals))fail();
  return candidates.slice(0,maxVisuals).map((candidate,index)=>{
    if(!wrapperValid(candidate))visualFailure('document_schema',index,'document',inspectAgentVisualCandidate(candidate,{path:`visualizations.${index}`}).issues);const cited=new Set(candidate.evidence_refs);
    // Action diagnostics precede the general citation list so an unknown action
    // remains identifiable even when that same unknown value is also listed.
    // Paths and repair text are schema-owned; rejected reference values stay private.
    for(const [actionIndex,action] of candidate.document.actions.entries()){
      const path=`document.actions.${actionIndex}.evidence_ref`;
      if(!mapGet(evidence,action.evidence_ref))referenceFailure('action_reference',index,path,'unknown_evidence_reference','Replace this action evidence_ref with an exact reference from a successful current-turn read, and include that same reference in this visualization evidence_refs. Do not invent a reference or reuse an unverified prior-turn reference.');
      if(!cited.has(action.evidence_ref))referenceFailure('action_reference',index,path,'uncited_action_reference','This action reference is known from a successful current-turn read. Add that exact action evidence_ref to this visualization evidence_refs; do not change its identity or claim a new read.');
    }
    for(const [refIndex,ref] of candidate.evidence_refs.entries())if(!mapGet(evidence,ref))referenceFailure('evidence_reference',index,`evidence_refs.${refIndex}`,'unknown_evidence_reference','Replace or remove this unknown visualization citation. Use only an exact evidence_ref or query_evidence_ref returned by a successful current-turn read; keep all binding and action references cited.');
    const data=Object.create(null),provenance=[];
    for(const [bindingIndex,binding] of candidate.document.dataBindings.entries()){
      if(!cited.has(binding.evidence_ref))visualFailure('evidence_reference',index,'dataBindings');const entry=mapGet(evidence,binding.evidence_ref),queryRef=entry?.query_ref||(agentQueryReference.test(binding.evidence_ref)?binding.evidence_ref:null),result=queryRef?mapGet(queryResults,queryRef):undefined;
      if(!agentQueryReference.test(queryRef||'')||result===undefined)visualFailure('query_reference',index,'dataBindings');
      let cloned,originalSource;try{cloned=projectAgentVisualBindingData(result,binding.path);const descriptor=ownDataDescriptor(result,'source');originalSource=descriptor?cloneData(descriptor.value):undefined;}catch(error){const code=error?.visual_data_code==='data_path_invalid'?'data_path_invalid':'bound_data_invalid';visualFailure('bound_data',index,'data',[{code,path:`visualizations.${index}.document.dataBindings.${bindingIndex}.path`,expected:code==='data_path_invalid'?'Select an existing own-field subtree from this exact query result. Statistics charts normally use path=["items"].':'Selected data must satisfy the existing scalar, structure and clone budgets. Use a narrower explicit path or an exact statistics projection; getters and prototype access are forbidden.'}]);}for(const key of ['source_revision','generated_at','content_sha256'])if(source?.[key]&&(key!=='content_sha256'||originalSource?.[key]!=null)&&originalSource?.[key]!==source[key])visualFailure('source_mismatch',index,'dataBindings');
      // A projection may omit source entirely. Its compact attestation comes
      // only from the server-held original result, never the candidate or the
      // current-context source substituted for an unknown historical field.
      const observedSource=bindingSource(originalSource);
      data[binding.name]=cloned;provenance.push({name:binding.name,evidence_ref:binding.evidence_ref,query_ref:queryRef,...(Object.hasOwn(binding,'path')?{path:bindingPathCopy(binding.path)}:{}),...(observedSource?{source:observedSource}:{})});
    }
    const dataBytes=bytes(data);if(dataBytes>AGENT_VISUAL_LIMITS.dataBytes)visualFailure('bound_data',index,'data',[{code:'data_budget_exceeded',path:`visualizations.${index}.data`,maximum_bytes:AGENT_VISUAL_LIMITS.dataBytes,actual_bytes:dataBytes,expected:'Combined bound data must fit 65536 UTF-8 bytes. Declare path=["items"] for statistics rows, or bind other required subtrees explicitly. Original query archives and evidence references remain unchanged.'}]);
    const visual={title:candidate.title,description:candidate.description,evidence_refs:[...candidate.evidence_refs],document:JSON.parse(JSON.stringify(candidate.document)),data,provenance};
    // The same pure evaluation used by the browser must succeed at the supplied
    // defaults. This keeps schema-valid but unrenderable model output inside the
    // caller's existing visual-repair budget instead of a completed report.
    try{evaluateAgentVisualScene(visual);}catch{visualFailure('initial_scene',index,'document.nodes');}return visual;
  });
}
export function validateBoundAgentVisualization(visual){
  try{
    if(!wrapperValid(visual,true)||!visual.data||typeof visual.data!=='object'||Array.isArray(visual.data)||bytes(visual.data)>AGENT_VISUAL_LIMITS.dataBytes||!Array.isArray(visual.provenance)||visual.provenance.length!==visual.document.dataBindings.length||Object.keys(visual.data).length!==visual.document.dataBindings.length)return false;
    cloneData(visual.data);
    const cited=new Set(visual.evidence_refs);
    return visual.document.dataBindings.every((binding,index)=>{const proof=cloneData(ownDataDescriptor(visual.provenance,String(index))?.value),withSource=own(proof,'source');return cited.has(binding.evidence_ref)&&own(visual.data,binding.name)&&keys(proof,['name','evidence_ref','query_ref',...(Object.hasOwn(binding,'path')?['path']:[]),...(withSource?['source']:[])])&&(!withSource||keys(proof.source,['source_revision','generated_at','content_sha256'])&&bindingSource(proof.source)!==null)&&proof.name===binding.name&&proof.evidence_ref===binding.evidence_ref&&agentQueryReference.test(proof.query_ref)&&JSON.stringify(proof.path)===JSON.stringify(binding.path);})&&visual.document.actions.every(action=>cited.has(action.evidence_ref));
  }catch{return false;}
}
