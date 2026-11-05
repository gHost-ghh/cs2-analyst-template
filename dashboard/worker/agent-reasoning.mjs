// Explicit provider-supplied DeepSeek reasoning text. This is a display trace,
// never an instruction, a tool result, or the runtime's evidence of progress.
export const PROVIDER_TRACE_LIMITS=Object.freeze({bytes:64*1024,attempts:8,delta_characters:8192});
const encode=new TextEncoder(),decode=new TextDecoder();
const statuses=new Set(['streaming','completed','interrupted']);
export function providerTraceTail(text,maxBytes=PROVIDER_TRACE_LIMITS.bytes){
  const bytes=encode.encode(text);if(bytes.length<=maxBytes)return {text,truncated:false};
  let start=bytes.length-maxBytes;while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;
  return {text:decode.decode(bytes.subarray(start)),truncated:true};
}
export function publicProviderReasoning(value){
  if(!Array.isArray(value))return [];
  const output=[];let remaining=PROVIDER_TRACE_LIMITS.bytes;
  for(const item of value.slice(-PROVIDER_TRACE_LIMITS.attempts).reverse()){
    if(!item||item.provider!=='deepseek'||typeof item.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(item.model)||!Number.isSafeInteger(item.attempt)||item.attempt<1||!statuses.has(item.status)||typeof item.text!=='string'||typeof item.at!=='string'||!Number.isFinite(Date.parse(item.at))||output.some(value=>value.attempt===item.attempt))continue;
    if(remaining<=0)break;const tail=providerTraceTail(item.text,remaining);remaining-=encode.encode(tail.text).length;
    output.push({attempt:item.attempt,provider:'deepseek',model:item.model,status:item.status,text:tail.text,truncated:item.truncated===true||tail.truncated,at:item.at});
  }
  return output.reverse();
}
export function appendProviderReasoning(turn,value,stamp){
  if(!value||Object.keys(value).some(key=>!['attempt','provider','model','text','status','truncated'].includes(key))||value.provider!=='deepseek'||typeof value.text!=='string'||encode.encode(value.text).length>8*1024*1024||!Number.isSafeInteger(value.attempt)||value.attempt<1||value.attempt<(turn.progress?.model_calls??0)||!statuses.has(value.status)||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value.model))throw Object.assign(Error('invalid_provider_trace'),{code:'invalid_provider_trace',status:400});
  const tail=providerTraceTail(value.text),entry={attempt:value.attempt,provider:'deepseek',model:value.model,status:value.status,text:tail.text,truncated:value.truncated===true||tail.truncated,at:new Date(stamp).toISOString()};
  turn.provider_trace=publicProviderReasoning([...(turn.provider_trace??[]).filter(item=>item.attempt!==entry.attempt),entry]);
  return structuredClone(entry);
}
export function createProviderTraceCollector({attempt,provider,model,emit=async()=>{},persist=async()=>{},now=()=>Date.now()}={}){
  let text='',truncated=false,ended=false,received=0,checkpoints=0,lastSaved=now();
  const payload=status=>({attempt,provider,model,text,status,truncated});
  return {
    async start(){await emit({provider,model,text:'',status:'streaming',reset:true});},
    async delta(value){
      if(ended||typeof value!=='string'||!value)return;
      received+=encode.encode(value).length;const tail=providerTraceTail(text+value);text=tail.text;truncated||=tail.truncated;
      await emit({provider,model,text:value,status:'streaming',truncated});
      // Keep a recoverable prefix while a slow provider is still generating,
      // without converting every token into an R2/CAS write.
      if(checkpoints<3&&(checkpoints===0?received>=8192:now()-lastSaved>=30000)){await persist(payload('streaming'));lastSaved=now();checkpoints++;}
    },
    async finish(status='completed'){
      if(ended)return;ended=true;
      if(text)await persist(payload(status));
      await emit({provider,model,text:'',status,truncated});
    },
    get hasText(){return Boolean(text);}
  };
}
