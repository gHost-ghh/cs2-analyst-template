import http from 'node:http';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {makeWorker} from '../worker/server.mjs';
import {createMemoryAgentStore} from '../worker/agent-runtime.mjs';
import {once} from 'node:events';
const root=new URL('../',import.meta.url);
const read=name=>fs.readFile(new URL(name,root),'utf8');
export function createPreviewServer(){const coachSessionStore=createMemoryAgentStore();const server=http.createServer(async(req,res)=>{
 try{
 const initial=JSON.parse(await read('data/dashboard.json'));
 const assets={};
 const radarFiles=(await fs.readdir(new URL('assets/radars/',root),{withFileTypes:true}))
  .filter(entry=>entry.isFile()&&entry.name.endsWith('.png'))
  .map(entry=>entry.name).sort();
 for(const name of [...radarFiles,'sources.json']) {
  const bytes=await fs.readFile(new URL('assets/radars/'+name,root));
  assets['/assets/radars/'+name]={base64:bytes.toString('base64'),type:name.endsWith('.png')?'image/png':'application/json; charset=utf-8'};
 }
 const helper=await fs.readFile(new URL('assets/local-render/cs2lab-windows.zip',root)).catch(()=>null);
 if(helper)assets['/assets/local-render/cs2lab-windows.zip']={base64:helper.toString('base64'),type:'application/zip'};
 const modules={page:'ui/index.html',css:'ui/styles.css',client:'ui/app.js',playersClient:'ui/players.js',playersCss:'ui/players.css',coachClient:'ui/coach.js',coachCss:'ui/coach.css',syncClient:'ui/sync.js',nativeClient:'ui/native-render.js',nativeCss:'ui/native-render.css',visualClient:'ui/agent-visual.js',visualSpec:'shared/agent-visual.mjs',workflowClient:'ui/agent-workflow.js',workflowCss:'ui/agent-workflow.css',reasoningClient:'ui/agent-reasoning.js',reasoningCss:'ui/agent-reasoning.css'};
 const source=Object.fromEntries(await Promise.all(Object.entries(modules).map(async([key,file])=>[key,await read(file)])));
 const worker=makeWorker({...source,initial,assets,coachSessionStore});
 const chunks=[];let bytes=0;
 for await(const chunk of req){bytes+=chunk.length;if(bytes>32*1024*1024){res.writeHead(413);res.end('Preview request too large');return;}chunks.push(chunk);}
 const url=`http://127.0.0.1:${server.address().port}`+req.url;
 const body=['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks);
 const disconnect=new AbortController();res.once('close',()=>{if(!res.writableEnded)disconnect.abort();});
 const request=new Request(url,{method:req.method,headers:req.headers,signal:disconnect.signal,...(body===undefined?{}:{body})});
 const response=await worker.fetch(request,{});
 res.writeHead(response.status,Object.fromEntries(response.headers));
 if(response.body){const reader=response.body.getReader();try{while(true){const chunk=await reader.read();if(chunk.done)break;if(res.destroyed){await reader.cancel();break;}if(!res.write(Buffer.from(chunk.value)))await once(res,'drain',{signal:disconnect.signal});}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}}
 if(!res.destroyed)res.end();
 }catch{if(!res.destroyed){if(!res.headersSent){res.writeHead(500);res.end('Local preview could not complete this request');}else res.destroy();}}
 });return server;}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){const server=createPreviewServer();server.listen(4173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4173/'));}
