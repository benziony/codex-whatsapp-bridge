import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { PredictionBindingLedger } from '../scripts/lib/prediction-bindings.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const source = '11111111-1111-4111-8111-111111111111';
const prediction = '22222222-2222-4222-8222-222222222222';
const chat = '120363000000000001@g.us', sender = '15550000001@s.whatsapp.net';

// Contract owner: the actual Stop CLI must join a trusted prediction tuple to
// its original chat before sending, then native poll/quote input must preserve
// that suggestion. Earlier helper mocks supplied the join and could miss a
// broken Stop dispatch; broker-only coverage remains the owner of vote races.
function child(script, args, payload, env) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [path.join(repo, 'scripts', script), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { cp.kill(); reject(Error(`fixture timed out: ${script} ${args.join(' ')}`)); }, 15000);
    cp.stdout.on('data', x => stdout += x); cp.stderr.on('data', x => stderr += x);
    cp.once('error', reject);
    cp.once('close', code => { clearTimeout(timer); if (code) reject(Error(`fixture exit ${code}: ${stderr}`)); else resolve(stdout.trim() ? JSON.parse(stdout) : null); });
    cp.stdin.end(JSON.stringify(payload));
  });
}
async function fixture(t, { desktopOwned = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prediction-stop-'));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const id = `WA.${calls.length + 1}`;
    calls.push({ url: req.url, id, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/send-poll' ? { pollMessageId: id, messageIds: [id] } : { messageIds: [id] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const ledgerPath = path.join(root, 'private', 'bindings.json');
  const ledger = new PredictionBindingLedger(ledgerPath);
  const nativeCapture = path.join(root, 'native-starts.jsonl');
  const nativeLatest = path.join(root, 'latest-turn');
  const nativeCli = path.join(root, 'fixture-codex.mjs');
  fs.writeFileSync(nativeCli, `#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(process.argv[2]==='queue') {
 const args=process.argv.slice(2);
 fs.appendFileSync(process.env.NATIVE_CAPTURE,JSON.stringify({threadId:args[2],input:[{type:'text',text:args[4]}],args})+'\\n');
 process.exit(0);
}
for await(const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(m.id===undefined)continue;
 let result={};
 if(m.method==='thread/resume'&&process.env.NATIVE_ACTIVE_WRITER==='1') {emit({id:m.id,error:{code:-32000,message:'Thread '+m.params.threadId+' already has an active writer'}});continue;}
 if(m.method==='thread/resume') result={thread:{id:m.params.threadId,status:{type:'idle'}}};
 if(m.method==='thread/turns/list') result={data:[{id:fs.readFileSync(process.env.NATIVE_LATEST,'utf8'),status:'completed'}]};
 if(m.method==='turn/start') {
  fs.appendFileSync(process.env.NATIVE_CAPTURE,JSON.stringify(m.params)+'\\n');
  const id=crypto.randomUUID(); emit({id:m.id,result:{turn:{id}}});
  emit({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id,status:'completed',items:[{type:'agentMessage',text:'Fixture response returned to WhatsApp'}]}}});
 } else emit({id:m.id,result});
}
`);
  fs.chmodSync(nativeCli, 0o700);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, role: 'combined', hostId: 'fixture-host',
    codex: { binary: nativeCli, home: path.join(root, 'codex'), statePath: path.join(root, 'client.json') },
    gateway: { repositoryPath: repo, statePath: path.join(root, 'broker.json') },
    whatsapp: { chatId: chat, allowedSenders: [sender], bridgeUrl: `http://127.0.0.1:${server.address().port}` } }));
  const env = { ...process.env, CODEX_WHATSAPP_CONFIG: configPath, CODEX_PREDICTION_BINDINGS_PATH: ledgerPath, NODE_NO_WARNINGS: '1', NATIVE_LATEST: nativeLatest, NATIVE_CAPTURE: nativeCapture, NATIVE_ACTIVE_WRITER: desktopOwned ? '1' : '0' };
  const broker = (command, payload) => child('codex-whatsapp-broker.mjs', [command], payload, env);
  const stop = (sessionId, turnId, body) => child('codex-whatsapp-client.mjs', ['hook'], { hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId, last_assistant_message: body }, env);
  const bind = (turnId, predictionTurnId) => {
    fs.writeFileSync(nativeLatest, turnId);
    ledger.registerEphemeralThread({ threadId: prediction, sourceThreadId: source });
    ledger.recordPending({ requestId: predictionTurnId, threadId: prediction, sourceThreadId: source, sourceTurnId: turnId });
    ledger.finalizeByRequest({ requestId: predictionTurnId, threadId: prediction, turnId: predictionTurnId });
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8'));
  const deliver = () => child('codex-whatsapp-client.mjs', ['deliver'], {}, env);
  const starts = () => fs.readFileSync(nativeCapture, 'utf8').trim().split('\n').map(JSON.parse);
  return { calls, ledger, bind, stop, broker, state, deliver, starts };
}

for (const desktopOwned of [false, true]) test(`actual third-message approval and quoted additions survive source advancement (desktop owned: ${desktopOwned})`, async t => {
  const f = await fixture(t, { desktopOwned });
  for (const mode of ['approve-short', 'quote-short', 'approve-long', 'quote-long-poll', 'quote-long-text']) {
    const long = mode.includes('long');
    const quote = mode.startsWith('quote');
    const exact = mode === 'approve-long' ? 'L'.repeat(8_000) : long ? `Exact suggestion\n  ${'interior spaces '.repeat(20).trimEnd()}` : 'Exact suggestion\n  interior spaces';
    const sourceTurn = `source-${mode}`, predictionTurn = `prediction-${mode}`;
    await f.stop(source, sourceTurn, 'Completed source answer');
    f.bind(sourceTurn, predictionTurn);
    const before = f.calls.length;
    await f.stop(prediction, predictionTurn, JSON.stringify({ suggestion: `  ${exact}  ` }));
    assert.equal(f.calls.length, before + (long ? 2 : 1));
    const messages = f.calls.slice(before);
    const poll = messages.at(-1);
    assert.equal(poll.url, '/send-poll');
    assert.equal(poll.body.context, null);
    assert.equal(poll.body.question, long ? 'Send this suggestion?' : exact);
    if (long) { assert.equal(messages[0].url, '/send'); assert.equal(messages[0].body.message, exact); assert.equal(messages[0].body.singleMessage, true); }
    assert.deepEqual(poll.body.options, ['Send suggestion', 'Dismiss']);
    const route = f.state().routes.find(x => x.predictionTurnId === predictionTurn);
    assert.equal(route.sessionId, source); assert.equal(route.turnId, sourceTurn);
    assert.equal(route.suggestionText, exact);
    await f.stop(source, `advanced-${mode}`, 'The original chat has advanced');
    const submitted = !quote
      ? await f.broker('suggestion-poll-vote', { chatId: chat, senderId: sender, messageId: `IN.${mode}`, pollMessageId: poll.id, selectedOptions: ['Send suggestion'] })
      : await f.broker('ingest', { chatId: chat, senderId: sender, messageId: `IN.${mode}`, quotedMessageId: mode === 'quote-long-text' ? messages[0].id : poll.id, text: '  Added detail\nkeep this  ' });
    assert.equal(submitted.status, 'queued');
    const claimed = await f.broker('claim', { originHost: 'fixture-host' });
    assert.equal(claimed.reply.sessionId, source);
    assert.equal(claimed.reply.turnId, sourceTurn);
    assert.equal(claimed.reply.body, exact + (quote ? '\n\n  Added detail\nkeep this  ' : ''));
    await f.broker('release', { originHost: 'fixture-host', deliveryId: claimed.deliveryId });
    await f.deliver();
    const started = f.starts().at(-1);
    assert.equal(started.threadId, source);
    assert.deepEqual(started.input, [{ type: 'text', text: claimed.reply.body }]);
    if (desktopOwned) {
      assert.deepEqual(started.args, ['queue', '--thread', source, '--message', claimed.reply.body]);
      // The desktop's later completion returns through the existing Stop path.
      await f.stop(source, `returned-${mode}`, 'Fixture response returned to WhatsApp');
    }
    assert.equal(f.state().replies.find(x => x.id === claimed.reply.id).status, 'completed');
    assert.ok(f.calls.some(x => x.url === '/send' && JSON.stringify(x.body).includes('Fixture response returned to WhatsApp')));
  }
  assert.equal(f.starts().length, 5);
  await f.deliver();
  assert.equal(f.starts().length, 5, 'completed approval is never queued twice');
});

test('known abstained or malformed predictions are suppressed while ordinary suggestion JSON stays an answer', async t => {
  const f = await fixture(t);
  await f.stop(source, 'source', 'Answer');
  f.bind('source', 'prediction');
  const before = f.calls.length;
  for (const text of ['{"suggestion":null}', '{"suggestion":42}', 'invalid', '{"suggestion":"  "}']) await f.stop(prediction, 'prediction', text);
  assert.equal(f.calls.length, before);
  await f.stop(source, 'ordinary', '{"suggestion":"User requested JSON"}');
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.calls.at(-1).url, '/send');
});
