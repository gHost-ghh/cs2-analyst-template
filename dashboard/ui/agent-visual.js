import {validateBoundAgentVisualization,evaluateAgentVisualScene} from '../shared/agent-visual.mjs';

const SVG='http://www.w3.org/2000/svg';
const detached=value=>JSON.parse(JSON.stringify(value));

/** Render a validated, server-bound document using inert DOM primitives only. */
export function mountAgentVisual(host,input,{onAction}={}){
  if(!host?.ownerDocument||!validateBoundAgentVisualization(input))throw new Error('Invalid bound Agent visualization');
  // The host owns the source of evidence. Detach it before exposing parameter changes.
  const visual=detached(input),doc=visual.document,owner=host.ownerDocument;
  const params=Object.fromEntries(doc.params.map(param=>[param.name,param.value])),controls=new Map(),listeners=[];
  const actions=new Map(doc.actions.map(action=>[action.id,action]));
  let destroyed=false,vars={},lastError=null;
  const element=(tag,parent,text,className)=>{
    const el=owner.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.setAttribute('class',className);parent?.appendChild(el);return el;
  };
  const listen=(el,event,callback)=>{el.addEventListener(event,callback);listeners.push(()=>el.removeEventListener(event,callback));};
  const root=element('section',null,undefined,'agent-visual');root.setAttribute('aria-label',visual.title);
  const header=element('div',root,undefined,'agent-visual-header');
  element('h4',header,visual.title,'agent-visual-title');
  if(visual.description)element('p',header,visual.description,'agent-visual-description');
  if(doc.kind==='illustration'||doc.assumptions.length){
    const note=element('div',root,undefined,'agent-visual-assumptions');
    if(doc.kind==='illustration')element('strong',note,'示意解释');
    for(const assumption of doc.assumptions)element('p',note,assumption);
  }
  const scene=element('div',root,undefined,'agent-visual-scene');
  const controlHost=doc.params.length?element('div',root,undefined,'agent-visual-controls'):null;
  const updateControl=param=>{
    const control=controls.get(param.name);if(!control)return;
    if(param.type==='toggle')control.input.checked=params[param.name];
    else control.input.value=String(param.type==='select'?param.options.findIndex(option=>option.value===params[param.name]):params[param.name]);
    control.output.textContent=param.type==='select'?param.options.find(option=>option.value===params[param.name]).label:param.type==='toggle'?(params[param.name]?'开启':'关闭'):String(params[param.name]);
  };
  const normalize=(param,value)=>{
    if(param.type==='toggle'){if(typeof value!=='boolean')throw new Error('Invalid visual toggle');return value;}
    if(param.type==='select'){if(!param.options.some(option=>option.value===value))throw new Error('Invalid visual option');return value;}
    if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Invalid visual parameter');
    const clamped=Math.min(param.max,Math.max(param.min,value)),stepped=param.min+Math.round((clamped-param.min)/param.step)*param.step;
    return Math.min(param.max,Math.max(param.min,Number(stepped.toPrecision(15))));
  };
  function render(){
    const fragment=element('div',null);fragment.setAttribute('class','agent-visual-content');
    vars=Object.create(null);
    try{
      const evaluated=evaluateAgentVisualScene(visual,params);vars=evaluated.vars;
      const draw=(node,parent,inheritedFill=false)=>{
          const el=node.svg?owner.createElementNS(SVG,node.tag):owner.createElement(node.tag);
          const authoredFill=inheritedFill||node.attrs.some(attr=>attr.name==='fill');
          el.setAttribute('data-agent-node',node.id);
          if(node.tag==='svg'){el.setAttribute('role','img');el.setAttribute('aria-label',visual.title);el.style.setProperty('max-width','100%');}
          if(node.tag==='button')el.setAttribute('type','button');
          // SVG otherwise defaults to black, regardless of the host's text color.
          // Keep authored node/group fills (including dark text on light panels).
          if(node.svg&&(node.tag==='text'||node.tag==='tspan')&&!authoredFill)el.setAttribute('fill','currentColor');
          for(const attr of node.attrs)el.setAttribute(attr.name,attr.value);
          for(const style of node.style)el.style.setProperty(style.name,style.value);
          if(node.text!==null)el.textContent=node.text;
          if(node.action!==null){
            const action=actions.get(node.action);el.setAttribute('aria-label',action.label);
            // Listeners on the replaced scene are collected with its nodes. No event delegation
            // or model-provided selectors can address elements outside this visualization.
            el.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(!destroyed&&typeof onAction==='function')onAction(detached(action),{params:detached(params),visual:{title:visual.title,evidence_refs:[...visual.evidence_refs]}});});
          }
          parent.appendChild(el);
          for(const child of node.children)draw(child,el,authoredFill);
      };
      for(const node of evaluated.nodes)draw(node,fragment);
      scene.replaceChildren(fragment);lastError=null;
    }catch(error){
      // Hide the incomplete view; parameter changes can recover from an undefined formula.
      scene.replaceChildren();const message=element('p',scene,'当前参数下无法显示，请调整控件。','agent-visual-error');message.setAttribute('role','status');lastError='render_unavailable';
      throw error;
    }
  }
  const setParam=(name,value)=>{
    if(destroyed)throw new Error('Agent visualization has been destroyed');
    const param=doc.params.find(item=>item.name===name);if(!param)throw new Error('Unknown visual parameter');
    params[name]=normalize(param,value);updateControl(param);render();
  };
  for(const param of doc.params){
    const label=element('label',controlHost,undefined,'agent-visual-control');
    element('span',label,param.label,'agent-visual-control-label');
    const output=element('output',label,undefined,'agent-visual-control-value');
    const input=element(param.type==='select'?'select':'input',label);input.setAttribute('aria-label',param.label);input.setAttribute('data-agent-param',param.name);
    if(param.type==='select')for(let index=0;index<param.options.length;index++){const option=element('option',input,param.options[index].label);option.setAttribute('value',String(index));}
    else if(param.type==='toggle')input.setAttribute('type','checkbox');
    else{input.setAttribute('type','range');input.setAttribute('min',String(param.min));input.setAttribute('max',String(param.max));input.setAttribute('step',String(param.step));}
    controls.set(param.name,{input,output});updateControl(param);
    listen(input,param.type==='range'?'input':'change',()=>{
      const value=param.type==='toggle'?input.checked:param.type==='select'?param.options[Number(input.value)]?.value:Number(input.value);
      try{setParam(param.name,value);}catch{ /* A bounded formula failure stays inside its scene. */ }
    });
  }
  const destroy=()=>{if(destroyed)return;destroyed=true;for(const remove of listeners)remove();root.remove();};
  try{render();host.appendChild(root);}catch(error){destroy();throw error;}
  return {destroy,setParam,getState:()=>({params:detached(params),vars:detached(vars),error:lastError})};
}
