import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { controlRequestId, createNativeObserver, loadObserverCredential, observeNativeTurn, observeNativeTurns } from "../scripts/lib/council-native-observer.mjs";

const pause = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-native-observer-"));
  const credentialFile = path.join(directory, "observer.token");
  const statePath = path.join(directory, "observer-state.json");
  fs.writeFileSync(credentialFile, `observer_${"a".repeat(64)}\n`, { mode: 0o600 });
  fs.chmodSync(credentialFile, 0o600);
  const config = { credentialFile, statePath, grantId: "grant-a", grantRevision: 2, agentId: "codex", runtimeId: "runtime-a",
    nativeThreadId: "thread-a", profileRevision: 4, generation: 3 };
  return { directory, credentialFile, statePath, config, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function jsonRpcReader(recorded, methods) {
  return (binary, args, options) => {
    assert.equal(binary, "synthetic-codex");
    assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
    assert.equal(options.cwd, process.cwd());
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line);
        methods.push(message.method);
        if (message.id === undefined) continue;
        let result;
        if (message.method === "initialize") result = {};
        else if (message.method === "thread/read") {
          assert.equal(message.params.threadId, "thread-a");
          if (message.params.includeTurns) {
            assert.deepEqual(message.params, { threadId: "thread-a", includeTurns: true });
            const item = recorded.get(message.params.threadId);
            result = { thread: { id: "thread-a", turns: item ? [{ id: item.turnId, status: "inProgress", items: [
              { type: "userMessage", clientId: item.requestId, content: [{ type: "text", text: item.prompt }] },
              { type: "agentMessage", text: "I saw the nonce." },
            ] }] : [] } };
          } else result = { thread: { id: "thread-a" } };
        } else if (message.method === "thread/turns/list") {
          const item = recorded.get(message.params.threadId);
          result = { data: item ? [{ id: item.turnId, status: "inProgress", items: [{ type: "userMessage", clientId: item.requestId }] }] : [], nextCursor: null };
        } else if (message.method === "thread/items/list") {
          const item = recorded.get(message.params.threadId);
          result = { data: item && item.turnId === message.params.turnId
            ? [{ turnId: item.turnId, item: { type: "userMessage", clientId: item.requestId, content: [{ type: "text", text: item.prompt }] } }]
            : [], nextCursor: null };
        } else throw new Error(`Unexpected native RPC method ${message.method}`);
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
      }
    });
    return child;
  };
}

test("native reader uses read-only JSON-RPC and proves the exact clientId and prompt", async () => {
  const nonce = "b".repeat(64);
  const challengeId = "challenge-a";
  const expectedText = `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId, nonce })}\nAcknowledge only.`;
  const recorded = new Map([["thread-a", { turnId: "turn-a", requestId: "native-admit:test", prompt: expectedText }]]);
  const methods = [];
  const result = await observeNativeTurn({ spawnImpl: jsonRpcReader(recorded, methods), codexBinary: "synthetic-codex", cwd: process.cwd(),
    threadId: "thread-a", requestId: "native-admit:test", expectedText, timeoutMs: 100 });
  assert.deepEqual(methods, ["initialize", "initialized", "thread/read"]);
  assert.deepEqual(result, { turnId: "turn-a", status: "inProgress", nonce, observedAt: result.observedAt });
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
});

test("observer rejects missing or mismatched native turns without accepting agent prose", async () => {
  const expectedText = `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId: "challenge-a", nonce: "b".repeat(64) })}\nAcknowledge only.`;
  const methods = [];
  const missing = jsonRpcReader(new Map(), methods);
  await assert.rejects(observeNativeTurn({ spawnImpl: missing, codexBinary: "synthetic-codex", cwd: process.cwd(), threadId: "thread-a", requestId: "missing", expectedText, timeoutMs: 100 }), { code: "NATIVE_TURN_NOT_FOUND" });
  const wrong = jsonRpcReader(new Map([["thread-a", { turnId: "turn-b", requestId: "native-admit:wrong", prompt: "different" }]]), methods);
  await assert.rejects(observeNativeTurn({ spawnImpl: wrong, codexBinary: "synthetic-codex", cwd: process.cwd(), threadId: "thread-a", requestId: "native-admit:wrong", expectedText, timeoutMs: 100 }), /prompt did not match/);
});

test("native history reader pages turns and exact items, validating cursors and prompt before a positive result", async () => {
  const calls = [];
  const requestId = "native-admit:historic";
  const expectedText = `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId: "historic", nonce: "f".repeat(64) })}\nAcknowledge only.`;
  const spawnImpl = (_binary, _args, _options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line); calls.push(message);
        if (message.id === undefined) continue;
        let result;
        if (message.method === "initialize") result = {};
        else if (message.method === "thread/read") result = { thread: { id: "thread-a" } };
        else if (message.method === "thread/turns/list") {
          result = message.params.cursor === undefined
            ? { data: [{ id: "old-turn", status: "interrupted", items: [{ type: "userMessage", clientId: requestId }] }], nextCursor: "turn-page-2" }
            : { data: [{ id: "later-turn", status: "completed", items: [] }], nextCursor: null };
        } else if (message.method === "thread/items/list") {
          assert.deepEqual(message.params, { threadId: "thread-a", turnId: "old-turn", limit: 50, sortDirection: "asc" });
          result = { data: [{ turnId: "old-turn", item: { type: "userMessage", clientId: requestId, content: [{ type: "text", text: expectedText }] } }], nextCursor: null };
        } else throw new Error(`Unexpected native RPC method ${message.method}`);
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
      }
    });
    return child;
  };
  const found = await observeNativeTurns({ spawnImpl, codexBinary: "synthetic-codex", cwd: process.cwd(), threadId: "thread-a",
    requests: [{ requestId, expectedText }], timeoutMs: 100, historyTimeoutMs: 1_000 });
  assert.equal(found.get(requestId).turnId, "old-turn");
  assert.equal(found.get(requestId).status, "interrupted");
  assert.deepEqual(calls.filter((call) => call.method).map((call) => call.method), ["initialize", "initialized", "thread/read", "thread/turns/list", "thread/turns/list", "thread/items/list"]);
});

test("over-limit recovery admits only exact historic receipts before enforcing the control cap", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const now = Date.parse("2026-10-12T12:00:00Z");
  const challengeId = "new-challenge";
  const newNonce = "e".repeat(64);
  const newRequestId = controlRequestId(challengeId);
  let historyCalls = 0, challengeCalls = 0, admitCalls = 0, starts = 0;
  const matches = new Map();
  const exactPrompts = new Map();
  const controls = {};
  for (let index = 1; index <= 65; index++) {
    const id = `old-challenge-${index}`;
    const nonce = String(index).padStart(64, "a");
    const requestId = controlRequestId(id);
    controls[id] = { challengeId: id, nonce, eventId: `event-${index}`, seq: index, expiresAt: new Date(now - 60_000).toISOString(), requestId,
      delivered: true, uncertain: true, stage: "native-start-pending" };
    if (index <= 6) {
      const expectedText = `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId: id, nonce })}\nAcknowledge only.`;
      exactPrompts.set(requestId, expectedText);
      matches.set(requestId, { turnId: `historic-turn-${index}`, status: "interrupted", nonce, observedAt: new Date(now - 120_000).toISOString() });
    }
  }
  const state = { fences: { agent: "codex", workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a", profileRevision: 4,
    generation: 3, grantId: "grant-a", grantRevision: 2 }, seq: 0, pendingIssue: null, pendingEvents: [], rejectedPendingEvents: 0,
    skippedEvents: [], challenge: null, control: controls, proof: null, halted: null, nextAt: 0 };
  fs.writeFileSync(f.statePath, JSON.stringify(state), { mode: 0o600 }); fs.chmodSync(f.statePath, 0o600);
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation, body) => {
      if (operation === "challenge") { challengeCalls++; return { id: challengeId, expiresAt: new Date(now + 90_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 }; }
      admitCalls++;
      if (body.id.startsWith("old-challenge-")) throw new Error("old receipt (404)");
      return { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 };
    },
    historyReader: async ({ requests }) => {
      historyCalls++;
      if (requests.length === 65) {
        for (const [requestId, expectedText] of exactPrompts) assert.equal(requests.find((request) => request.requestId === requestId)?.expectedText, expectedText);
        return matches;
      }
      assert.equal(requests.length, 1, "later ticks may inspect the fresh challenge only, never scan old ambiguous records individually");
      assert.equal(requests[0].requestId, newRequestId);
      assert.equal(requests[0].expectedText, `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId, nonce: newNonce })}\nAcknowledge only.`);
      return new Map([[newRequestId, { turnId: "new-live-turn", status: "completed", nonce: newNonce, observedAt: new Date(now).toISOString() }]]);
    },
    turnRunner: async (args) => { starts++; await args.onTurnStarting({ sessionId: args.sessionId }); await args.onTurnStarted({ sessionId: args.sessionId, turnId: "new-live-turn" }); },
    clock: () => now, random: () => 0, randomId: () => "bounded-recovery",
  });
  await observer.tick();
  const recovered = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(historyCalls, 1, "all candidates are reconciled in one bounded history pass");
  assert.equal(admitCalls, 6, "only six exact positive matches use existing expired-receipt handling");
  assert.equal(starts, 0, "history reconciliation never replays native turns");
  assert.equal(challengeCalls, 1, "new control issuance resumes only after the strict cap has cleared");
  assert.equal(Object.keys(recovered.control).length, 59);
  assert.equal(Object.values(recovered.control).filter((control) => control.uncertain && !control.admission).length, 59);
  assert.equal(Object.values(recovered.control).filter((control) => control.admission?.status === "expired").length, 0,
    "positively reconciled expired receipts are retired so unknown records retain room under the existing cap");
  await observer.acceptEvent({ op: "connect.native.challenge", kind: "native-admission-control", seq: 66, eventId: "new-live-event", challengeId,
    nonce: newNonce, workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a", profileRevision: 4, generation: 3, grantRevision: 2,
    expiresAt: new Date(now + 90_000).toISOString(), recipients: ["codex"] });
  await observer.tick();
  const afterSecondTick = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(historyCalls, 2, "the second tick does not repeat the old 59-record reconciliation");
  assert.equal(starts, 1, "a current live challenge is admitted while the old unknown records remain");
  assert.equal(afterSecondTick.control[challengeId].admission.status, "verified");
  assert.equal(Object.values(afterSecondTick.control).filter((control) => control.uncertain && !control.admission).length, 59);
});

test("authentic expired and superseded native controls are durably skipped while malformed or wrong-recipient events fail closed", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const now = Date.parse("2026-10-01T12:00:00Z");
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async () => { throw new Error("stale controls must not issue or admit"); }, turnRunner: async () => { throw new Error("stale controls must not start native work"); }, clock: () => now,
  });
  const base = { op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "event-old-grant", challengeId: "old-challenge",
    nonce: "d".repeat(64), workspace: "default", runtimeId: "runtime-old", nativeThreadId: "thread-old", profileRevision: 3,
    generation: 2, grantRevision: 1, expiresAt: new Date(now + 60_000).toISOString(), recipients: ["codex"] };
  assert.deepEqual(await observer.acceptEvent(base), { stale: true });
  const expired = { ...base, eventId: "event-expired", challengeId: "expired-challenge", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now - 1).toISOString() };
  assert.deepEqual(await observer.acceptEvent(expired), { stale: true });
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.deepEqual(state.skippedEvents.map((item) => item.eventId), ["event-old-grant", "event-expired"]);
  await assert.rejects(observer.acceptEvent({ ...base, eventId: "event-wrong-recipient", recipients: ["instinct"] }), /recipient or identity/);
  await assert.rejects(observer.acceptEvent({ ...base, eventId: "event-wrong-workspace", workspace: "other" }), /workspace changed/);
  await assert.rejects(observer.acceptEvent({ ...base, eventId: "event-malformed", nonce: "bad" }), /recipient or identity/);

  const haltedFixture = fixture();
  t.after(haltedFixture.cleanup);
  const haltedObserver = createNativeObserver(haltedFixture.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async () => { throw new Error("Council request failed (403)"); }, turnRunner: async () => { throw new Error("halted control must not start native work"); }, clock: () => now,
  });
  assert.deepEqual(await haltedObserver.tick({ force: true }), { halted: true });
  const current = { ...base, eventId: "event-after-revoke", challengeId: "after-revoke", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now + 60_000).toISOString() };
  assert.deepEqual(await haltedObserver.acceptEvent(current), { stale: true });
  assert.equal(JSON.parse(fs.readFileSync(haltedFixture.statePath, "utf8")).skippedEvents[0].reason, "observer-halted");
});

test("a verified native control replay returns its stored admission after the challenge is cleared", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation) => operation === "challenge"
      ? { id: "replay-challenge", expiresAt: new Date(now + 90_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 }
      : { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 },
    observerReader: async ({ expectedText }) => {
      const challenge = JSON.parse(expectedText.split("\n")[1].slice("Challenge: ".length));
      return { turnId: "turn-replay", status: "completed", nonce: challenge.nonce, observedAt: new Date(now).toISOString() };
    },
    turnRunner: async (args) => {
      await args.onTurnStarting({ sessionId: args.sessionId });
      await args.onTurnStarted({ sessionId: args.sessionId, turnId: "turn-replay" });
    },
    clock: () => now, random: () => 0, randomId: () => "replay-cycle", canRunControl: () => true,
  });
  await observer.tick({ force: true });
  const event = { op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "replay-event", challengeId: "replay-challenge",
    nonce: "9".repeat(64), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a", profileRevision: 4,
    generation: 3, grantRevision: 2, expiresAt: new Date(now + 90_000).toISOString(), recipients: ["codex"] };
  await observer.acceptEvent(event);
  await observer.tick();
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(state.challenge, null);
  assert.equal(state.control["replay-challenge"].admission.status, "verified");

  const replay = await observer.acceptEvent(event);
  assert.deepEqual(replay, state.control["replay-challenge"]);
  await assert.rejects(observer.acceptEvent({ ...event, nonce: "8".repeat(64) }), /replay changed its binding/);
  await assert.rejects(observer.acceptEvent({ ...event, seq: 2 }), /replay changed its binding/);
  await assert.rejects(observer.acceptEvent({ ...event, challengeId: "unknown-challenge" }), /no matching issued challenge/);
});

test("native turn start waits for delayed user-message visibility in the read-only app-server", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  const requestId = controlRequestId("visibility-challenge");
  const nonce = "a".repeat(64);
  const expectedText = `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId: "visibility-challenge", nonce })}\nAcknowledge only.`;
  const binary = path.join(f.directory, "synthetic-delayed-native-reader.mjs");
  const readCountFile = path.join(f.directory, "thread-read-count");
  fs.writeFileSync(binary, `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(!['initialize','thread/read','thread/turns/list','thread/items/list'].includes(m.method))throw Error('Unexpected native mutation');let result={};if(m.method==='thread/read')result={thread:{id:'thread-a'}};if(m.method==='thread/turns/list'){const reads=(fs.existsSync(${JSON.stringify(readCountFile)})?Number(fs.readFileSync(${JSON.stringify(readCountFile)},'utf8')):0)+1;fs.writeFileSync(${JSON.stringify(readCountFile)},String(reads));result={data:[{id:'visibility-turn',status:'interrupted',items:reads>=4?[{type:'userMessage',clientId:${JSON.stringify(requestId)}}]:[]}],nextCursor:null}}if(m.method==='thread/items/list')result={data:[{turnId:'visibility-turn',item:{type:'userMessage',clientId:${JSON.stringify(requestId)},content:[{type:'text',text:${JSON.stringify(expectedText)}}]}}],nextCursor:null};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});\n`, { mode: 0o700 });
  let startCount = 0;
  let runnerCompleted = false;
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation) => operation === "challenge"
      ? { id: "visibility-challenge", expiresAt: new Date(now + 90_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 }
      : { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 },
    turnRunner: async (args) => {
      startCount++;
      await args.onTurnStarting({ sessionId: args.sessionId });
      await args.onTurnStarted({ sessionId: args.sessionId, turnId: "visibility-turn" });
      runnerCompleted = true;
    },
    codexBinary: binary, cwd: f.directory, observerTimeoutMs: 1_000, observerVisibilityTimeoutMs: 1_000, observerPollIntervalMs: 10,
    clock: () => now, random: () => 0, randomId: () => "delayed-visibility", canRunControl: () => true,
  });
  await observer.tick({ force: true });
  await observer.acceptEvent({ op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "visibility-event",
    challengeId: "visibility-challenge", nonce, workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a", profileRevision: 4,
    generation: 3, grantRevision: 2, expiresAt: new Date(now + 90_000).toISOString(), recipients: ["codex"] });

  await observer.tick();
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(Number(fs.readFileSync(readCountFile, "utf8")), 4);
  assert.equal(startCount, 1, "visibility polling observes the already-started turn instead of retrying it");
  assert.equal(runnerCompleted, true, "a temporary missing user message does not interrupt the started turn");
  assert.equal(state.control["visibility-challenge"].admission.status, "verified");
});

test("native user-message visibility timeout stays uncertain without interrupting or restarting the turn", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  const requestId = controlRequestId("visibility-timeout-challenge");
  const binary = path.join(f.directory, "synthetic-empty-native-reader.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(!['initialize','thread/read','thread/turns/list','thread/items/list'].includes(m.method))throw Error('Unexpected native mutation');const result=m.method==='initialize'?{}:m.method==='thread/read'?{thread:{id:'thread-a'}}:{data:[{id:'timeout-turn',status:'interrupted',items:[]}],nextCursor:null};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});\n`, { mode: 0o700 });
  let startCount = 0;
  let runnerCompleted = false;
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation) => operation === "challenge"
      ? { id: "visibility-timeout-challenge", expiresAt: new Date(now + 90_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 }
      : { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 },
    turnRunner: async (args) => {
      startCount++;
      await args.onTurnStarting({ sessionId: args.sessionId });
      await args.onTurnStarted({ sessionId: args.sessionId, turnId: "timeout-turn" });
      runnerCompleted = true;
    },
    codexBinary: binary, cwd: f.directory, observerTimeoutMs: 500, observerVisibilityTimeoutMs: 20, observerPollIntervalMs: 5,
    clock: () => now, random: () => 0, randomId: () => "visibility-timeout", canRunControl: () => true,
  });
  await observer.tick({ force: true });
  await observer.acceptEvent({ op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "visibility-timeout-event",
    challengeId: "visibility-timeout-challenge", nonce: "b".repeat(64), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now + 90_000).toISOString(), recipients: ["codex"] });

  await observer.tick();
  await observer.tick();
  const control = JSON.parse(fs.readFileSync(f.statePath, "utf8")).control["visibility-timeout-challenge"];
  assert.equal(startCount, 1, "an unobserved request is not blindly started again");
  assert.equal(runnerCompleted, true, "a visibility timeout does not abort the already-started turn");
  assert.equal(control.uncertain, true);
  assert.equal(control.stage, "native-start-pending");
  assert.equal(control.admission, undefined);
});

test("a thread/read that crosses the visibility deadline is an uncertain absence, not a fatal runner error", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  const binary = path.join(f.directory, "synthetic-slow-empty-native-reader.mjs");
  const readCountFile = path.join(f.directory, "slow-thread-read-count");
  fs.writeFileSync(binary, `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(!['initialize','thread/read','thread/turns/list','thread/items/list'].includes(m.method))throw Error('Unexpected native mutation');if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');return}if(m.method==='thread/read'){process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'thread-a'}}})+'\\n');return}const reads=(fs.existsSync(${JSON.stringify(readCountFile)})?Number(fs.readFileSync(${JSON.stringify(readCountFile)},'utf8')):0)+1;fs.writeFileSync(${JSON.stringify(readCountFile)},String(reads));setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,result:{data:[{id:'slow-timeout-turn',status:'interrupted',items:[]}],nextCursor:null}})+'\\n'),12)});\n`, { mode: 0o700 });
  let startCount = 0;
  let runnerCompleted = false;
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation) => operation === "challenge"
      ? { id: "slow-timeout-challenge", expiresAt: new Date(now + 90_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 }
      : { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 },
    turnRunner: async (args) => {
      startCount++;
      await args.onTurnStarting({ sessionId: args.sessionId });
      await args.onTurnStarted({ sessionId: args.sessionId, turnId: "slow-timeout-turn" });
      runnerCompleted = true;
    },
    codexBinary: binary, cwd: f.directory, observerTimeoutMs: 1_000, observerVisibilityTimeoutMs: 20, observerPollIntervalMs: 5,
    clock: () => now, random: () => 0, randomId: () => "slow-visibility-timeout", canRunControl: () => true,
  });
  await observer.tick({ force: true });
  await observer.acceptEvent({ op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "slow-timeout-event",
    challengeId: "slow-timeout-challenge", nonce: "c".repeat(64), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now + 90_000).toISOString(), recipients: ["codex"] });

  await observer.tick();
  const control = JSON.parse(fs.readFileSync(f.statePath, "utf8")).control["slow-timeout-challenge"];
  assert.ok(Number(fs.readFileSync(readCountFile, "utf8")) >= 2);
  assert.equal(startCount, 1);
  assert.equal(runnerCompleted, true, "visibility-budget expiry during an RPC does not abort the started turn");
  assert.equal(control.uncertain, true);
  assert.equal(control.admission, undefined);
});

test("SSE arriving before the issue response is durably buffered and promoted without overlapping ticks", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  let issueStarted;
  let resolveIssue;
  const issueEntered = new Promise((resolve) => { issueStarted = resolve; });
  const issueResponse = new Promise((resolve) => { resolveIssue = resolve; });
  let issueCount = 0;
  let startCount = 0;
  const recorded = new Map();
  const deps = {
    request: async (operation) => {
      if (operation === "admit") return { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 120_000).toISOString(),
        generation: 3, profileRevision: 4, grantRevision: 2 };
      if (operation !== "challenge") throw new Error("unexpected request");
      issueCount++;
      issueStarted();
      return issueResponse;
    },
    turnRunner: async (args) => {
      startCount++;
      recorded.set("thread-a", { turnId: "turn-race", requestId: args.requestId, prompt: args.prompt });
      await args.onTurnStarted({ sessionId: args.sessionId, turnId: "turn-race" });
      return { sessionId: args.sessionId, turnId: "turn-race" };
    },
    spawnImpl: jsonRpcReader(recorded, []), codexBinary: "synthetic-codex", cwd: process.cwd(), clock: () => now,
    randomId: () => "race-operation", canRunControl: () => true, observerTimeoutMs: 100,
  };
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, deps);
  const pendingTick = observer.tick({ force: true });
  await issueEntered;
  assert.equal(issueCount, 1);
  const event = { op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "event-race", challengeId: "challenge-race",
    nonce: "c".repeat(64), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a", profileRevision: 4,
    generation: 3, grantRevision: 2, expiresAt: new Date(now + 90_000).toISOString(), recipients: ["codex"] };
  const pendingAccept = observer.acceptEvent(event);
  assert.deepEqual(await observer.tick(), { busy: true });
  assert.equal(issueCount, 1, "overlapping ticks do not reissue while the issue request is pending");
  resolveIssue({ id: "challenge-race", expiresAt: new Date(now + 90_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4,
    generation: 3, grantRevision: 2 });
  assert.deepEqual(await pendingAccept, { buffered: true });
  await pendingTick;
  const final = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.deepEqual(final.pendingEvents, []);
  assert.equal(final.control["challenge-race"].eventId, "event-race");
  assert.equal(final.control["challenge-race"].admission.status, "verified");
  assert.equal(startCount, 1);
});

test("native runner rejection before onTurnStarting retries the same request ID", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  let runCount = 0;
  let callbackReached = false;
  const requestIds = [];
  const turnId = "turn-after-retry";
  const nonce = "e".repeat(64);
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation) => operation === "challenge"
      ? { id: "prestart-challenge", expiresAt: new Date(now + 60_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 }
      : { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 },
    observerReader: async ({ requestId }) => {
      if (!callbackReached) { const error = new Error("native turn not found"); error.code = "NATIVE_TURN_NOT_FOUND"; throw error; }
      return { turnId, status: "inProgress", nonce, observedAt: new Date(now).toISOString(), requestId };
    },
    turnRunner: async (args) => {
      runCount++;
      requestIds.push(args.requestId);
      if (runCount === 1) throw new Error("runner failed before turn start callback");
      callbackReached = true;
      await args.onTurnStarting({ sessionId: args.sessionId });
      await args.onTurnStarted({ sessionId: args.sessionId, turnId });
    },
    clock: () => now, random: () => 0, randomId: () => "prestart-retry", canRunControl: () => true,
  });
  await observer.tick({ force: true });
  await observer.acceptEvent({ op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "prestart-event",
    challengeId: "prestart-challenge", nonce, workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a", profileRevision: 4,
    generation: 3, grantRevision: 2, expiresAt: new Date(now + 60_000).toISOString(), recipients: ["codex"] });

  await observer.tick();
  const rejected = JSON.parse(fs.readFileSync(f.statePath, "utf8")).control["prestart-challenge"];
  assert.equal(rejected.uncertain, false);
  assert.equal(rejected.stage, "native-start-rejected");
  assert.equal(runCount, 1);

  await observer.tick();
  assert.equal(runCount, 2);
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[1], requestIds[0], "retry keeps the persisted native request ID");
  assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).control["prestart-challenge"].admission.status, "verified");
});

test("native runner failure after onTurnStarting remains uncertain and never starts a duplicate", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  let runCount = 0;
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation) => operation === "challenge"
      ? { id: "postcallback-challenge", expiresAt: new Date(now + 60_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 }
      : { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 },
    observerReader: async () => { const error = new Error("native turn not found"); error.code = "NATIVE_TURN_NOT_FOUND"; throw error; },
    turnRunner: async (args) => { runCount++; await args.onTurnStarting({ sessionId: args.sessionId }); throw new Error("runner failed after turn start callback"); },
    clock: () => now, random: () => 0, randomId: () => "postcallback-uncertain", canRunControl: () => true,
  });
  await observer.tick({ force: true });
  await observer.acceptEvent({ op: "connect.native.challenge", kind: "native-admission-control", seq: 1, eventId: "postcallback-event",
    challengeId: "postcallback-challenge", nonce: "f".repeat(64), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now + 60_000).toISOString(), recipients: ["codex"] });

  await observer.tick();
  await observer.tick();
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8")).control["postcallback-challenge"];
  assert.equal(runCount, 1, "possible native start is never blindly repeated");
  assert.equal(state.uncertain, true);
  assert.equal(state.stage, "native-start-pending");
});

test("expired unstarted controls stay bounded through a long inbox outage and the newest challenge admits after recovery", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  let issueCount = 0;
  let startCount = 0;
  let allowControl = false;
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation) => {
      if (operation === "challenge") {
        issueCount++;
        return { id: `outage-challenge-${issueCount}`, expiresAt: new Date(now + 15 * 60_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 };
      }
      return { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 };
    },
    observerReader: async ({ expectedText, requestId }) => {
      const challenge = JSON.parse(expectedText.split("\n")[1].slice("Challenge: ".length));
      return { turnId: `turn-${requestId}`, status: "completed", nonce: challenge.nonce, observedAt: new Date(now).toISOString() };
    },
    turnRunner: async (args) => { startCount++; await args.onTurnStarted({ sessionId: args.sessionId, turnId: `turn-${args.requestId}` }); },
    clock: () => now, random: () => 0, randomId: () => `outage-${issueCount}`, canRunControl: () => allowControl,
  });
  const makeEvent = (seq) => ({ op: "connect.native.challenge", kind: "native-admission-control", seq, eventId: `outage-event-${seq}`,
    challengeId: `outage-challenge-${seq}`, nonce: String(seq).padStart(64, "a"), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now + 15 * 60_000).toISOString(), recipients: ["codex"] });

  for (let cycle = 1; cycle <= 65; cycle++) {
    if (cycle === 1) await observer.tick({ force: true });
    else await observer.tick();
    await observer.acceptEvent(makeEvent(cycle));
    await observer.tick();
    now += 16 * 60_000;
  }
  const afterOutage = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.ok(Object.keys(afterOutage.control).length <= 1);
  assert.ok(afterOutage.skippedEvents.length <= 64);
  allowControl = true;
  await observer.tick();
  await observer.acceptEvent(makeEvent(66));
  await observer.tick();
  const recovered = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(issueCount, 66);
  assert.equal(startCount, 1);
  assert.equal(recovered.control["outage-challenge-66"].admission.status, "verified");
  assert.ok(Object.keys(recovered.control).length <= 64);
});

test("an expired cached native admission proof is rejected before the next control cycle", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let now = Date.parse("2026-10-01T12:00:00Z");
  let issueCount = 0;
  let startCount = 0;
  let loseFirstAdmit = true;
  const committed = new Map();
  const observer = createNativeObserver(f.config, { workspace: "default", councilUrl: "https://council.test" }, {
    request: async (operation, body) => {
      if (operation === "challenge") {
        issueCount++;
        return { id: "expiry-challenge-" + issueCount, expiresAt: new Date(now + 60_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 };
      }
      if (!committed.has(body.id)) committed.set(body.id, { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 30_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 });
      if (loseFirstAdmit) { loseFirstAdmit = false; throw new Error("simulated lost expired-proof response"); }
      return committed.get(body.id);
    },
    observerReader: async ({ expectedText, requestId }) => {
      const challenge = JSON.parse(expectedText.split("\n")[1].slice("Challenge: ".length));
      return { turnId: "turn-" + requestId, status: "completed", nonce: challenge.nonce, observedAt: new Date(now).toISOString() };
    },
    turnRunner: async (args) => { startCount++; await args.onTurnStarted({ sessionId: args.sessionId, turnId: "turn-" + args.requestId }); },
    clock: () => now, random: () => 0, randomId: () => "expired-proof-" + issueCount,
  });
  const makeEvent = (seq) => ({ op: "connect.native.challenge", kind: "native-admission-control", seq, eventId: "expired-proof-event-" + seq,
    challengeId: "expiry-challenge-" + seq, nonce: String(seq).padStart(64, "a"), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now + 60_000).toISOString(), recipients: ["codex"] });
  await observer.tick({ force: true });
  await observer.acceptEvent(makeEvent(1));
  await assert.rejects(observer.tick(), /simulated lost expired-proof response/);
  now += 70_000;
  await observer.tick();
  const afterExpiry = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(issueCount, 2, "expired cached proof causes a fresh challenge after recovery");
  assert.equal(afterExpiry.control["expiry-challenge-1"].admission.status, "expired");
  await observer.acceptEvent(makeEvent(2));
  await observer.tick();
  const final = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(startCount, 2);
  assert.equal(final.control["expiry-challenge-2"].admission.status, "verified");
});

test("native observer gates the shared inbox, recovers an uncertain admission with the same request, and renews across proof expiry", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.match(await loadObserverCredential(f.credentialFile), /^observer_[a-f0-9]{64}$/);
  let now = Date.parse("2026-10-01T12:00:00Z");
  let challengeCount = 0;
  let startCount = 0;
  let admitCount = 0;
  let allowControl = false;
  let loseFirstAdmit = true;
  const committedProofs = new Map();
  const calls = [];
  const recorded = new Map();
  const methods = [];
  const request = async (operation, body, requestId) => {
    calls.push({ operation, body: structuredClone(body), requestId });
    if (operation === "challenge") {
      challengeCount++;
      return { id: `challenge-${challengeCount}`, expiresAt: new Date(now + 90_000).toISOString(), runtimeId: "runtime-a", profileRevision: 4, generation: 3, grantRevision: 2 };
    }
    assert.equal(recorded.size > 0, true);
    admitCount++;
    if (!committedProofs.has(body.id)) committedProofs.set(body.id, { mode: "native-wake", kind: "native-admission", expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), generation: 3, profileRevision: 4, grantRevision: 2 });
    if (loseFirstAdmit) { loseFirstAdmit = false; throw new Error("simulated lost response"); }
    return committedProofs.get(body.id);
  };
  const turnRunner = async (args) => {
    assert.equal(args.sessionId, "thread-a");
    await args.onTurnStarting({ sessionId: args.sessionId });
    const turnId = `turn-${++startCount}`;
    recorded.set("thread-a", { turnId, requestId: args.requestId, prompt: args.prompt });
    await args.onTurnStarted({ sessionId: args.sessionId, turnId });
    return { sessionId: args.sessionId, turnId };
  };
  const options = { workspace: "default", councilUrl: "https://council.test" };
  const deps = { request, turnRunner, spawnImpl: jsonRpcReader(recorded, methods), codexBinary: "synthetic-codex", cwd: process.cwd(),
    clock: () => now, random: () => 0, randomId: () => "fixed-operation", canRunControl: () => allowControl, observerTimeoutMs: 100 };
  let observer = createNativeObserver(f.config, options, deps);
  await observer.tick({ force: true });
  assert.equal(challengeCount, 1);
  const makeEvent = (seq) => ({ op: "connect.native.challenge", kind: "native-admission-control", seq, eventId: `event-${seq}`,
    challengeId: `challenge-${seq}`, nonce: "b".repeat(64), workspace: "default", runtimeId: "runtime-a", nativeThreadId: "thread-a",
    profileRevision: 4, generation: 3, grantRevision: 2, expiresAt: new Date(now + 90_000).toISOString(), recipients: ["codex"] });
  await observer.acceptEvent(makeEvent(1));
  await observer.tick();
  assert.equal(startCount, 0, "control stays queued while shared business inbox is busy");
  allowControl = true;
  await assert.rejects(observer.tick(), /simulated lost response/);
  assert.equal(startCount, 1);
  const beforeRestart = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(beforeRestart.control["challenge-1"].uncertain, true);
  assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o600);

  observer = createNativeObserver(f.config, options, deps);
  now += 100_000;
  await observer.tick();
  assert.equal(startCount, 1, "restart reads the existing exact turn instead of starting another");
  const admissions = calls.filter((call) => call.operation === "admit");
  assert.equal(admissions.length, 2);
  assert.deepEqual(admissions[1], admissions[0], "lost admission response retries the exact persisted ID and body");
  assert.deepEqual(Object.keys(admissions[0].body).sort(), ["expectedGrantRevision", "grantId", "id", "nativeThreadId", "nativeTurnId", "nonce", "observedAt"].sort());
  assert.equal(admissions[0].body.expectedGrantRevision, 2);
  assert.deepEqual(methods.filter((method) => method === "thread/read").length, 2);

  for (let cycle = 0; cycle < 2; cycle++) {
    now += 24 * 60 * 60_000 + 130_000;
    await observer.tick();
    assert.equal(challengeCount, cycle + 2);
    await observer.acceptEvent(makeEvent(cycle + 2));
    await observer.tick();
    assert.equal(startCount, cycle + 2);
  }
  assert.ok(now > Date.parse("2026-10-01T12:02:00Z"));
  assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).proof.expiresAt, new Date(now + 24 * 60 * 60_000).toISOString());
});

test("native reader starts its protected read-only child with the production default spawn dependency", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const nonce = "c".repeat(64), requestId = "native-default-spawn", expectedText = `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId: "default-spawn-challenge", nonce })}\nAcknowledge only.`;
  const binary = path.join(f.directory, "synthetic-native-reader.mjs");
  const writeReader = (thread) => fs.writeFileSync(binary, `#!/usr/bin/env node\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(!['initialize','thread/read'].includes(m.method))throw Error('Unexpected native mutation');process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{thread:${JSON.stringify(thread)}}})+'\\n')});\n`, { mode: 0o700 });
  const threadFor = (text, status = "interrupted") => ({ id: "thread-a", turns: [{ id: "default-spawn-turn", status, items: [{ type: "userMessage", clientId: requestId, content: [{ type: "text", text }] }] }] });
  writeReader(threadFor(expectedText));
  const observed = await observeNativeTurn({ codexBinary: binary, cwd: f.directory, threadId: "thread-a", requestId, expectedText, timeoutMs: 2000 });
  assert.equal(observed.turnId, "default-spawn-turn"); assert.equal(observed.status, "interrupted"); assert.equal(observed.nonce, nonce);
  const wrongNonceText = expectedText.replace(nonce, "d".repeat(64));
  writeReader(threadFor(wrongNonceText));
  await assert.rejects(observeNativeTurn({ codexBinary: binary, cwd: f.directory, threadId: "thread-a", requestId, expectedText, timeoutMs: 2000 }), /prompt did not match/);
});
