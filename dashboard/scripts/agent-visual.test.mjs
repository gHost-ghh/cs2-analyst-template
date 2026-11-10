import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_VISUAL_DOCUMENT_SCHEMA,
  AGENT_VISUAL_LIMITS,
  AGENT_VISUAL_GUIDANCE,
  inspectAgentVisualCandidate,
  validateAgentVisualDocument,
  validateBoundAgentVisualization,
  bindAgentVisualizations,
  evaluateAgentVisualExpression,
  evaluateAgentVisualScene,
} from '../shared/agent-visual.mjs';
import {mountAgentVisual} from '../ui/agent-visual.js';
import {AGENT_SYSTEM_INSTRUCTIONS} from '../worker/agent-instructions.mjs';

const matchId='a'.repeat(24),reference=`match:${matchId}:r2:shots`,queryRef='query:1';
const node=(id,tag,extra={})=>({id,parent:null,tag,attrs:[],style:[],text:null,bindings:[],when:null,repeat:null,action:null,...extra});
const range=(name='position')=>({name,type:'range',label:'观察位置',value:10,min:0,max:100,step:1,options:[]});
function document(extra={}){
  return {version:1,kind:'observed',assumptions:[],dataBindings:[{name:'shots',evidence_ref:reference}],params:[range()],lets:[{name:'offset',expr:'params.position * 2'}],nodes:[
    node('view','svg',{attrs:[{name:'viewBox',value:'0 0 200 100'}]}),
    node('point','circle',{parent:'view',attrs:[{name:'cy',value:50},{name:'r',value:5}],bindings:[{target:'attr:cx',expr:'vars.offset'}]}),
    node('label','text',{parent:'view',attrs:[{name:'x',value:0},{name:'y',value:20}],bindings:[{target:'text',expr:'params.position'}]}),
  ],actions:[],...extra};
}
const envelope=()=>({resource:'shots',items:[{tick:320,damage:25,x:1,y:2},{tick:321,damage:75,x:3,y:4}],source:{source_revision:'b'.repeat(40)},pagination:{next_offset:null}});
test('runtime document failures identify repairable paths without echoing rejected values',()=>{
  const candidate=doc=>({title:'图解',description:'',evidence_refs:[reference],document:doc});
  for(const [change,path] of [
    [doc=>doc.lets[0].expr='Math.sin(PRIVATE_INVALID_EXPRESSION)','lets.0.expr'],
    [doc=>doc.lets[0].name='index','lets.0.name'],
    [doc=>doc.nodes[1].parent='PRIVATE_MISSING_PARENT','nodes.1.parent'],
    [doc=>doc.params[0].max=0,'params.0'],
    [doc=>doc.nodes[1].bindings[0].target='attribute:cx','nodes.1.bindings.0.target'],
  ]){const doc=document();change(doc);const result=inspectAgentVisualCandidate(candidate(doc));assert.equal(result.valid,false);assert.equal(result.issues[0].path,'visualizations.0.document.'+path);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);assert.equal(validateAgentVisualDocument(doc),false);}
  assert.equal(inspectAgentVisualCandidate(candidate(document())).valid,true);
});
test('unsupported declaration names fail at the model schema enum before runtime value constraints',()=>{
  const doc=document();doc.nodes[1].attrs.push({name:'strokeWidth',value:7});
  const result=inspectAgentVisualCandidate({title:'图解',description:'',evidence_refs:[reference],document:doc});
  // Unsupported names now belong to the public schema, so repair feedback can
  // identify the exact name rather than the later generic pair constraint.
  assert.equal(result.issues[0].code,'enum');assert.equal(result.issues[0].path,'visualizations.0.document.nodes.1.attrs.2.name');
  assert.ok(result.issues[0].allowed_values.includes('stroke-width'));assert.ok(!result.issues[0].allowed_values.includes('strokeWidth'));
  assert.equal(validateAgentVisualDocument(doc),false);
});
function bind(candidateExtra={},optionsExtra={}){
  const data=envelope(),candidate={title:'逐发观察',description:'根据已读取的射击记录生成。',evidence_refs:[reference],document:document(),...candidateExtra};
  const options={evidence:new Map([[reference,{id:reference,resource:'shots',match_id:matchId,round_number:2,query_ref:queryRef}]]),queryResults:new Map([[queryRef,data]]),context:{match_id:matchId,round_number:2},source:data.source,...optionsExtra};
  return {candidate,options,data,visuals:()=>bindAgentVisualizations([candidate],options)};
}

test('the model document schema declares required fields and validates a custom SVG with a slider',()=>{
  assert.equal(AGENT_VISUAL_DOCUMENT_SCHEMA.type,'object');
  for(const key of ['version','kind','assumptions','dataBindings','params','lets','nodes','actions'])assert.ok(AGENT_VISUAL_DOCUMENT_SCHEMA.required.includes(key));
  assert.equal(validateAgentVisualDocument(document()),true);
  const illustration=document({kind:'illustration',dataBindings:[],assumptions:['滑块表示示意位置，不是实测轨迹。']});
  assert.equal(validateAgentVisualDocument(illustration),true);
  assert.equal(validateAgentVisualDocument({...illustration,assumptions:[]}),false);
  assert.equal(validateAgentVisualDocument(document({dataBindings:[]})),false);
});

test('all-match selectors support 22, 103 and 256 actual options within the existing document budget',()=>{
  const select=count=>({name:'match',type:'select',label:'比赛',value:'match_0',min:null,max:null,step:null,options:Array.from({length:count},(_,index)=>({label:`比赛 ${index+1}`,value:`match_${index}`}))});
  assert.equal(AGENT_VISUAL_LIMITS.selectOptions,256);assert.equal(AGENT_VISUAL_DOCUMENT_SCHEMA.properties.params.items.properties.options.maxItems,AGENT_VISUAL_LIMITS.selectOptions);
  for(const count of [22,103,AGENT_VISUAL_LIMITS.selectOptions]){
    const doc=document({params:[select(count)],lets:[],nodes:[node('selected','span',{bindings:[{target:'text',expr:'params.match'}]})]}),value=bind({document:doc}).visuals()[0];
    assert.equal(inspectAgentVisualCandidate({title:'选择比赛',description:'',evidence_refs:[reference],document:doc}).valid,true);
    assert.equal(validateAgentVisualDocument(doc),true);assert.equal(evaluateAgentVisualScene(value,{match:`match_${count-1}`}).nodes[0].text,`match_${count-1}`);
  }
  const over=document({params:[select(AGENT_VISUAL_LIMITS.selectOptions+1)]}),result=inspectAgentVisualCandidate({title:'过多选项',description:'',evidence_refs:[reference],document:over});
  assert.equal(result.issues[0].code,'max_items');assert.equal(result.issues[0].path,'visualizations.0.document.params.0.options');assert.equal(result.issues[0].limit,AGENT_VISUAL_LIMITS.selectOptions);assert.equal(validateAgentVisualDocument(over),false);
  const oversized=document({params:[select(AGENT_VISUAL_LIMITS.selectOptions)]});oversized.params[0].options=oversized.params[0].options.map((option,index)=>({label:'L'.repeat(100),value:String(index).padEnd(100,'v')}));oversized.params[0].value=oversized.params[0].options[0].value;
  assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).length>AGENT_VISUAL_LIMITS.specBytes);assert.equal(validateAgentVisualDocument(oversized),false);
  const unsafe=document({params:[select(22)]});unsafe.nodes[0].style=[{name:'position',value:'fixed'}];assert.equal(validateAgentVisualDocument(unsafe),false);
});

test('document validation rejects executable elements, event attributes and URL-backed resources',()=>{
  for(const tag of ['script','iframe','object','foreignObject','img'])assert.equal(validateAgentVisualDocument(document({nodes:[node('unsafe',tag)]})),false,tag);
  for(const attr of [{name:'onclick',value:'alert(1)'},{name:'href',value:'javascript:alert(1)'},{name:'src',value:'https://outside.test/a'}]){
    assert.equal(validateAgentVisualDocument(document({nodes:[node('unsafe','svg',{attrs:[attr]})]})),false,attr.name);
  }
  for(const style of [{name:'background-image',value:'url(https://outside.test/x)'},{name:'position',value:'fixed'}]){
    assert.equal(validateAgentVisualDocument(document({nodes:[node('unsafe','div',{style:[style]})]})),false,style.name);
  }
});

test('document validation rejects duplicate names, unbounded controls and malformed parent references',()=>{
  const variants=[
    document({params:[range(),range()]}),
    document({params:[range('constructor')]}),
    document({params:[{...range(),min:100,max:0}]}),
    document({params:[{...range(),step:0}]}),
    document({nodes:[node('same','div'),node('same','div')]}),
    document({nodes:[node('orphan','div',{parent:'missing'})]}),
    document({nodes:[node('a','div',{parent:'b'}),node('b','div',{parent:'a'})]}),
    {...document(),untrusted_execution:'alert(1)'},
  ];
  for(const value of variants)assert.equal(validateAgentVisualDocument(value),false);
  const missing=document();delete missing.actions;assert.equal(validateAgentVisualDocument(missing),false);
});

test('expressions compute from actual query envelopes and support bounded chart helpers',()=>{
  const scope={params:{position:10},vars:{offset:1},data:{shots:envelope()}};
  assert.equal(evaluateAgentVisualExpression('params.position * 2 + vars.offset',scope),21);
  assert.equal(evaluateAgentVisualExpression('data.shots.items[0].damage',scope),25);
  assert.equal(evaluateAgentVisualExpression('params.position > 5 ? 100 : 0',scope),100);
  assert.equal(evaluateAgentVisualExpression('clamp(120, 0, 100)',scope),100);
  assert.equal(evaluateAgentVisualExpression('data.shots.absent',scope),null);
  assert.equal(evaluateAgentVisualExpression("max(data.shots.items, 'damage')",scope),75);
  assert.equal(evaluateAgentVisualExpression("min(column(data.shots.items, 'damage'))",scope),25);
  assert.equal(evaluateAgentVisualExpression('avg([])',scope),null);
  const path=evaluateAgentVisualExpression("linePath(data.shots.items, 'x', 'y')",scope);
  assert.match(path,/^M\s*1[, ]2\s*L\s*3[, ]4$/);
});

test('expressions cannot access prototypes, execute JavaScript or read ambient authority',()=>{
  const scope={params:{position:10},vars:{},data:{shots:envelope()}};
  const unsafe=[
    'globalThis','window','process.env','document.cookie','fetch("https://outside.test")',
    'Function("return 1")()','eval("1")','params.constructor','params["__proto__"]',
    'data.shots.items.constructor','data.shots.items[0].__proto__','Math.constructor',
    'params.position = 200','params.position++','(() => 1)()','new Date()','',
  ];
  for(const expr of unsafe)assert.throws(()=>evaluateAgentVisualExpression(expr,scope),undefined,expr);
  assert.equal(scope.params.position,10,'Rejected expressions do not mutate application state');
  assert.throws(()=>evaluateAgentVisualExpression('(' .repeat(5000)+'1'+')'.repeat(5000),scope));
});

test('binding copies server-held query results and records exact evidence provenance',()=>{
  const fixture=bind(),[visual]=fixture.visuals();
  assert.equal(validateBoundAgentVisualization(visual),true);
  assert.deepEqual(visual.data.shots,fixture.data);
  assert.deepEqual(visual.provenance,[{name:'shots',evidence_ref:reference,query_ref:queryRef,source:{source_revision:fixture.data.source.source_revision,generated_at:null,content_sha256:null}}]);
  assert.deepEqual(visual.evidence_refs,[reference]);
  const forged={...visual,data:{shots:{items:[{damage:999}]}}};
  let rebound;try{[rebound]=bindAgentVisualizations([forged],fixture.options);}catch{}
  if(rebound)assert.deepEqual(rebound.data.shots,fixture.data,'Model data does not override server query results');
  assert.equal(fixture.options.queryResults.get(queryRef).items[0].damage,25);
});

test('binding preflights actual default expressions, scalar outputs, repeat rows and dynamic attributes',()=>{
  const invalids=[
    document({lets:[{name:'undefinedMath',expr:'1 / 0'}]}),
    document({nodes:[node('object','strong',{bindings:[{target:'text',expr:'data.shots'}]})]}),
    document({nodes:[node('array','strong',{bindings:[{target:'text',expr:'data.shots.items'}]})]}),
    document({nodes:[node('view','svg'),node('missing','circle',{parent:'view',bindings:[{target:'attr:cx',expr:'data.shots.absent'}]})]}),
    document({nodes:[node('bad-repeat','div',{repeat:{expr:'data.shots.source',as:'item',index:'index'}})]}),
    document({nodes:[node('bad-when','div',{when:'1 / 0'})]}),
    document({nodes:[node('forward-let','strong',{bindings:[{target:'text',expr:'vars.missing + 1'}]})]}),
  ];
  for(const doc of invalids){
    assert.equal(validateAgentVisualDocument(doc),true,'Syntax validity alone cannot prove the initial scene is renderable');
    assert.throws(()=>bind({document:doc}).visuals());
  }
  const doc=document({nodes:[node('view','svg'),node('number','text',{parent:'view',bindings:[{target:'text',expr:'data.shots.absent ?? 0'}]})]});
  const [visual]=bind({document:doc}).visuals(),scene=evaluateAgentVisualScene(visual),host=dom(),controller=mountAgentVisual(host,visual);
  try{assert.equal(scene.nodes[0].svg,true);assert.equal(scene.nodes[0].children[0].text,'0');assert.equal(host.querySelector('text').textContent,'0');}finally{controller.destroy();}
});

function bindRawRecord(expr,{record={damage:16},lets=false,topLevel={}}={}){
  const data={resource:'raw_rows',items:[{record,round_number:1,locator:{path:['rounds','0']},...topLevel}],source:{source_revision:'b'.repeat(40)}},doc=document({dataBindings:[{name:'shots',evidence_ref:reference,path:['items']}],lets:lets?[{name:'damage',expr}]:[],nodes:[node('value','span',{bindings:[{target:'text',expr:lets?"'HP ' + vars.damage":expr}]})]});
  return bind({document:doc},{queryResults:new Map([[queryRef,data]]),source:data.source}).visuals;
}

test('observed raw-row preflight identifies flattened fields at their originating expression',()=>{
  for(const [expr,lets,path]of [["'HP ' + data.shots[0].damage",false,'nodes.0.bindings.0.expr'],['data.shots[0].damage',true,'lets.0.expr']]){
    assert.throws(bindRawRecord(expr,{lets}),error=>{
      assert.equal(error.visual_category,'initial_scene');assert.equal(error.visual_issues[0].code,'raw_record_field_path');assert.equal(error.visual_issues[0].path,'visualizations.0.document.'+path);assert.match(error.visual_issues[0].expected,/record\.FIELD/);assert.doesNotMatch(JSON.stringify(error.visual_issues),/damage|HP |16/);return true;
    });
  }
  assert.match(AGENT_VISUAL_GUIDANCE,/data\.rows\[0\]\.record\.damage/);
});

test('observed raw-row preflight preserves real nested values and explicit null',()=>{
  const [correct]=bindRawRecord('data.shots[0].record.damage',{lets:true})();assert.equal(evaluateAgentVisualScene(correct).nodes[0].text,'HP 16');
  const [nullable]=bindRawRecord('data.shots[0].record.damage',{record:{damage:null},lets:true})();assert.equal(evaluateAgentVisualScene(nullable).nodes[0].text,'HP null');
  const [ownNull]=bindRawRecord('data.shots[0].damage',{topLevel:{damage:null},lets:true})();assert.equal(evaluateAgentVisualScene(ownNull).nodes[0].text,'HP null','An existing null is not a misplaced nested field');
  const legacy=structuredClone(correct);legacy.document.lets[0].expr='data.shots[0].damage';assert.equal(evaluateAgentVisualScene(legacy).nodes[0].text,'HP null','Existing saved scenes keep their nullable runtime semantics');
});

test('raw-row diagnostics allow deliberate null probes and guarded intermediate lets',()=>{
  for(const expr of ['data.shots[0].damage ?? "missing"','data.shots[0].damage === null ? "missing" : "present"','!data.shots[0].damage ? "missing" : "present"','data.shots[0].absent ?? "missing"']){
    const [visual]=bindRawRecord(expr)();assert.equal(evaluateAgentVisualScene(visual).nodes[0].text,'missing');
  }
  const visual=bindRawRecord('data.shots[0].record.damage',{lets:true})()[0],doc=visual.document;
  doc.lets=[{name:'probe',expr:'data.shots[0].damage'},{name:'fallback',expr:'vars.probe ?? "missing"'}];doc.nodes[0].bindings[0].expr='vars.fallback';
  const [guarded]=bind({document:doc},{queryResults:new Map([[queryRef,{source:{source_revision:'b'.repeat(40)},items:visual.data.shots}]])}).visuals();assert.equal(evaluateAgentVisualScene(guarded).nodes[0].text,'missing');
});

test('binding fails closed for missing, unrelated or unknown evidence and query references',()=>{
  for(const setup of [
    {evidence:new Map()},
    {queryResults:new Map()},
    {evidence:new Map([[reference,{id:reference,query_ref:'query:99'}]])},
    {evidence:new Map([[reference,{id:reference,query_ref:'https://outside.test/data'}]])},
  ]){const fixture=bind({},setup);assert.throws(()=>fixture.visuals());}
  const unknown=bind({evidence_refs:['invented']});assert.throws(()=>unknown.visuals());
  const noCitation=bind({evidence_refs:[]});assert.throws(()=>noCitation.visuals());
  const invalid=bind({document:document({nodes:[node('script','script')]})});assert.throws(()=>invalid.visuals());
});

test('known action references missing from the visual citations have precise repair feedback',()=>{
  const actionRef=`match:${matchId}:r2:round`,action={id:'review',label:'查看回合',kind:'open_round',evidence_ref:actionRef};
  const doc=document({actions:[action],nodes:[node('open','button',{text:'查看回合',action:'review'})]}),fixture=bind({document:doc});
  fixture.options.evidence.set(actionRef,{id:actionRef,resource:'round',match_id:matchId,round_number:2,query_ref:queryRef});
  assert.throws(()=>fixture.visuals(),error=>{
    assert.equal(error.visual_category,'action_reference');assert.equal(error.visual_path,'visualizations.0.document.actions.0.evidence_ref');
    assert.deepEqual(error.visual_issues.map(issue=>({code:issue.code,path:issue.path})),[{code:'uncited_action_reference',path:'visualizations.0.document.actions.0.evidence_ref'}]);
    assert.match(error.visual_issues[0].expected,/Add that exact action evidence_ref/);assert.ok(!JSON.stringify(error.visual_issues).includes(actionRef));return true;
  });
  fixture.candidate.evidence_refs.push(actionRef);const [repaired]=fixture.visuals();
  assert.equal(validateBoundAgentVisualization(repaired),true);assert.equal(repaired.document.actions[0].evidence_ref,actionRef);assert.deepEqual(repaired.evidence_refs,[reference,actionRef]);
});

test('unknown action evidence stays rejected even when cited and never appears in diagnostic payloads',()=>{
  for(const listed of [false,true]){
    const unknown='PRIVATE_UNREAD_ACTION_REFERENCE',action={id:'review',label:'查看回合',kind:'open_round',evidence_ref:unknown};
    const fixture=bind({evidence_refs:listed?[reference,unknown]:[reference],document:document({actions:[action]})});
    assert.throws(()=>fixture.visuals(),error=>{
      assert.equal(error.visual_category,'action_reference');assert.equal(error.visual_path,'visualizations.0.document.actions.0.evidence_ref');
      assert.equal(error.visual_issues[0].code,'unknown_evidence_reference');assert.match(error.visual_issues[0].expected,/successful current-turn read/);assert.doesNotMatch(JSON.stringify(error),/PRIVATE_UNREAD_ACTION_REFERENCE/);return true;
    });
    fixture.candidate.document.actions[0].evidence_ref=reference;fixture.candidate.evidence_refs=[reference];assert.equal(validateBoundAgentVisualization(fixture.visuals()[0]),true);
  }
});

test('unknown visual citations identify the exact list index and can be repaired without relaxing the evidence bank',()=>{
  const unknown='PRIVATE_UNREAD_WRAPPER_REFERENCE',fixture=bind({evidence_refs:[reference,unknown]});
  assert.throws(()=>fixture.visuals(),error=>{
    assert.equal(error.visual_category,'evidence_reference');assert.equal(error.visual_path,'visualizations.0.evidence_refs.1');
    assert.equal(error.visual_issues[0].code,'unknown_evidence_reference');assert.equal(error.visual_issues[0].path,'visualizations.0.evidence_refs.1');assert.doesNotMatch(JSON.stringify(error),/PRIVATE_UNREAD_WRAPPER_REFERENCE/);return true;
  });
  fixture.candidate.evidence_refs=[reference];assert.equal(validateBoundAgentVisualization(fixture.visuals()[0]),true);
  assert.equal(fixture.options.evidence.has(unknown),false);
});

test('bound wrappers must preserve a complete binding-to-provenance chain',()=>{
  const [visual]=bind().visuals();
  for(const changed of [
    {data:{}},{provenance:[]},{provenance:[{name:'shots',evidence_ref:'invented',query_ref:queryRef}]},
    {provenance:[{name:'shots',evidence_ref:reference,query_ref:'https://outside.test/data'}]},
    {evidence_refs:[]},{document:document({dataBindings:[{name:'shots',evidence_ref:'invented'}]})},
  ])assert.equal(validateBoundAgentVisualization({...visual,...changed}),false);
});

class FakeElement{
  constructor(tag,ownerDocument){this.tagName=tag;this.nodeName=tag;this.ownerDocument=ownerDocument;this.children=[];this.attributes={};this.listeners=new Map();this.dataset={};this.value='';this.checked=false;this.disabled=false;this._text='';this.parentNode=null;this.styleWrites=[];this.style={setProperty:(name,value)=>{this.styleWrites.push({name,value:String(value)});this.style[name]=String(value);},removeProperty:name=>{delete this.style[name];}};this.classList={add(){},remove(){},toggle(){}};}
  set textContent(value){this._text=String(value??'');this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(value){assert.equal(value,'','Generated visual must use DOM construction rather than HTML injection');this.replaceChildren();}
  get innerHTML(){return '';}
  append(...children){for(const child of children)this.appendChild(typeof child==='string'?this.ownerDocument.createTextNode(child):child);}
  appendChild(child){child.parentNode=this;this.children.push(child);return child;}
  replaceChildren(...children){for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...children);}
  removeChild(child){this.children=this.children.filter(value=>value!==child);child.parentNode=null;return child;}
  remove(){this.parentNode?.removeChild(this);}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='value')this.value=String(value);if(name==='type')this.type=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);}
  setAttributeNS(_namespace,name,value){this.setAttribute(name,value);}
  getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(name,handler){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(handler);}
  removeEventListener(name,handler){this.listeners.get(name)?.delete(handler);}
  dispatch(name,event){const evt=event||{type:name,target:this,currentTarget:this,stopped:false,preventDefault(){},stopPropagation(){this.stopped=true;}};evt.currentTarget=this;for(const fn of this.listeners.get(name)||[])fn(evt);if(!evt.stopped)this.parentNode?.dispatch(name,evt);}
  matches(selector){if(selector==='*')return true;const attr=/^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(selector);if(attr)return Object.hasOwn(this.attributes,attr[1])&&(attr[2]===undefined||this.attributes[attr[1]]===attr[2]);return this.tagName.toLowerCase()===selector.toLowerCase();}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches?.(selector)?[child]:[]),...(child.querySelectorAll?.(selector)||[])]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
}
function dom(){
  const ownerDocument={createElement(tag){const node=new FakeElement(tag,this);node.namespaceURI='http://www.w3.org/1999/xhtml';return node;},createElementNS(namespace,tag){const node=new FakeElement(tag,this);node.namespaceURI=namespace;return node;},createTextNode(text){const value=new FakeElement('#text',this);value.textContent=text;return value;}};
  return ownerDocument.createElement('div');
}

test('resolved scenes preserve CSS shorthand writes after static longhands',()=>{
  const style=[{name:'border',value:'1px solid red'},{name:'border-color',value:'blue'}],override={name:'border',value:'2px solid green'};
  const doc=document({lets:[],nodes:[node('border','div',{style,bindings:[{target:'style:border',expr:"'2px solid green'"}]})]});
  const [visual]=bind({document:doc}).visuals(),scene=evaluateAgentVisualScene(visual),host=dom(),controller=mountAgentVisual(host,visual);
  try{assert.deepEqual(scene.nodes[0].style,[...style,override]);assert.deepEqual(host.querySelector('[data-agent-node="border"]').styleWrites,[...style,override]);}finally{controller.destroy();}
});

test('saved SVG text and tspans follow the host foreground without changing HTML or shape defaults',()=>{
  const doc=document({lets:[],nodes:[
    node('chart','svg'),
    node('bar','rect',{parent:'chart',attrs:[{name:'fill',value:'#72adf4'}]}),
    node('label','text',{parent:'chart',text:'CT'}),
    node('value','tspan',{parent:'label',bindings:[{target:'text',expr:'params.position'}]}),
    node('html','p',{text:'HTML label'}),
  ]});
  const [visual]=bind({document:doc}).visuals(),saved=JSON.parse(JSON.stringify(visual)),host=dom();
  host.style.setProperty('color','#9fdbc0');
  const controller=mountAgentVisual(host,saved);
  try{
    for(const id of ['label','value'])assert.equal(host.querySelector(`[data-agent-node="${id}"]`).getAttribute('fill'),'currentColor');
    assert.equal(host.querySelector('rect').getAttribute('fill'),'#72adf4');
    assert.equal(host.querySelector('svg').getAttribute('fill'),null,'Text fallback does not change default shape paint');
    assert.equal(host.querySelector('[data-agent-node="html"]').getAttribute('fill'),null);
    assert.equal(host.querySelector('[data-agent-node="html"]').textContent,'HTML label');
    assert.equal(JSON.stringify(saved),JSON.stringify(visual),'Rendering old documents does not rewrite their saved colors');
    host.style.setProperty('color','#17202a');
    controller.setParam('position',35);
    assert.equal(host.querySelector('tspan').textContent,'35');
    assert.equal(host.querySelector('tspan').getAttribute('fill'),'currentColor','A rerender keeps live theme inheritance rather than resolving a fixed color');
  }finally{controller.destroy();}
});

test('SVG text keeps explicit and inherited fills, including dark labels on light panels',()=>{
  const doc=document({lets:[],nodes:[
    node('chart','svg'),
    node('series','g',{parent:'chart',attrs:[{name:'fill',value:'#72adf4'}]}),
    node('series-label','text',{parent:'series',text:'CT'}),
    node('series-value','tspan',{parent:'series-label',text:'25'}),
    node('none','text',{parent:'chart',attrs:[{name:'fill',value:'none'}],text:'Hidden'}),
    node('light-panel','div',{style:[{name:'background-color',value:'white'},{name:'color',value:'black'}]}),
    node('light-chart','svg',{parent:'light-panel',attrs:[{name:'fill',value:'black'}]}),
    node('light-label','text',{parent:'light-chart',text:'Readable black'}),
    node('own-label','text',{parent:'chart',attrs:[{name:'fill',value:'#e8b86a'}],text:'T'}),
  ]});
  const [visual]=bind({document:doc}).visuals(),host=dom(),controller=mountAgentVisual(host,visual);
  try{
    for(const id of ['series-label','series-value','light-label'])assert.equal(host.querySelector(`[data-agent-node="${id}"]`).getAttribute('fill'),null,'Authored ancestor paint remains inherited');
    assert.equal(host.querySelector('[data-agent-node="series"]').getAttribute('fill'),'#72adf4');
    assert.equal(host.querySelector('[data-agent-node="light-chart"]').getAttribute('fill'),'black');
    assert.equal(host.querySelector('[data-agent-node="none"]').getAttribute('fill'),'none');
    assert.equal(host.querySelector('[data-agent-node="own-label"]').getAttribute('fill'),'#e8b86a');
  }finally{controller.destroy();}
});

test('dynamic text and ancestor fills retain evaluated colors through parameter changes',()=>{
  const fill="params.position > 50 ? '#e8b86a' : 'currentColor'";
  const doc=document({lets:[],nodes:[
    node('chart','svg'),
    node('direct','text',{parent:'chart',bindings:[{target:'attr:fill',expr:fill},{target:'text',expr:'params.position'}]}),
    node('series','g',{parent:'chart',bindings:[{target:'attr:fill',expr:fill}]}),
    node('inherited','text',{parent:'series',text:'T'}),
  ]});
  const [visual]=bind({document:doc}).visuals(),host=dom(),controller=mountAgentVisual(host,visual);
  try{
    assert.equal(host.querySelector('[data-agent-node="direct"]').getAttribute('fill'),'currentColor');
    assert.equal(host.querySelector('[data-agent-node="inherited"]').getAttribute('fill'),null);
    controller.setParam('position',75);
    assert.equal(host.querySelector('[data-agent-node="direct"]').getAttribute('fill'),'#e8b86a');
    assert.equal(host.querySelector('[data-agent-node="direct"]').textContent,'75');
    assert.equal(host.querySelector('[data-agent-node="series"]').getAttribute('fill'),'#e8b86a');
    assert.equal(host.querySelector('[data-agent-node="inherited"]').getAttribute('fill'),null);
  }finally{controller.destroy();}
});

test('theme guidance uses allowed currentColor paint without relaxing color validation',()=>{
  for(const guidance of [AGENT_VISUAL_GUIDANCE,AGENT_SYSTEM_INSTRUCTIONS]){
    assert.match(guidance,/深色和浅色主题/);
    assert.match(guidance,/fill:'currentColor'/);
    assert.match(guidance,/对比清晰/);
  }
  const chart=fill=>document({nodes:[node('chart','svg'),node('label','text',{parent:'chart',attrs:[{name:'fill',value:fill}],text:'CT'})]});
  assert.equal(validateAgentVisualDocument(chart('currentColor')),true);
  for(const fill of ['var(--text)','url(https://outside.test/x)'])assert.equal(validateAgentVisualDocument(chart(fill)),false);
});

test('a model-defined SVG reacts to its generated slider and uses text-only rendering',()=>{
  const host=dom(),fixture=bind({document:document({nodes:[...document().nodes,node('literal','div',{text:'<script>never execute</script>'})]})}),[visual]=fixture.visuals();
  const actions=[],controller=mountAgentVisual(host,visual,{onAction:(...args)=>actions.push(args)});
  try{
    assert.equal(host.querySelector('circle').getAttribute('cx'),'20');
    assert.equal(host.querySelector('svg').namespaceURI,'http://www.w3.org/2000/svg');assert.equal(host.querySelector('circle').namespaceURI,'http://www.w3.org/2000/svg');assert.equal(host.querySelector('[data-agent-node="literal"]').namespaceURI,'http://www.w3.org/1999/xhtml');
    assert.equal(host.querySelector('text').textContent,'10');
    assert.ok(host.textContent.includes('<script>never execute</script>'));
    assert.equal(host.querySelector('script'),null);
    controller.setParam('position',35);
    assert.equal(host.querySelector('circle').getAttribute('cx'),'70');
    assert.equal(host.querySelector('text').textContent,'35');
    const slider=host.querySelector('input');assert.ok(slider,'Range parameter renders an actual input');
    slider.value='18';slider.dispatch('input');
    assert.equal(host.querySelector('circle').getAttribute('cx'),'36');
    assert.equal(controller.getState().params.position,18);
    const snapshot=controller.getState();snapshot.params.position=99;
    assert.equal(controller.getState().params.position,18,'Returned state is detached');
    controller.setParam('position',101);assert.equal(controller.getState().params.position,100);
    assert.throws(()=>controller.setParam('position',NaN));
    assert.throws(()=>controller.setParam('unknown',10));
    assert.equal(actions.length,0,'Drawing and adjusting a visual never dispatches an action');
  }finally{controller.destroy();}
  assert.equal(host.children.length,0);
});

test('model action controls dispatch only their bound evidence after an explicit click',()=>{
  const action={id:'review',label:'查看原始射击',kind:'open_evidence',evidence_ref:reference};
  const fixture=bind({document:document({actions:[action],nodes:[node('review-button','button',{text:'查看原始射击',action:action.id})]})}),[visual]=fixture.visuals(),host=dom(),calls=[];
  const controller=mountAgentVisual(host,visual,{onAction:(...args)=>calls.push(args)});
  try{assert.equal(calls.length,0);const button=host.querySelectorAll('button').find(value=>value.textContent==='查看原始射击');assert.ok(button);button.dispatch('click');assert.equal(calls.length,1);assert.equal(calls[0][0].kind,'open_evidence');assert.equal(calls[0][0].evidence_ref,reference);}finally{controller.destroy();}
  const invalid=bind({document:document({actions:[{...action,kind:'execute_code'}]})});assert.throws(()=>invalid.visuals());
});

test('repeated marks use bound rows and local item scope when the user changes a filter',()=>{
  const doc=document({params:[{...range('minimum'),value:0}],lets:[],nodes:[
    node('row','div',{repeat:{expr:'data.shots.items',as:'item',index:'index'},when:'item.damage >= params.minimum',bindings:[{target:'text',expr:'item.damage'}]}),
  ]});
  const fixture=bind({document:doc}),[visual]=fixture.visuals(),host=dom(),controller=mountAgentVisual(host,visual,{});
  try{
    assert.equal(host.querySelectorAll('[data-agent-node="row"]').filter(value=>value.textContent==='25').length,1);
    assert.equal(host.querySelectorAll('[data-agent-node="row"]').filter(value=>value.textContent==='75').length,1);
    controller.setParam('minimum',50);
    assert.equal(host.querySelectorAll('[data-agent-node="row"]').filter(value=>value.textContent==='25').length,0);
    assert.equal(host.querySelectorAll('[data-agent-node="row"]').filter(value=>value.textContent==='75').length,1);
    assert.equal(envelope().items.length,2,'Visual filtering never modifies query evidence');
  }finally{controller.destroy();}
});

test('a freely composed angle diagram recomputes trigonometry, paths and labels',()=>{
  assert.match(AGENT_VISUAL_GUIDANCE,/linePath/);
  assert.match(AGENT_VISUAL_GUIDANCE,/假设角度/);
  const doc=document({kind:'illustration',assumptions:['示意转移方向，非实测弹道。'],dataBindings:[],
    params:[{...range('angle'),min:0,max:90,value:0}],
    lets:[{name:'endX',expr:'100 + 80 * cos(params.angle * 0.0174532925199433)'},{name:'endY',expr:'100 - 80 * sin(params.angle * 0.0174532925199433)'}],
    nodes:[node('diagram','svg',{attrs:[{name:'viewBox',value:'0 0 220 120'}]}),
      node('ray','path',{parent:'diagram',attrs:[{name:'stroke',value:'currentColor'},{name:'fill',value:'none'}],bindings:[{target:'attr:d',expr:"'M100,100 L' + round(vars.endX, 2) + ',' + round(vars.endY, 2)"}]}),
      node('angle-label','text',{parent:'diagram',bindings:[{target:'text',expr:"params.angle + '°'"}]})]});
  const [visual]=bind({document:doc}).visuals(),host=dom(),controller=mountAgentVisual(host,visual);
  try{
    assert.equal(host.querySelector('path').getAttribute('d'),'M100,100 L180,100');
    controller.setParam('angle',90);
    assert.equal(host.querySelector('path').getAttribute('d'),'M100,100 L100,20');
    assert.equal(host.querySelector('text').textContent,'90°');
    assert.ok(host.textContent.includes('示意解释'));
    assert.ok(host.textContent.includes('非实测弹道'));
    assert.equal(controller.getState().vars.endY,20);
  }finally{controller.destroy();}
});

test('select and toggle controls filter bound query data and preserve value types',()=>{
  const select={name:'metric',type:'select',label:'指标',value:'damage',min:null,max:null,step:null,options:[{label:'伤害',value:'damage'},{label:'横坐标',value:'x'}]},toggle={name:'show',type:'toggle',label:'显示明细',value:false,min:null,max:null,step:null,options:[]};
  const doc=document({params:[select,toggle],lets:[{name:'total',expr:'sum(data.shots.items, params.metric)'}],nodes:[
    node('total','strong',{bindings:[{target:'text',expr:'vars.total'}]}),
    node('details','p',{when:'params.show',repeat:{expr:'data.shots.items',as:'shot',index:'row'},bindings:[{target:'text',expr:"'第 ' + (row + 1) + ' 发：' + shot[params.metric]"}]})]});
  const fixture=bind({document:doc}),[visual]=fixture.visuals(),host=dom(),controller=mountAgentVisual(host,visual);
  try{
    assert.equal(host.querySelector('strong').textContent,'100');
    assert.equal(host.querySelectorAll('[data-agent-node="details"]').length,0);
    const selectInput=host.querySelector('select');selectInput.value='1';selectInput.dispatch('change');
    assert.equal(host.querySelector('strong').textContent,'4');
    const toggleInput=host.querySelector('input');toggleInput.checked=true;toggleInput.dispatch('change');
    assert.equal(host.querySelectorAll('[data-agent-node="details"]').length,2);
    assert.equal(host.querySelectorAll('[data-agent-node="details"]')[1].textContent,'第 2 发：3');
    assert.throws(()=>controller.setParam('metric','constructor'));
    assert.throws(()=>controller.setParam('show','true'));
    assert.equal(fixture.data.items[0].damage,25);
    visual.data.shots.items[0].x=999;
    controller.setParam('metric','x');assert.equal(host.querySelector('strong').textContent,'4','Mounted evidence is detached from caller mutations');
  }finally{controller.destroy();}
});

test('the server binding rejects stale source envelopes, prototype keys and oversized data',()=>{
  const stale=bind({}, {source:{source_revision:'c'.repeat(40)}});assert.throws(()=>stale.visuals());
  const dated=bind({}, {source:{generated_at:'2026-10-21T00:00:00Z'}});assert.throws(()=>dated.visuals());
  const polluted=JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(()=>bind({}, {queryResults:new Map([[queryRef,polluted]])}).visuals());
  assert.equal({}.polluted,undefined);
  const big=envelope();big.items=Array.from({length:1000},()=>({text:'x'.repeat(100)}));
  assert.throws(()=>bind({}, {queryResults:new Map([[queryRef,big]])}).visuals());
  const overlyWide=envelope();overlyWide.items=Array.from({length:1001},()=>1);
  assert.throws(()=>bind({}, {queryResults:new Map([[queryRef,overlyWide]])}).visuals());
});

test('native query window metadata is ordinary bound data and never ambient authority',()=>{
  const native={resource:'native_frames',window:{tick_from:320,tick_to:640,tickrate:64},document:{label:'私有原生证据'},source:{source_revision:'b'.repeat(40)},items:[{tick:320,frame:0,aim_error:1.5},{tick:321,frame:1,aim_error:1.25}],pagination:{next_offset:null}};
  const doc=document({params:[],lets:[],dataBindings:[{name:'capture',evidence_ref:reference}],nodes:[node('range','strong',{bindings:[{target:'text',expr:"data.capture.window.tick_from + '–' + data.capture.window.tick_to + ': ' + data.capture.document.label"}]})]});
  const fixture=bind({document:doc},{queryResults:new Map([[queryRef,native]])}),[visual]=fixture.visuals(),host=dom(),controller=mountAgentVisual(host,visual);
  try{
    assert.deepEqual(visual.data.capture.window,native.window);
    assert.equal(host.querySelector('strong').textContent,'320–640: 私有原生证据');
    assert.equal(evaluateAgentVisualExpression('data.capture["window"].tickrate',{data:visual.data}),64);
    for(const expression of ['window','document','process','globalThis','Function','window.document','document.cookie','process.env'])assert.throws(()=>evaluateAgentVisualExpression(expression,{window:native.window,document:native.document,process:{env:{}}}),undefined,expression);
    for(const expression of ['data.capture.window.constructor','data.capture.document["__proto__"]'])assert.throws(()=>evaluateAgentVisualExpression(expression,{data:visual.data}),undefined,expression);
  }finally{controller.destroy();}
});

test('binding rejects accessor traps without invoking them',()=>{
  let reads=0;const native={resource:'native_frames',items:[{tick:320}]};
  Object.defineProperty(native,'window',{enumerable:true,get(){reads++;return {tick_from:320};}});
  assert.throws(()=>bind({}, {queryResults:new Map([[queryRef,native]])}).visuals());
  assert.equal(reads,0);
  const row={};Object.defineProperty(row,'damage',{enumerable:true,get(){reads++;return 5;}});
  assert.throws(()=>bind({}, {queryResults:new Map([[queryRef,{items:[row]}]])}).visuals());
  assert.throws(()=>evaluateAgentVisualExpression('data.damage',{data:row}));
  assert.equal(reads,0);
});

test('document and expression budgets reject oversized specs, deep trees and runaway work',()=>{
  assert.equal(validateAgentVisualDocument(document({nodes:Array.from({length:161},(_,i)=>node('n'+i,'div'))})),false);
  assert.equal(validateAgentVisualDocument(document({params:Array.from({length:9},(_,i)=>range('p'+i))})),false);
  assert.equal(validateAgentVisualDocument(document({nodes:Array.from({length:25},(_,i)=>node('n'+i,'div',{text:'x'.repeat(1800)}))})),false);
  const nested=Array.from({length:17},(_,i)=>node('n'+i,'div',{parent:i?'n'+(i-1):null}));
  assert.equal(validateAgentVisualDocument(document({nodes:nested})),false);
  assert.throws(()=>evaluateAgentVisualExpression('('.repeat(20)+'1'+')'.repeat(20)));
  assert.throws(()=>evaluateAgentVisualExpression('sum(data.rows)',{data:{rows:Array.from({length:1000},()=>1)}},{maxSteps:10}),/budget/);
  assert.throws(()=>evaluateAgentVisualExpression('1 / 0'));
  const fixture=bind(),candidate=fixture.candidate;
  assert.equal(bindAgentVisualizations([candidate,candidate],fixture.options).length,1,'Default response has one visual');
  assert.equal(bindAgentVisualizations([candidate,candidate],{...fixture.options,maxVisuals:2}).length,2);
  assert.throws(()=>bindAgentVisualizations([candidate,candidate,candidate],fixture.options));
});

test('nested repeats cannot exceed the rendered node budget even when evidence is small',()=>{
  const data=envelope();data.items=Array.from({length:50},(_,i)=>({damage:i}));
  const doc=document({params:[],lets:[],nodes:[
    node('rows','div',{repeat:{expr:'data.shots.items',as:'row',index:'ri'}}),
    node('cells','span',{parent:'rows',repeat:{expr:'data.shots.items',as:'cell',index:'ci'},bindings:[{target:'text',expr:'cell.damage'}]}),
  ]});
  assert.equal(validateAgentVisualDocument(doc),true);
  assert.throws(()=>bind({document:doc},{queryResults:new Map([[queryRef,data]])}).visuals(),error=>error.visual_category==='initial_scene','Nested expansion is rejected before the server can complete the report');
});

test('dynamic bindings cannot smuggle executable attributes, URLs or CSS out of query data',()=>{
  for(const [target,value] of [['attr:fill','url(https://outside.test/x)'],['style:color','url(https://outside.test/x)'],['style:width','expression(alert(1))'],['attr:d','javascript:alert(1)']]){
    const data=envelope();data.items[0].unsafe=value;
    const doc=document({lets:[],nodes:[node('view','svg'),node('mark','path',{parent:'view',bindings:[{target,expr:'data.shots.items[0].unsafe'}]})]});
    assert.throws(()=>bind({document:doc},{queryResults:new Map([[queryRef,data]])}).visuals(),error=>error.visual_category==='initial_scene');
  }
  const htmlInSvg=document({nodes:[node('view','svg'),node('html','div',{parent:'view'})]});
  assert.equal(validateAgentVisualDocument(htmlInSvg),false);
  assert.equal(validateAgentVisualDocument(document({nodes:[node('primitive','circle')]})),false);
});

test('a parameter causing undefined math fails locally and recovers on the next valid value',()=>{
  const doc=document({lets:[{name:'ratio',expr:'100 / params.position'}],nodes:[node('ratio','strong',{bindings:[{target:'text',expr:'vars.ratio'}]})]});
  const [visual]=bind({document:doc}).visuals(),host=dom(),controller=mountAgentVisual(host,visual);
  assert.equal(host.querySelector('strong').textContent,'10');
  assert.throws(()=>controller.setParam('position',0));
  assert.equal(host.querySelector('strong'),null);
  assert.equal(controller.getState().error,'render_unavailable');
  controller.setParam('position',20);
  assert.equal(host.querySelector('strong').textContent,'5');
  assert.equal(controller.getState().error,null);
  controller.destroy();controller.destroy();
  assert.throws(()=>controller.setParam('position',10),/destroyed/);
});

test('clicking an inner visual action never dispatches a surrounding action',()=>{
  const actions=[{id:'outer',label:'渲染',kind:'request_render',evidence_ref:reference},{id:'inner',label:'证据',kind:'open_evidence',evidence_ref:reference}];
  const doc=document({actions,nodes:[node('outer-button','button',{action:'outer',text:'渲染'}),node('inner-button','button',{parent:'outer-button',action:'inner',text:'证据'})]});
  const [visual]=bind({document:doc}).visuals(),host=dom(),calls=[],controller=mountAgentVisual(host,visual,{onAction:action=>calls.push(action)});
  try{host.querySelector('[data-agent-node="inner-button"]').dispatch('click');assert.deepEqual(calls.map(action=>action.kind),['open_evidence']);}finally{controller.destroy();}
});
