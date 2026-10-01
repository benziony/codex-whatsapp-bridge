import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeObserver, loadObserverCredential, observeNativeTurn } from "../scripts/lib/council-native-observer.mjs";

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
          assert.deepEqual(message.params, { threadId: "thread-a", includeTurns: true });
          const item = recorded.get(message.params.threadId);
          result = { thread: { id: "thread-a", turns: item ? [{ id: item.turnId, status: "inProgress", items: [
            { type: "userMessage", clientId: item.requestId, content: [{ type: "text", text: item.prompt }] },
            { type: "agentMessage", text: "I saw the nonce." },
          ] }] : [] } };
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
  const thread = { id: "thread-a", turns: [{ id: "default-spawn-turn", status: "completed", items: [{ type: "userMessage", clientId: requestId, content: [{ type: "text", text: expectedText }] }] }] };
  fs.writeFileSync(binary, `#!/usr/bin/env node\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(!['initialize','thread/read'].includes(m.method))throw Error('Unexpected native mutation');process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{thread:${JSON.stringify(thread)}}})+'\\n')});\n`, { mode: 0o700 });
  const observed = await observeNativeTurn({ codexBinary: binary, cwd: f.directory, threadId: "thread-a", requestId, expectedText, timeoutMs: 2000 });
  assert.equal(observed.turnId, "default-spawn-turn"); assert.equal(observed.nonce, nonce);
});
