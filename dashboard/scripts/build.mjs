import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {thinBootstrap} from './bootstrap.mjs';
const root=path.resolve(import.meta.dirname,'..');
const read=name=>fs.readFile(path.join(root,name),'utf8');
const [visualClient,visualSpec]=await Promise.all([read('ui/agent-visual.js'),read('shared/agent-visual.mjs')]);
const [page,css,client,playersClient,playersCss,coachClient,coachCss,syncClient,nativeClient,nativeCss,initial,server,query,storage,coach,sync,syncImport,nativeJobs,manifest]=await Promise.all([read('ui/index.html'),read('ui/styles.css'),read('ui/app.js'),read('ui/players.js'),read('ui/players.css'),read('ui/coach.js'),read('ui/coach.css'),read('ui/sync.js'),read('ui/native-render.js'),read('ui/native-render.css'),read('data/dashboard.json'),read('worker/server.mjs'),read('worker/query.mjs'),read('worker/storage.mjs'),read('worker/coach.mjs'),read('worker/sync.mjs'),read('worker/sync-import.mjs'),read('worker/native-jobs.mjs'),read('.openai/hosting.json')]);
const [agentRuntime,agentTools,agentInstructions,agentStream,agentBulk,agentCompute]=await Promise.all([read('worker/agent-runtime.mjs'),read('worker/agent-tools.mjs'),read('worker/agent-instructions.mjs'),read('worker/agent-stream.mjs'),read('worker/agent-bulk.mjs'),read('worker/agent-compute.mjs')]);
const [agentWorkflow,agentReasoning,agentRegistry,workflowClient,workflowCss,reasoningClient,reasoningCss]=await Promise.all([read('worker/agent-workflow.mjs'),read('worker/agent-reasoning.mjs'),read('worker/agent-registry.mjs'),read('ui/agent-workflow.js'),read('ui/agent-workflow.css'),read('ui/agent-reasoning.js'),read('ui/agent-reasoning.css')]);
const parsed=JSON.parse(manifest); if(!parsed.project_id)throw Error('Registered project_id required');
const dataset=JSON.parse(initial); if(dataset.schema_version!=='1.0'||!Array.isArray(dataset.matches))throw Error('Reviewed dashboard dataset required');
const assets={};
const radarFiles=(await fs.readdir(path.join(root,'assets/radars'),{withFileTypes:true}))
 .filter(entry=>entry.isFile()&&entry.name.endsWith('.png'))
 .map(entry=>entry.name).sort();
for(const name of [...radarFiles,'sources.json']) {
 const bytes=await fs.readFile(path.join(root,'assets/radars',name));
 assets['/assets/radars/'+name]={base64:bytes.toString('base64'),type:name.endsWith('.png')?'image/png':'application/json; charset=utf-8'};
}
const helperArchive=await fs.readFile(path.join(root,'assets/local-render/cs2lab-windows.zip')).catch(()=>null);
if(helperArchive)assets['/assets/local-render/cs2lab-windows.zip']={base64:helperArchive.toString('base64'),type:'application/zip'};
await fs.rm(path.join(root,'dist'),{recursive:true,force:true});
await fs.mkdir(path.join(root,'dist/server'),{recursive:true});
await fs.mkdir(path.join(root,'dist/.openai'),{recursive:true});
const inlineStorageServer=server.replace(/^import \{[^\n]+\} from '\.\/storage\.mjs';\r?\n/,'');
if(inlineStorageServer===server)throw Error('Storage module import was not inlined');
const withoutServices=inlineStorageServer.replace(/^import \{[^\n]+\} from '\.\/(?:coach|sync|sync-import|native-jobs|agent-runtime)\.mjs';\r?\n/gm,'');
const inlineCoach=coach.replace(/^import \{[^\n]+\} from '(?:\.\/query\.mjs|\.\.\/shared\/agent-visual\.mjs|\.\/agent-(?:runtime|tools|instructions|stream|bulk|compute|reasoning)\.mjs)';\r?\n/gm,'');
const inlineAgentCompute='const {catalogStatistics,computeStatistics,STATISTICS_QUERY_SCHEMA,STATISTICS_CATALOG_SCHEMA,STATISTICS_COMPUTE_VERSION}=(()=>{\n'+agentCompute.replace(/^export /gm,'')+'\nreturn {catalogStatistics,computeStatistics,STATISTICS_QUERY_SCHEMA,STATISTICS_CATALOG_SCHEMA,STATISTICS_COMPUTE_VERSION};\n})();';
const inlineAgentBulk='const {BULK_STATISTICS_LIMITS,prepareStatisticsPack,combineStatisticsPacks,decodeStatisticsColumns,statisticsLoadBatch,restoreStatisticsPack}=(()=>{\n'+agentBulk.replace(/^export /gm,'')+'\nreturn {BULK_STATISTICS_LIMITS,prepareStatisticsPack,combineStatisticsPacks,decodeStatisticsColumns,statisticsLoadBatch,restoreStatisticsPack};\n})();';
const inlineAgentStream='const {AgentStreamError,readResponsesStream,createAgentStreamResponse,parseAgentStreamId}=(()=>{\n'+agentStream.replace(/^import \{[^\n]+\} from '(?:\.\.\/shared\/agent-visual\.mjs|\.\/query\.mjs)';\r?\n/gm,'').replace(/^export /gm,'')+'\nreturn {AgentStreamError,readResponsesStream,createAgentStreamResponse,parseAgentStreamId};\n})();';
const inlineAgentWorkflow='const {projectAgentWorkflow}=(()=>{\n'+agentWorkflow.replace(/^export /gm,'')+'\nreturn {projectAgentWorkflow};\n})();';
const inlineAgentReasoning='const {PROVIDER_TRACE_LIMITS,providerTraceTail,publicProviderReasoning,appendProviderReasoning,createProviderTraceCollector}=(()=>{\n'+agentReasoning.replace(/^export /gm,'')+'\nreturn {PROVIDER_TRACE_LIMITS,providerTraceTail,publicProviderReasoning,appendProviderReasoning,createProviderTraceCollector};\n})();';
const inlineAgentRegistry='const {AgentRegistryError,createAgentToolRegistry}=(()=>{\n'+agentRegistry.replace(/^export /gm,'')+'\nreturn {AgentRegistryError,createAgentToolRegistry};\n})();';
const inlineAgentRuntime='const {AGENT_EXECUTION_WINDOW,AgentRuntimeError,createAgentRuntime,createMemoryAgentStore,createR2AgentStore,parseAgentConversation}=(()=>{\n'+agentRuntime.replace(/^import \{[^\n]+\} from '[^'\n]+';\r?\n/gm,'').replace(/^export /gm,'')+'\nreturn {AGENT_EXECUTION_WINDOW,AgentRuntimeError,createAgentRuntime,createMemoryAgentStore,createR2AgentStore,parseAgentConversation};\n})();';
const inlineAgentTools='const {agentDataTools,agentToolQuery,AGENT_DATA_TOOL_NAMES,AGENT_PLAN_TOOL,AGENT_PLAN_TOOL_NAME,AGENT_PROGRESS_TOOL,AGENT_PROGRESS_TOOL_NAME,AGENT_WORKFLOW_TOOL,AGENT_WORKFLOW_TOOL_NAME,composeAgentTools}=(()=>{\n'+agentTools.replace(/^import \{[^\n]+\} from \'\.\/(?:query|agent-compute|agent-registry)\.mjs\';\r?\n/gm,'').replace(/^export /gm,'')+'\nreturn {agentDataTools,agentToolQuery,AGENT_DATA_TOOL_NAMES,AGENT_PLAN_TOOL,AGENT_PLAN_TOOL_NAME,AGENT_PROGRESS_TOOL,AGENT_PROGRESS_TOOL_NAME,AGENT_WORKFLOW_TOOL,AGENT_WORKFLOW_TOOL_NAME,composeAgentTools};\n})();';
const inlineAgentInstructions=agentInstructions.replace(/^export /gm,'');
const inlineVisual='const {AGENT_VISUAL_DOCUMENT_SCHEMA,bindAgentVisualizations,validateBoundAgentVisualization,projectAgentVisualBindingData,AGENT_VISUAL_GUIDANCE,inspectAgentJsonSchema}=(()=>{\n'+visualSpec.replace(/^export /gm,'')+'\nreturn {AGENT_VISUAL_DOCUMENT_SCHEMA,bindAgentVisualizations,validateBoundAgentVisualization,projectAgentVisualBindingData,AGENT_VISUAL_GUIDANCE,inspectAgentJsonSchema};\n})();';
const inlineSyncImport=syncImport.replace(/^import \{[^\n]+\} from '\.\/storage\.mjs';\r?\n/,'');
const inlineServer=withoutServices.replace(/^import \{QUERY_TOOLS, runQuery, parseQueryRequest, queryError, QueryError\} from '\.\/query\.mjs';\r?\n/,'');
if(inlineServer===inlineStorageServer)throw Error('Query module import was not inlined');
// Keep the native media parser's local names separate from the main Worker.
const inlineNative='const {createNativeJobHandler,createNativeQueryReader}=(()=>{\n'+nativeJobs.replace(/^export /gm,'')+'\nreturn {createNativeJobHandler,createNativeQueryReader};\n})();';
await fs.writeFile(path.join(root,'dist/server/index.js'),query+'\n'+storage+'\n'+inlineVisual+'\n'+inlineAgentWorkflow+'\n'+inlineAgentReasoning+'\n'+inlineAgentRegistry+'\n'+inlineAgentRuntime+'\n'+inlineAgentCompute+'\n'+inlineAgentTools+'\n'+inlineAgentInstructions+'\n'+inlineAgentStream+'\n'+inlineAgentBulk+'\n'+inlineCoach+'\n'+sync+'\n'+inlineSyncImport+'\n'+inlineNative+'\n'+inlineServer+'\nexport default makeWorker('+JSON.stringify({page,css,client,playersClient,playersCss,coachClient,coachCss,syncClient,nativeClient,nativeCss,visualClient,visualSpec,workflowClient,workflowCss,reasoningClient,reasoningCss,initial:thinBootstrap(dataset),assets})+');\n');
await fs.writeFile(path.join(root,'dist/.openai/hosting.json'),manifest);
const built=await import(pathToFileURL(path.join(root,'dist/server/index.js')).href+'?verified='+Date.now());
if(typeof built.default.fetch!=='function')throw Error('Invalid worker export');
console.log('Built verified personal Dashboard Worker: '+dataset.matches.length+' matches');
