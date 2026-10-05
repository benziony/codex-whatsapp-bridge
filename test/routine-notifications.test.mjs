import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CodexWhatsAppBroker } from '../scripts/lib/bridge-state.mjs';
import { classifyRoutineTurn, fingerprintError, routineConfigFrom } from '../scripts/lib/routine-notifications.mjs';
const rootRepo=path.resolve(import.meta.dirname,'..');
const chat='120363000000000001@g.us',sender='15550000001@s.whatsapp.net';
const sid='11111111-1111-4111-8111-111111111111';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const family=hash('scheduled-maintenance');
const policy={enabled:true,timeZone:'America/New_York',hour:18};
const routine=(kind='healthy',body='All checks passed.')=>({defer:true,kind,label:'Scheduled check',family,fingerprint:hash(body)});
const input=(turnId,kind='healthy',body='All checks passed.',originHost='fixture')=>({originHost,sessionId:sid,turnId,finalText:body,routine:routine(kind,body)});
function fixture(t,now=Date.UTC(2026,6,15,22)){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'routine-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const clock={now};
 const make=(p=policy)=>new CodexWhatsAppBroker({statePath:path.join(root,'state.json'),notificationTarget:chat,allowedSenders:[sender],allowedChats:[chat],routinePolicy:p,now:()=>clock.now});
 return {root,clock,make,broker:make()};
}
const candidate=(body)=>({threadSource:'automation',firstUserMessage:'scheduled check',currentPrompt:'scheduled check',promptReadable:true,finalText:body});
function child(script,args,body,env){return new Promise((resolve,reject)=>{
 const cp=spawn(process.execPath,[script,...args],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 const timer=setTimeout(()=>{cp.kill();reject(new Error('fixture process timeout'));},15000);
 cp.stdout.on('data',x=>stdout+=x);cp.stderr.on('data',x=>stderr+=x);cp.on('error',reject);cp.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`fixture failed (${code}): ${stdout} ${stderr}`));else resolve(stdout.trim()?JSON.parse(stdout):null);});cp.stdin.end(JSON.stringify(body));
});}
async function pipeline(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'routine-pipeline-'));const calls=[];let rejectSend=false,uncertain=false,delay=0;
 const server=http.createServer(async(req,res)=>{let b='';for await(const x of req)b+=x;calls.push(JSON.parse(b));if(delay)await new Promise(r=>setTimeout(r,delay));res.setHeader('content-type','application/json');if(rejectSend){res.statusCode=503;res.end('{}');}else if(uncertain)res.end('{}');else res.end(JSON.stringify({messageIds:[`WA.${calls.length}`]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const home=path.join(root,'codex');fs.mkdirSync(home);const cfg=path.join(root,'config.json');
 const config={schemaVersion:1,role:'combined',hostId:'fixture',codex:{home,mirrorProgress:false,statePath:path.join(root,'client.json'),routineNotifications:{mode:'daily',timeZone:'America/New_York',hour:0}},gateway:{repositoryPath:rootRepo,statePath:path.join(root,'broker.json')},whatsapp:{chatId:chat,allowedSenders:[sender],bridgeUrl:`http://127.0.0.1:${server.address().port}`}};
 fs.writeFileSync(cfg,JSON.stringify(config));const database=path.join(home,'state_5.sqlite');const db=new DatabaseSync(database);
 db.exec('CREATE TABLE projects(id TEXT,name TEXT); CREATE TABLE threads(id TEXT,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,archived INTEGER,git_origin_url TEXT,thread_source TEXT,project_id TEXT)');
 const scheduled='Run the scheduled check';db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0,NULL,?,NULL)').run(sid,'Routine check','Routine check',scheduled,root,'automation');db.close();
 const env={CODEX_WHATSAPP_CONFIG:cfg,CODEX_WHATSAPP_CODEX_DB:database,CODEX_WHATSAPP_CLIENT_STATE:path.join(root,'client.json'),NODE_NO_WARNINGS:'1'};
 const broker=(command,payload={})=>child(path.join(rootRepo,'scripts/codex-whatsapp-broker.mjs'),[command],payload,env);
 const hook=async(body,turnId='t1',prompt=scheduled)=>{const transcript=path.join(root,turnId+'.jsonl');fs.writeFileSync(transcript,[{type:'event_msg',payload:{type:'task_started',turn_id:turnId}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}}].map(JSON.stringify).join('\n'));return child(path.join(rootRepo,'scripts/codex-whatsapp-client.mjs'),['hook'],{hook_event_name:'Stop',session_id:sid,turn_id:turnId,transcript_path:transcript,last_assistant_message:body},env);};
 const state=()=>JSON.parse(fs.readFileSync(path.join(root,'broker.json')));
 return {root,config,cfg,calls,hook,broker,state,setReject:v=>rejectSend=v,setUncertain:v=>uncertain=v,setDelay:v=>delay=v};
}

test('routine classification keeps user, unknown, requests and work completion immediate',()=>{
 assert.equal(routineConfigFrom({codex:{routineNotifications:{mode:'daily'}}}).enabled,true);
 assert.equal(classifyRoutineTurn({...candidate('no action required'),threadSource:'user'}).defer,false);
 for(const body of ['The certificate expires tomorrow.','Not healthy; service is unavailable.','Please approve this.','Unchanged checks; deployed the feature.','All checks passed; shipped the feature.','No action required, merged update.','Routine check: certificate expires tomorrow.'])assert.equal(classifyRoutineTurn(candidate(body)).defer,false,body);
 assert.equal(classifyRoutineTurn(candidate('No action required.')).defer,true);
 assert.equal(classifyRoutineTurn(candidate('Checks completed successfully, nothing changed.')).defer,true);
 assert.notEqual(fingerprintError('E_SERVICE: '+ 'x'.repeat(300)+'disk full'),fingerprintError('E_SERVICE: '+ 'x'.repeat(300)+'certificate invalid'));
});
test('disabled broker does not accept a deferral hint',t=>{
 const f=fixture(t);const b=f.make({enabled:false});assert.ok(b.create(input('t1')).notification);
 const root=path.join(f.root,'default');const b2=new CodexWhatsAppBroker({statePath:path.join(root,'state.json'),notificationTarget:chat});assert.ok(b2.create(input('t2')).notification);
});
test('queued turn replay counts once after aggregation, restart, and flush',t=>{
 const f=fixture(t);f.broker.create(input('t1'));f.broker.create(input('t2'));f.make().create(input('t2'));
 assert.equal(f.broker.store.load().routineQueue.reduce((n,x)=>n+x.count,0),2);
 const d=f.broker.flushRoutineDigest({date:'1900-01-01',host:'one'});assert.ok(d.notification);
 f.broker.finishNotification({routeId:d.route.id,notificationDeliveryId:d.notificationDeliveryId,sent:true,messageIds:['WA.1']});
 f.make().create(input('t2'));assert.equal(f.broker.store.load().routineQueue.length,0);
});
test('gateway clock owns 18:00 and one global digest; late checks wait for next day',t=>{
 const f=fixture(t,Date.UTC(2026,6,15,21,59));f.broker.create(input('t1'));
 assert.equal(f.broker.flushRoutineDigest({date:'2099-01-01',includeLate:true,host:'one'}).notification,undefined);
 f.clock.now=Date.UTC(2026,6,15,22);const d=f.broker.flushRoutineDigest({host:'one'});assert.ok(d.notification);
 f.broker.finishNotification({routeId:d.route.id,notificationDeliveryId:d.notificationDeliveryId,sent:true,messageIds:['WA.1']});
 f.broker.create(input('t2','healthy','All checks passed.','other'));
 assert.equal(f.broker.flushRoutineDigest({host:'other'}).notification,undefined);
 assert.equal(f.broker.store.load().routineQueue.reduce((n,x)=>n+x.count,0),1);
 f.clock.now=Date.UTC(2026,6,16,22);assert.ok(f.make().flushRoutineDigest().notification);
 const winter=fixture(t,Date.UTC(2026,0,15,22,59));winter.broker.create(input('winter'));assert.equal(winter.broker.flushRoutineDigest().notification,undefined);
 winter.clock.now=Date.UTC(2026,0,15,23);assert.ok(winter.broker.flushRoutineDigest().notification);
});
test('only a matching delivered failure can group; changed failures and failed alerts stay immediate',t=>{
 const f=fixture(t);const b=f.broker;const first=b.create(input('a','failure','E_SERVICE: disk full'));assert.ok(first.notification);
 b.finishNotification({routeId:first.route.id,notificationDeliveryId:first.notificationDeliveryId,sent:false});
 const partial=b.create(input('b','failure','E_SERVICE: disk full'));assert.ok(partial.notification);
 b.finishNotification({routeId:partial.route.id,notificationDeliveryId:partial.notificationDeliveryId,sent:true,partial:true,messageIds:['WA.partial']});
 assert.ok(b.create(input('partial-retry','failure','E_SERVICE: disk full')).notification);
 const delivered=b.create(input('c','failure','E_SERVICE: disk full'));b.finishNotification({routeId:delivered.route.id,notificationDeliveryId:delivered.notificationDeliveryId,sent:true,messageIds:['WA.1']});
 assert.equal(b.create(input('d','failure','E_SERVICE: disk full')).notification,undefined);
 assert.ok(b.create(input('e','failure','E_SERVICE: certificate invalid')).notification);
});
test('digest reservation cannot be reused concurrently and recovers a crash before send intent',t=>{
 const f=fixture(t);f.broker.create(input('a'));const d=f.broker.flushRoutineDigest();assert.ok(d.notification);
 assert.equal(f.make().flushRoutineDigest().notification,undefined);
 f.clock.now+=20*60*1000;const recovered=f.make().flushRoutineDigest();assert.ok(recovered.notification);assert.equal(recovered.route.id,d.route.id);
});
test('a crash after send intent preserves count evidence and does not blindly resend',t=>{
 const f=fixture(t);f.broker.create(input('a'));const d=f.broker.flushRoutineDigest();
 f.broker.beginNotificationDelivery({routeId:d.route.id,notificationDeliveryId:d.notificationDeliveryId});
 f.clock.now+=20*60*1000;assert.equal(f.make().flushRoutineDigest().notification,undefined);
 const saved=f.broker.store.load().routes.find(x=>x.id===d.route.id);assert.equal(saved.digestItems.reduce((n,x)=>n+x.count,0),1);
});
test('real SQLite and native transcript hook path defers routine but keeps unknown titles, human replies, and approvals immediate',async t=>{
 const f=await pipeline(t);await f.hook('All checks passed.');assert.equal(f.calls.length,0);assert.equal(f.state().routineQueue.reduce((n,x)=>n+x.count,0),1);
 await f.hook('The certificate expires tomorrow.','t2');assert.equal(f.calls.length,1);
 await f.hook('All checks passed.','t3','Please do another thing');assert.equal(f.calls.length,2);
 await f.hook('Please approve access.','t4');assert.equal(f.calls.length,3);
});
test('real Stop hook suppresses only a confirmed repeated error, then sends changed error',async t=>{
 const f=await pipeline(t);await f.hook('BLOCKED E_SERVICE: disk full','t1');assert.equal(f.calls.length,1);
 await f.hook('BLOCKED E_SERVICE: disk full','t2');assert.equal(f.calls.length,1);
 await f.hook('BLOCKED E_SERVICE: disk full\nE_DATABASE: backup corrupt','t3');assert.equal(f.calls.length,2);
 await f.hook('BLOCKED E_SERVICE: certificate invalid','t4');assert.equal(f.calls.length,3);
});
test('real broker CLI serializes flushes, rejects digest quotes and preserves definite send failure for retry',async t=>{
 const f=await pipeline(t);await f.hook('All checks passed.');f.setDelay(100);
 await Promise.all([f.broker('flush-routine'),f.broker('flush-routine')]);assert.equal(f.calls.length,1);
 const d=f.state().routes.find(x=>x.digestIdentity);assert.equal(d.notification.status,'sent');
 const q=await f.broker('ingest',{chatId:chat,senderId:sender,messageId:'IN.1',quotedMessageId:'WA.1',text:'Do another thing'});assert.equal(q.status,'digest-quote-rejected');assert.equal(f.state().replies.length,0);
 const rejected=await pipeline(t);await rejected.hook('All checks passed.');rejected.setReject(true);await rejected.broker('flush-routine');const r=rejected.state().routes.find(x=>x.digestIdentity);assert.equal(r.notification.status,'failed');assert.ok(r.finalText);
});
test('concurrent duplicate hook admissions count once in the atomic broker store',async t=>{
 const f=await pipeline(t);await Promise.all(Array.from({length:4},()=>f.broker('create',input('same'))));assert.equal(f.calls.length,0);assert.equal(f.state().routineQueue.reduce((n,x)=>n+x.count,0),1);
});

test('replayed initial failure and late acknowledgements cannot rewrite the newest outcome',t=>{
 const f=fixture(t);const a=f.broker.create(input('a','failure','E_SERVICE: disk full'));
 f.broker.finishNotification({routeId:a.route.id,notificationDeliveryId:a.notificationDeliveryId,sent:true,messageIds:['WA.a']});
 f.broker.create(input('a','failure','E_SERVICE: disk full'));assert.equal(f.broker.store.load().routineQueue.length,0);
 const b=f.broker.create(input('b','failure','E_SERVICE: certificate invalid'));
 const c=f.broker.create(input('c','failure','E_SERVICE: new outage'));
 f.broker.finishNotification({routeId:b.route.id,notificationDeliveryId:b.notificationDeliveryId,sent:true,messageIds:['WA.b']});
 assert.ok(f.broker.create(input('d','failure','E_SERVICE: certificate invalid')).notification);
 assert.ok(c.notification);
});
test('queue saturation stays immediate, and disabling the policy stops pending flushes',t=>{
 const f=fixture(t);
 for(let n=0;n<50;n++){const v=input('t'+n);v.routine.label='Check '+n;f.broker.create(v);}
 const extra=input('overflow');extra.routine.label='Different check';assert.ok(f.broker.create(extra).notification);
 assert.equal(f.make({enabled:false}).flushRoutineDigest().notification,undefined);
});
test('expired intent lease fails closed and repeated crashes before intent do not consume send attempts',t=>{
 const f=fixture(t);f.broker.create(input('a'));let d=f.broker.flushRoutineDigest();
 f.clock.now+=20*60*1000;
 assert.throws(()=>f.broker.beginNotificationDelivery({routeId:d.route.id,notificationDeliveryId:d.notificationDeliveryId}));
 for(let n=0;n<4;n++){d=f.broker.flushRoutineDigest();assert.ok(d.notification);f.clock.now+=20*60*1000;}
});
test('definitely failed and unconfirmed snapshots remain represented in the next daily summary',t=>{
 const f=fixture(t);f.broker.create(input('a'));const d=f.broker.flushRoutineDigest();f.broker.beginNotificationDelivery({routeId:d.route.id,notificationDeliveryId:d.notificationDeliveryId});
 f.broker.finishNotification({routeId:d.route.id,notificationDeliveryId:d.notificationDeliveryId,sent:false,uncertain:true});
 f.clock.now+=24*60*60*1000;const next=f.broker.flushRoutineDigest();assert.ok(next.notification);assert.match(next.notification.messages[0],/unconfirmed/i);
 assert.equal(f.broker.store.load().routes.find(x=>x.id===next.route.id).digestItems.reduce((n,x)=>n+x.count,0),1);
 const failed=fixture(t);failed.broker.create(input('b'));const q=failed.broker.flushRoutineDigest();failed.broker.finishNotification({routeId:q.route.id,notificationDeliveryId:q.notificationDeliveryId,sent:false});
 assert.equal(failed.broker.flushRoutineDigest().notification,undefined);
 failed.clock.now+=24*60*60*1000;assert.ok(failed.broker.flushRoutineDigest().notification);
});
