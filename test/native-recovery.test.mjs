import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runCodexAppServerTurn, CodexActiveWriterError, CodexTaskBusyError, CodexTurnStartUncertainError} from '../scripts/lib/codex-app-server.mjs';
function fixture({existing=false,resumeBusy=false,writerError=false}={}){
 const methods=[], child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};let resumed=false;
 const done={id:'prior-turn',status:'completed',items:[{type:'userMessage',clientId:'original-request'},{type:'agentMessage',text:'Synthetic completed result.'}]};
 child.stdin.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){const p=JSON.parse(line);methods.push(p.method);if(p.id===undefined)continue;let result,error;
 if(p.method==='initialize')result={};
 else if(p.method==='thread/read')result={thread:{id:'same-thread',status:{type:'notLoaded'},turns:existing?[done]:[]}};
 else if(p.method==='thread/resume'){assert.equal(p.params.threadId,'same-thread');resumed=true;if(writerError)error={code:-32000,message:'Thread same-thread already has an active writer'};else result={thread:{id:'same-thread',status:{type:resumeBusy?'active':'idle'},turns:[]}};}
 else if(p.method==='turn/start'){assert.equal(p.params.threadId,'same-thread');assert.equal(p.params.clientUserMessageId,'original-request');if(!resumed)error={code:-32000,message:'Thread is not loaded; resume first'};else result={turn:{id:'new-turn'}};}
 else throw Error('Unexpected RPC '+p.method);
 queueMicrotask(()=>{child.stdout.write(JSON.stringify({id:p.id,...(error?{error}:{result})})+'\n');if(p.method==='turn/start'&&!error)child.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'same-thread',turn:{...done,id:'new-turn'}}})+'\n')});
 }});
 return {methods,spawnTask:()=>child};
}
const options={codexBinary:'synthetic-codex',cwd:process.cwd(),prompt:'Synthetic pending delivery',requestId:'original-request',sessionId:'same-thread',rpcTimeoutMs:100,turnTimeoutMs:100};
test('prepared recovery resumes the exact saved thread before starting its original pending request',async()=>{const f=fixture(),starts=[];const result=await runCodexAppServerTurn({...options,spawnTask:f.spawnTask,execution:{stage:'prepared',registryBatch:[{seq:7,eventId:'event:default:7'}]},onTurnStarted:x=>starts.push(x)});assert.equal(result.sessionId,'same-thread');assert.equal(result.turnId,'new-turn');assert.deepEqual(f.methods,['initialize','initialized','thread/read','thread/resume','turn/start']);assert.equal(starts.length,1)});
test('already admitted recovery reads its existing turn without resume or a duplicate start',async()=>{const f=fixture({existing:true});const result=await runCodexAppServerTurn({...options,spawnTask:f.spawnTask,execution:{stage:'prepared'}});assert.equal(result.recovered,true);assert.deepEqual(f.methods,['initialize','initialized','thread/read'])});
test('uncertain turn recovery cannot resume and replay an unobserved turn',async()=>{const f=fixture();await assert.rejects(runCodexAppServerTurn({...options,spawnTask:f.spawnTask,execution:{stage:'turn-starting',uncertainUntil:new Date(Date.now()+60000).toISOString()}}),CodexTurnStartUncertainError);assert.deepEqual(f.methods,['initialize','initialized','thread/read'])});
test('a saved thread that becomes active while resuming cannot receive another turn',async()=>{const f=fixture({resumeBusy:true});await assert.rejects(runCodexAppServerTurn({...options,spawnTask:f.spawnTask,execution:{stage:'prepared'}}),CodexTaskBusyError);assert.deepEqual(f.methods,['initialize','initialized','thread/read','thread/resume'])});

test('recovery preserves active writer denial without starting a replacement thread or turn',async()=>{const f=fixture({writerError:true});await assert.rejects(runCodexAppServerTurn({...options,spawnTask:f.spawnTask,execution:{stage:'prepared'}}),CodexActiveWriterError);assert.deepEqual(f.methods,['initialize','initialized','thread/read','thread/resume'])});
