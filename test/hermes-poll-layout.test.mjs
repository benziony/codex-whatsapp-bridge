import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeHermesPollLayout } from '../scripts/lib/hermes-poll-layout.mjs';

// Small, generic excerpt of the reviewed seam. No session, account, or chat data.
const seam = `
const CODEX_WHATSAPP_BRIDGE_CAPABILITIES = 'native-polls-ledger-v1';
const POLL_LEDGER_TTL_MS = 2592000000;
const POLL_LEDGER_MAX = 512;
const pollInFlight = new Map();
const SEND_TIMEOUT_MS = 10;
function sendPollWithLateRecovery(chatId, payload, onResolved) {
  const sendPromise = enqueueSend(() => sock.sendMessage(chatId, payload));
  sendPromise.then((result) => { try { onResolved(result); } catch (error) { console.warn('[bridge] failed to persist late poll result:', error.message); } }, () => {});
  let timer;
  return Promise.race([sendPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(\`poll send timed out after \${SEND_TIMEOUT_MS / 1000}s\`)), SEND_TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
}
let pollLedger;
function loadPollLedger() {
  const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9._:+-]{1,256}$/.test(value);
  const validRecord = (item) => {
    if (!item || typeof item.deliveryKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.deliveryKey) || typeof item.payloadFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.payloadFingerprint) || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= Date.now()) return false;
    if (item.phase === 'context-pending') return !item.contextMessageId && !item.pollMessageId;
    if (item.phase === 'context-sent' || item.phase === 'poll-pending') return validId(item.contextMessageId) && !item.pollMessageId;
    if (item.phase === 'complete') return validId(item.contextMessageId) && validId(item.pollMessageId);
    return false;
  };
  return new Map(saved.filter(validRecord).map((item) => [item.deliveryKey, item]));
}
function getPollLedger() { return pollLedger || (pollLedger = loadPollLedger()); }
function restorePollIdsFromLedger() {
  for (const item of getPollLedger().values()) if (item.pollMessageId) recentlySentIds.remember(item.pollMessageId);
}
function persistPollLedger() { saved = [...pollLedger.values()].map((item) => ({ ...item })); }
function prunePollLedger() {}
function enqueuePollUpdateEvent({ key, update, selectedOptions, aggregation }) {
  const chatId = normalizeWhatsAppId(key?.remoteJid || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.remoteJid || '');
  const senderId = normalizeWhatsAppId(
    key?.participant
    || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.participant
    || chatId
  );
  const pollId = key?.id
    || update?.pollUpdates?.[0]?.pollCreationMessageKey?.id
    || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.id
    || '';
  if (!pollId || !recentlySentIds.has(pollId)) return;
  messageQueue.push({ chatId, senderId, pollId, selectedOptions, aggregation });
}
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates || []) {
      if (!update?.pollUpdates) continue;
      const pollUpdates = update.pollUpdates;
      const aggregation = aggregatePollVotes(pollUpdates);
      const selectedOptions = aggregation.map((item) => item.name);
      enqueuePollUpdateEvent({ key, update: { ...update, pollUpdates }, selectedOptions, aggregation });
    }
  });
app.post('/send', async (req, res) => {
  if (!sock || connectionState !== 'connected') return res.status(503).json({ error: 'Not connected' });
  const { chatId, message, replyTo } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId and message are required' });
  }
  try {
    const chunks = splitLongMessage(formatOutgoingMessage(message));
    const messageIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const { content: payload, options } = buildTextSendPayload(chunks[i], { chatId, replyTo: i === 0 ? replyTo : undefined, messageStore });
      const sent = await sendWithTimeout(chatId, payload, options);
      trackSentMessageId(sent);
      messageStore.remember(sent);
      if (sent?.key?.id) messageIds.push(sent.key.id);
    }
    return res.json({ success: true, messageId: messageIds.at(-1), messageIds });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});
app.post('/send-poll', async (req, res) => {
  if (!sock || connectionState !== 'connected') return res.status(503).json({ error: 'Not connected' });
  const { chatId, context, question, options, selectableCount, deliveryKey } = req.body;
  if (!chatId || typeof context !== 'string' || context.length < 1 || context.length > 1200 || typeof question !== 'string' || question.length < 1 || question.length > 500 || !Array.isArray(options) || options.length < 2 || options.length > 12 || options.some((value) => typeof value !== 'string' || !value.trim() || value.length > 100) || new Set(options).size !== options.length || !Number.isSafeInteger(selectableCount) || selectableCount < 1 || selectableCount > options.length || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(deliveryKey || ''))) return res.status(400).json({ error: 'Invalid poll payload' });
  const pollLedger = getPollLedger();
  prunePollLedger();
  const key = String(deliveryKey);
  const payloadFingerprint = createHash('sha256').update(JSON.stringify({ chatId, context, question, options, selectableCount })).digest('hex');
  const prior = pollLedger.get(key);
  if (prior && prior.payloadFingerprint !== payloadFingerprint) return res.status(409).json({ error: 'deliveryKey payload mismatch' });
  if (prior?.phase === 'context-pending' || prior?.phase === 'poll-pending') return res.status(425).json({ error: 'poll delivery outcome uncertain', retryAfter: 5 });
  if (prior?.pollMessageId) return res.json({ success: true, pollMessageId: prior.pollMessageId, messageIds: [prior.contextMessageId, prior.pollMessageId].filter(Boolean) });
  const existing = pollInFlight.get(key);
  if (existing) { try { return res.json(await existing); } catch (err) { return res.status(500).json({ error: err.message }); } }
  const operation = (async () => {
    const createdAt = Date.now();
    let contextMessageId = prior?.contextMessageId;
    if (!contextMessageId) {
      const createdAt = Date.now();
      pollLedger.set(key, { deliveryKey: key, payloadFingerprint, phase: 'context-pending', createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS });
      persistPollLedger();
      const contextMessage = await sendPollWithLateRecovery(chatId, { text: context }, (late) => {
        const id = late?.key?.id;
        if (!id) return;
        const current = getPollLedger().get(key);
        if (current?.phase === 'context-pending') { current.contextMessageId = id; current.phase = 'context-sent'; persistPollLedger(); trackSentMessageId(late); }
      });
      contextMessageId = contextMessage?.key?.id;
      if (!contextMessageId) throw new Error('WhatsApp did not confirm context message ID');
      pollLedger.set(key, { deliveryKey: key, payloadFingerprint, phase: 'context-sent', contextMessageId, createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS });
      persistPollLedger();
      trackSentMessageId(contextMessage);
    }
    pollLedger.set(key, { deliveryKey: key, payloadFingerprint, phase: 'poll-pending', contextMessageId, createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS });
    persistPollLedger();
    const pollMessage = await sendPollWithLateRecovery(chatId, { poll: { name: question, values: options, selectableCount } }, (late) => {
      const id = late?.key?.id;
      if (!id) return;
      const current = getPollLedger().get(key);
      if (current?.phase === 'poll-pending') { current.pollMessageId = id; current.phase = 'complete'; persistPollLedger(); trackSentMessageId(late); }
    });
    const pollMessageId = pollMessage?.key?.id;
    if (!pollMessageId) throw new Error('WhatsApp did not confirm poll message ID');
    pollLedger.set(key, { deliveryKey: key, payloadFingerprint, phase: 'complete', contextMessageId, pollMessageId, createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS });
    while (pollLedger.size > POLL_LEDGER_MAX) pollLedger.delete(pollLedger.keys().next().value);
    persistPollLedger();
    const result = { success: true, pollMessageId, messageIds: [contextMessageId, pollMessageId] };
    trackSentMessageId(pollMessage);
    return result;
  })();
  pollInFlight.set(key, operation);
  try { return res.json(await operation); }
  catch (err) { return res.status(/timed out/i.test(err.message) ? 425 : 500).json({ error: /timed out/i.test(err.message) ? 'poll delivery outcome uncertain' : err.message, ...( /timed out/i.test(err.message) ? { retryAfter: 5 } : {}) }); }
  finally { if (pollInFlight.get(key) === operation) pollInFlight.delete(key); }
});
app.get('/health', (req, res) => {
  res.json({
    status: connectionState,
    sendReadReceipts: SEND_READ_RECEIPTS,
  });
});
`;

const key = '11111111-1111-4111-8111-111111111111';
const body = (context) => ({ chatId: 'fixture-chat', context, question: 'Choose?', options: ['Yes', 'No'], selectableCount: 1, deliveryKey: key });
function harness(source, stored = [], send = async (_, payload) => ({ key: { id: payload.text ? 'context-id' : 'poll-id' } })) {
  const routes = new Map();
  const seen = [];
  const cached = [];
  const messageQueue = [];
  const events = new Map();
  const sandbox = { app: { post: (route, fn) => routes.set(route, fn), get: (route, fn) => routes.set(route, fn) },
    saved: stored, sock: { sendMessage: send, user: { id: 'owner@s.whatsapp.net' }, ev: { on: (name, fn) => events.set(name, fn) } }, connectionState: 'connected', SEND_READ_RECEIPTS: false,
    createHash, Date, Map, Set, String, Number, console,
    recentlySentIds: { remember: (id) => seen.push(id), has: (id) => id === 'poll-id' },
    normalizeWhatsAppId: (id) => id, messageQueue,
    aggregatePollVotes: (updates) => updates.flatMap((item) => (item.vote?.selectedOptions ?? []).map((name) => ({ name }))),
    enqueueSend: (fn) => Promise.resolve().then(fn), setTimeout, clearTimeout,
    rememberSentMessage: (result, payload) => cached.push({ result, payload }), trackSentMessageId: () => {},
    formatOutgoingMessage: (value) => value,
    splitLongMessage: (value) => value.match(/.{1,4000}/gs) ?? [],
    buildTextSendPayload: (value) => ({ content: { text: value }, options: {} }),
    sendWithTimeout: send, messageStore: { remember: () => {} } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(source, ctx);
  const requestRoute = async (route, input) => {
    let status = 200;
    const response = { status: (value) => { status = value; return response; }, json: (value) => ({ status, value: JSON.parse(JSON.stringify(value)) }) };
    return routes.get(route)({ body: input }, response);
  };
  const request = (input) => requestRoute('/send-poll', input);
  const sendText = (input) => requestRoute('/send', input);
  const health = () => {
    let value;
    routes.get('/health')({}, { json: (result) => { value = JSON.parse(JSON.stringify(result)); } });
    return value;
  };
  const enqueueVote = (key, update, selectedOptions = ['Approve']) => vm.runInContext('enqueuePollUpdateEvent', ctx)({ key, update, selectedOptions, aggregation: [] });
  const updateVotes = (updates) => events.get('messages.update')(updates);
  return { request, sendText, enqueueVote, updateVotes, messageQueue, saved: () => sandbox.saved, restore: () => vm.runInContext('restorePollIdsFromLedger()', ctx), seen, cached, health };
}

test('guarded transform is idempotent and rejects drift or partial upgrade', () => {
  const output = upgradeHermesPollLayout(seam);
  assert.equal(output.status, 'upgrade-available');
  assert.equal(upgradeHermesPollLayout(output.source).status, 'already-patched');
  assert.throws(() => upgradeHermesPollLayout(seam.replace("phase: 'poll-pending', contextMessageId", "phase: 'poll-pending', changedContextMessageId")), /differs/);
  assert.throws(() => upgradeHermesPollLayout(output.source.replace('compactPolls: true', 'compactPolls: false')), /partially patched/);
});

test('compact poll sends once, replays once, and restores recognition after restart', async () => {
  const source = upgradeHermesPollLayout(seam).source;
  const sends = [];
  const send = async (_, payload) => { sends.push(payload); return { key: { id: `id-${sends.length}` } }; };
  const first = harness(source, [], send);
  const result = await first.request(body(null));
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.messageIds, ['id-1']);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].poll);
  assert.deepEqual(first.cached.map((entry) => entry.result.key.id), ['id-1']);
  assert.ok(first.cached[0].payload.poll);
  assert.equal(first.saved()[0].contextOmitted, true);
  const restarted = harness(source, first.saved(), send);
  restarted.restore();
  assert.deepEqual(restarted.seen, ['id-1']);
  assert.deepEqual((await restarted.request(body(null))).value.messageIds, ['id-1']);
  assert.equal(sends.length, 1);
  assert.equal(restarted.health().compactPolls, true);
});

test('legacy context still sends context then poll with unchanged fingerprint', async () => {
  const source = upgradeHermesPollLayout(seam).source;
  const sends = [];
  const h = harness(source, [], async (_, payload) => { sends.push(payload); return { key: { id: `id-${sends.length}` } }; });
  const result = await h.request(body('Case context'));
  assert.deepEqual(result.value.messageIds, ['id-1', 'id-2']);
  assert.deepEqual(sends.map((entry) => Boolean(entry.text)), [true, false]);
  assert.equal(h.saved()[0].payloadFingerprint, createHash('sha256').update(JSON.stringify({ chatId: 'fixture-chat', context: 'Case context', question: 'Choose?', options: ['Yes', 'No'], selectableCount: 1 })).digest('hex'));
  assert.equal(h.saved()[0].contextOmitted, undefined);
});

test('opt-in long text stays one message and rejects oversized or malformed requests', async () => {
  const source = upgradeHermesPollLayout(seam).source;
  const sends = [];
  const h = harness(source, [], async (_, payload) => { sends.push(payload); return { key: { id: `text-${sends.length}` } }; });
  const compact = await h.sendText({ chatId: 'fixture-chat', message: 'a'.repeat(8000), singleMessage: true });
  assert.equal(compact.status, 200);
  assert.deepEqual(compact.value.messageIds, ['text-1']);
  assert.equal(sends[0].text.length, 8000);
  assert.equal((await h.sendText({ chatId: 'fixture-chat', message: 'a'.repeat(8001), singleMessage: true })).status, 400);
  assert.equal((await h.sendText({ chatId: 'fixture-chat', message: 'hi', singleMessage: 'true' })).status, 400);
  assert.equal(sends.length, 1);
  const ordinary = await h.sendText({ chatId: 'fixture-chat', message: 'b'.repeat(8000) });
  assert.equal(ordinary.status, 200);
  assert.deepEqual(ordinary.value.messageIds, ['text-2', 'text-3']);
});

test('native update batch keeps each vote with its actual voter and selection', async () => {
  const input = [{
    key: { id: 'poll-id', remoteJid: 'group@g.us', participant: 'bot@s.whatsapp.net' },
    update: { pollUpdates: [
      { pollUpdateMessageKey: { participant: 'owner@s.whatsapp.net' }, vote: { selectedOptions: ['Approve'] } },
      { pollUpdateMessageKey: { participant: 'other@s.whatsapp.net' }, vote: { selectedOptions: ['Reject'] } },
    ] },
  }];
  const before = harness(seam);
  await before.updateVotes(input);
  assert.equal(before.messageQueue.length, 1);
  assert.equal(before.messageQueue[0].senderId, 'bot@s.whatsapp.net');
  const after = harness(upgradeHermesPollLayout(seam).source);
  await after.updateVotes(input);
  assert.deepEqual(after.messageQueue.map((event) => [event.senderId, ...event.selectedOptions]), [
    ['owner@s.whatsapp.net', 'Approve'],
    ['other@s.whatsapp.net', 'Reject'],
  ]);
  assert.equal(after.health().pollVoterIdentity, true);
});

test('native vote requires a voter key; own fromMe key resolves only to socket identity', () => {
  const h = harness(upgradeHermesPollLayout(seam).source);
  const pollKey = { id: 'poll-id', remoteJid: 'group@g.us', participant: 'bot@s.whatsapp.net' };
  h.enqueueVote(pollKey, { pollUpdates: [{ pollUpdateMessageKey: {}, vote: { selectedOptions: ['Approve'] } }] });
  h.enqueueVote(pollKey, { pollUpdates: [{ pollUpdateMessageKey: { fromMe: true }, vote: { selectedOptions: ['Approve'] } }] });
  h.enqueueVote({ ...pollKey, id: 'foreign' }, { pollUpdates: [{ pollUpdateMessageKey: { participant: 'owner@s.whatsapp.net' }, vote: { selectedOptions: ['Approve'] } }] });
  assert.deepEqual(h.messageQueue.map((event) => event.senderId), ['owner@s.whatsapp.net']);
});

test('uncertain compact send does not resend; late completion caches creation and persists one poll', async () => {
  const source = upgradeHermesPollLayout(seam).source;
  let resolveSend;
  let count = 0;
  const first = harness(source, [], async () => { count++; return new Promise((resolve) => { resolveSend = resolve; }); });
  assert.equal((await first.request(body(null))).status, 425);
  assert.equal(first.saved()[0].phase, 'poll-pending');
  assert.equal(first.saved()[0].contextOmitted, true);
  const pending = harness(source, first.saved());
  assert.equal((await pending.request(body(null))).status, 425);
  resolveSend({ key: { id: 'late-poll' }, message: { pollCreationMessage: { name: 'Choose?', encKey: new Uint8Array([1]) } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.cached[0].result.key.id, 'late-poll');
  assert.ok(first.cached[0].result.message.pollCreationMessage.encKey);
  const complete = harness(source, first.saved());
  complete.restore();
  assert.deepEqual(complete.seen, ['late-poll']);
  assert.deepEqual((await complete.request(body(null))).value.messageIds, ['late-poll']);
  assert.equal(count, 1);
});

test('CLI dry run does not write, apply backs up privately, and repeat apply is inert', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-polls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config', 'config.json');
  const bridge = path.join(root, 'hermes', 'scripts', 'whatsapp-bridge', 'bridge.js');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ gateway: { hermesCheckout: path.join(root, 'hermes') } }));
  fs.writeFileSync(bridge, seam);
  const run = (...args) => spawnSync(process.execPath, ['scripts/upgrade-hermes-poll-layout.mjs', `--config=${config}`, ...args], { cwd: path.resolve('.'), encoding: 'utf8' });
  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).applied, false);
  assert.equal(fs.readFileSync(bridge, 'utf8'), seam);
  const applied = run('--apply');
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.applied, true);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(result.backup)).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), seam);
  assert.equal(run('--apply').status, 0);
  assert.equal(fs.readdirSync(path.dirname(result.backup)).length, 1);
});
