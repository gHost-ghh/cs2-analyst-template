// Provider text is untrusted display content, escaped before rendering.
const limit=64*1024,encoder=new TextEncoder(),decoder=new TextDecoder();
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function prepareProviderTrace(value){
  if(!Array.isArray(value))return [];
  let remaining=limit;const output=[];
  for(const item of value.slice(-8).reverse()){
    if(!item||item.provider!=='deepseek'||typeof item.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(item.model)||!Number.isSafeInteger(item.attempt)||item.attempt<1||!['streaming','completed','interrupted'].includes(item.status)||typeof item.text!=='string'||output.some(value=>value.attempt===item.attempt))continue;
    if(remaining<=0)break;const bytes=encoder.encode(item.text);let start=Math.max(0,bytes.length-remaining);while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;const text=decoder.decode(bytes.subarray(start));remaining-=encoder.encode(text).length;
    output.push({attempt:item.attempt,provider:'deepseek',model:item.model,status:item.status,text,truncated:item.truncated===true||start>0,...(typeof item.at==='string'?{at:item.at.slice(0,40)}:{})});
  }
  return output.reverse();
}
export function reduceProviderTrace(previous,payload,attempt){
  if(!payload||Object.keys(payload).some(key=>!['provider','model','text','status','reset','truncated'].includes(key))||payload.provider!=='deepseek'||typeof payload.text!=='string'||payload.text.length>8192||!['streaming','completed','interrupted'].includes(payload.status)||typeof payload.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(payload.model)||!Number.isSafeInteger(attempt)||attempt<1)return null;
  const items=prepareProviderTrace(previous),old=items.find(item=>item.attempt===attempt);
  if(old&&old.status!=='streaming'&&payload.status==='streaming'&&!payload.reset)return null;
  const entry={attempt,provider:'deepseek',model:payload.model,status:payload.status,text:(payload.reset?'':old?.text??'')+payload.text,truncated:old?.truncated===true||payload.truncated===true};
  return prepareProviderTrace([...items.filter(item=>item.attempt!==attempt),entry]);
}
export function renderProviderTrace(value){
  const items=prepareProviderTrace(value).filter(item=>item.text||item.status==='streaming');if(!items.length)return '';
  const labels={streaming:'正在推理',completed:'本次响应已结束',interrupted:'响应已中断'};
  return `<details class="coach-provider-trace" data-coach-expand="provider-trace"><summary><span>DeepSeek 推理</span><small>${items.length} 次响应 · 默认收起</small></summary><p class="coach-provider-note">模型提供的推理文本；结论与工具结果以下方已核对证据为准。</p>${items.map(item=>`<details class="coach-provider-attempt" data-coach-expand="provider-attempt-${item.attempt}"><summary>响应 ${item.attempt}<span>${labels[item.status]}</span></summary><pre>${escape(item.text||'等待模型文本…')}</pre>${item.truncated?'<p class="coach-provider-note">显示最近的推理文本，较早部分未保留；这不会限制模型生成。</p>':''}</details>`).join('')}</details>`;
}
