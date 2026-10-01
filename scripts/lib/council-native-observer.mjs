import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const MAX_STATE_BYTES = 1_048_576;
const RENEW_EARLY_MS = 20 * 60_000;
const RENEW_JITTER_MS = 5 * 60_000;
const NONCE = /^[a-f0-9]{64}$/;

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  throw error;
}

export function validateObserverConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("Native observer config is invalid");
  for (const key of ["credentialFile", "grantId", "agentId", "runtimeId", "nativeThreadId", "statePath"]) {
    if (typeof config[key] !== "string" || !config[key]) fail("Native observer config is invalid");
  }
  if (config.agentId !== "codex" || !isAbsolute(config.credentialFile) || !isAbsolute(config.statePath) ||
      !Number.isSafeInteger(config.grantRevision) || config.grantRevision < 1 ||
      !Number.isSafeInteger(config.profileRevision) || config.profileRevision < 1 ||
      !Number.isSafeInteger(config.generation ?? 0) || (config.generation ?? 0) < 0) fail("Native observer scope is invalid");
  config.generation ??= 0;
  return config;
}

export async function loadObserverCredential(filePath, uid = process.getuid?.()) {
  if (!isAbsolute(filePath)) fail("Observer credential path must be absolute");
  let stat;
  try { stat = await lstat(filePath); } catch { fail("Observer credential is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid) || stat.size > 4096) fail("Observer credential must be a protected owner file");
  const token = (await readFile(filePath, "utf8")).trim();
  if (!/^observer_[a-f0-9]{64}$/.test(token)) fail("Observer credential is invalid");
  return token;
}

export function validateNativeControlEvent(event, scope, clock = () => Date.now()) {
  if (!event || typeof event !== "object" || Array.isArray(event) || event.op !== "connect.native.challenge" || event.kind !== "native-admission-control") fail("Native control event is invalid");
  for (const key of ["challengeId", "nonce", "workspace", "runtimeId", "nativeThreadId", "eventId", "expiresAt"]) {
    if (typeof event[key] !== "string" || !event[key]) fail("Native control event binding is invalid");
  }
  if (!NONCE.test(event.nonce) || !Number.isSafeInteger(event.seq) || event.seq < 1 || !Array.isArray(event.recipients) || !event.recipients.includes(scope.agentId)) fail("Native control event recipient or identity is invalid");
  if (event.workspace !== scope.workspace) fail("Native control event workspace changed");
  if (!Number.isSafeInteger(event.profileRevision) || !Number.isSafeInteger(event.generation) || !Number.isSafeInteger(event.grantRevision) ||
      !Number.isFinite(Date.parse(event.expiresAt))) fail("Native control event scope or expiry is invalid");
  const stale = event.runtimeId !== scope.runtimeId || event.nativeThreadId !== scope.nativeThreadId ||
    event.profileRevision !== scope.profileRevision || event.generation !== scope.generation || event.grantRevision !== scope.grantRevision ||
    Date.parse(event.expiresAt) <= clock();
  return stale ? { stale: true } : { stale: false };
}

export function nativeControlPrompt(event) {
  return `Native admission control challenge.\nChallenge: ${JSON.stringify({ challengeId: event.challengeId, nonce: event.nonce })}\nAcknowledge only.`;
}

export async function readObserverState(filePath, uid = process.getuid?.()) {
  let stat;
  try { stat = await lstat(filePath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid) || stat.size > MAX_STATE_BYTES) fail("Observer state must be a protected owner file");
  let state;
  try { state = JSON.parse(await readFile(filePath, "utf8")); } catch { fail("Observer state is malformed"); }
  if (!state || typeof state !== "object" || Array.isArray(state) || !state.fences || typeof state.fences !== "object" ||
      !Number.isSafeInteger(state.seq) || state.seq < 0 || !state.control || typeof state.control !== "object" || Array.isArray(state.control)) fail("Observer state is malformed");
  return state;
}

export async function saveObserverState(filePath, state) {
  if (!isAbsolute(filePath)) fail("Observer state path must be absolute");
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  await rename(temp, filePath);
}

export function controlRequestId(challengeId) {
  return `native-admit:${createHash("sha256").update(String(challengeId)).digest("hex").slice(0, 32)}`;
}

function responseText(turn, requestId) {
  const item = turn.items.find((entry) => entry?.type === "userMessage" && entry.clientId === requestId);
  const content = item?.content;
  if (!Array.isArray(content)) return null;
  return content.filter((entry) => entry?.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("");
}

export async function observeNativeTurn({ spawnImpl = spawn, codexBinary, cwd, threadId, requestId, expectedText, timeoutMs = 15_000 }) {
  if (typeof spawnImpl !== "function" || typeof codexBinary !== "string" || !isAbsolute(cwd) || typeof threadId !== "string" || !threadId ||
      typeof requestId !== "string" || !requestId || typeof expectedText !== "string" || !expectedText || expectedText.length > 4096) fail("Native observer read request is invalid");
  const child = spawnImpl(codexBinary, ["app-server", "--listen", "stdio://"], { cwd, shell: false, stdio: ["pipe", "pipe", "ignore"] });
  if (!child?.stdout || !child?.stdin) fail("Native observer app-server did not start");
  let buffer = "";
  let nextId = 1;
  let stopped = false;
  const pending = new Map();
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    child.stdin.destroy?.();
    child.stdout.destroy?.();
    child.kill?.("SIGTERM");
  };
  const onData = (chunk) => {
    buffer += String(chunk);
    if (buffer.length > 1_048_576) { for (const p of pending.values()) p.reject(new Error("Native observer response is too large")); cleanup(); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { for (const p of pending.values()) p.reject(new Error("Native observer returned invalid JSON-RPC")); cleanup(); return; }
      if (message?.method !== undefined && message?.id === undefined) {
        if (typeof message.method === "string" && (message.method.startsWith("tool/") || message.method === "item/commandExecution/requestApproval")) {
          for (const p of pending.values()) p.reject(new Error("Native observer requested tool approval"));
          cleanup();
        }
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    }
  };
  child.stdout.on("data", onData);
  child.once?.("error", () => { for (const p of pending.values()) p.reject(new Error("Native observer app-server failed")); });
  const rpc = (method, params, notification = false) => {
    const id = notification ? undefined : nextId++;
    const packet = notification ? { method, params } : { id, method, params };
    if (notification) { child.stdin.write(`${JSON.stringify(packet)}\n`); return Promise.resolve(null); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native observer app-server timed out")); }, timeoutMs);
      pending.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { child.stdin.write(`${JSON.stringify(packet)}\n`); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  try {
    const initialized = await rpc("initialize", { clientInfo: { name: "council-native-observer", version: "1" } });
    if (initialized?.error || !initialized || !Object.hasOwn(initialized, "result")) fail("Native observer initialization failed");
    await rpc("initialized", {}, true);
    const response = await rpc("thread/read", { threadId, includeTurns: true });
    if (response?.error) fail("Native observer thread read failed");
    const thread = response?.result?.thread;
    if (!thread || thread.id !== threadId || !Array.isArray(thread.turns)) fail("Native observer thread identity is invalid");
    const matches = thread.turns.filter((turn) => Array.isArray(turn?.items) && turn.items.some((item) => item?.type === "userMessage" && item.clientId === requestId));
    if (matches.length !== 1) fail("Native admission turn has not appeared", "NATIVE_TURN_NOT_FOUND");
    const turn = matches[0];
    if (typeof turn.id !== "string" || !turn.id || !["inProgress", "interrupted", "completed", "failed"].includes(turn.status)) fail("Native admission turn identity is invalid");
    const exactText = responseText(turn, requestId);
    if (exactText !== expectedText) fail("Native admission prompt did not match");
    const challengeLine = exactText.split("\n").find((line) => line.startsWith("Challenge: "));
    let challenge;
    try { challenge = JSON.parse(challengeLine.slice("Challenge: ".length)); } catch { fail("Native admission nonce is malformed"); }
    if (!challenge || typeof challenge.challengeId !== "string" || !NONCE.test(challenge.nonce)) fail("Native admission nonce is malformed");
    return { turnId: turn.id, status: turn.status, nonce: challenge.nonce, observedAt: new Date().toISOString() };
  } finally { cleanup(); }
}

export function createNativeObserver(config, options = {}, deps = {}) {
  validateObserverConfig(config);
  const scope = { agentId: config.agentId, workspace: options.workspace, runtimeId: config.runtimeId, nativeThreadId: config.nativeThreadId,
    profileRevision: config.profileRevision, generation: config.generation, grantRevision: config.grantRevision };
  if (typeof scope.workspace !== "string" || !scope.workspace || typeof options.councilUrl !== "string" || !/^https:\/\//i.test(options.councilUrl)) fail("Native observer Council scope is invalid");
  if (typeof deps.request !== "function" || typeof deps.turnRunner !== "function") fail("Native observer runtime dependencies are unavailable");
  const clock = deps.clock ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const randomId = deps.randomId ?? (() => randomBytes(12).toString("hex"));
  const observerReader = deps.observerReader ?? observeNativeTurn;
  const canRunControl = deps.canRunControl ?? (() => true);
  let busy = false;
  let ticking = false;
  let halted = false;
  let mutationTail = Promise.resolve();

  async function mutateState(fn) {
    const prior = mutationTail;
    let release;
    mutationTail = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
  }

  const fences = () => ({ agent: scope.agentId, workspace: scope.workspace, runtimeId: scope.runtimeId, nativeThreadId: scope.nativeThreadId,
    profileRevision: scope.profileRevision, generation: scope.generation, grantId: config.grantId, grantRevision: config.grantRevision });

  async function ensureState() {
    let state = await readObserverState(config.statePath);
    if (!state || JSON.stringify(state.fences) !== JSON.stringify(fences())) {
      state = { fences: fences(), seq: 0, pendingIssue: null, pendingEvents: [], rejectedPendingEvents: 0, skippedEvents: [], challenge: null, control: {}, proof: null, halted: null, nextAt: 0 };
      await saveObserverState(config.statePath, state);
      halted = false;
    }
    state.pendingEvents ??= [];
    state.rejectedPendingEvents ??= 0;
    state.skippedEvents ??= [];
    for (const [key, control] of Object.entries(state.control)) {
      if (control?.admission || control?.admitBody || control?.uncertain || !Number.isFinite(Date.parse(control?.expiresAt)) || Date.parse(control.expiresAt) > clock()) continue;
      delete state.control[key];
      state.skippedEvents.push({ eventId: control.eventId, challengeId: control.challengeId, seq: control.seq, at: new Date(clock()).toISOString(), reason: "expired-before-admission" });
    }
    state.skippedEvents = state.skippedEvents.slice(-64);
    if (Object.keys(state.control).length > 64) {
      for (const key of Object.keys(state.control)) {
        if (Object.keys(state.control).length <= 64) break;
        if (state.control[key]?.admission) delete state.control[key];
      }
      if (Object.keys(state.control).length > 64) fail("Observer state has too many unresolved native controls");
      await saveObserverState(config.statePath, state);
    }
    if (state.halted) halted = true;
    return state;
  }

  function issueRequestId(operationId) { return `native-challenge:${createHash("sha256").update(operationId).digest("hex").slice(0, 40)}`; }

  async function issueIfDue(state, force = false) {
    const prepared = await mutateState(async () => {
      const current = await ensureState();
      const due = !current.challenge ? (!current.proof || clock() >= current.nextAt) : clock() >= Date.parse(current.challenge.expiresAt);
      if (!current.pendingIssue && !force && !due) return { state: current, shouldRequest: false };
      if (!current.pendingIssue) {
        current.seq += 1;
        const id = `native-issue-${current.seq}-${randomId()}`;
        current.pendingIssue = { id, requestId: issueRequestId(id), body: { grantId: config.grantId, expectedGrantRevision: config.grantRevision,
          expectedRevision: config.profileRevision, generation: config.generation, runtimeId: config.runtimeId } };
        await saveObserverState(config.statePath, current);
      }
      return { state: current, shouldRequest: true, pendingIssue: structuredClone(current.pendingIssue) };
    });
    if (!prepared.shouldRequest) return { state: prepared.state };
    const issued = await deps.request("challenge", prepared.pendingIssue.body, prepared.pendingIssue.requestId);
    if (!issued || typeof issued.id !== "string" || typeof issued.expiresAt !== "string" || !Number.isFinite(Date.parse(issued.expiresAt)) ||
        "nonce" in issued || issued.runtimeId !== scope.runtimeId || issued.profileRevision !== scope.profileRevision ||
        issued.generation !== scope.generation || issued.grantRevision !== scope.grantRevision) fail("Observer challenge response binding is invalid");
    return mutateState(async () => {
      // The event path and response path share this mutation queue. Reload the
      // buffered event after the network wait before clearing pendingIssue.
      const current = await ensureState();
      if (current.pendingIssue?.requestId !== prepared.pendingIssue.requestId) fail("Observer issue state changed while the challenge request was in flight");
      current.challenge = { id: issued.id, expiresAt: issued.expiresAt, issueRequestId: current.pendingIssue.requestId };
      current.pendingIssue = null;
      current.nextAt = Date.parse(issued.expiresAt);
      const buffered = current.pendingEvents ?? [];
      current.pendingEvents = [];
      let promoted = false;
      for (const event of buffered) {
        if (event.challengeId !== current.challenge.id || Date.parse(event.expiresAt) <= clock()) {
          current.rejectedPendingEvents = Math.min(1_000_000, (current.rejectedPendingEvents ?? 0) + 1);
          continue;
        }
        const prior = current.control[event.challengeId];
        if (prior && (prior.nonce !== event.nonce || prior.eventId !== event.eventId)) fail("Buffered native challenge replay changed its binding");
        if (!prior) {
          current.control[event.challengeId] = { challengeId: event.challengeId, nonce: event.nonce, eventId: event.eventId, seq: event.seq,
            expiresAt: event.expiresAt, requestId: controlRequestId(event.challengeId), delivered: true, uncertain: false };
          promoted = true;
        }
      }
      await saveObserverState(config.statePath, current);
      return { state: current, issued: true, promoted };
    });
  }

  async function acceptEvent(event) {
    const disposition = validateNativeControlEvent(event, scope, clock);
    return mutateState(async () => {
      const state = await ensureState();
      if (disposition.stale || halted || state.halted) {
        const skippedEvents = (state.skippedEvents ?? []).filter((item) => item.eventId !== event.eventId);
        skippedEvents.push({ eventId: event.eventId, challengeId: event.challengeId, seq: event.seq, at: new Date(clock()).toISOString(),
          reason: disposition.stale ? "stale-scope-or-expired" : "observer-halted" });
        state.skippedEvents = skippedEvents.slice(-64);
        await saveObserverState(config.statePath, state);
        return { stale: true };
      }
      const existing = state.control[event.challengeId];
      if (existing) {
        if (existing.nonce !== event.nonce || existing.eventId !== event.eventId || existing.seq !== event.seq || existing.expiresAt !== event.expiresAt) fail("Native control event replay changed its binding");
        return existing;
      }
      if (state.challenge?.id === event.challengeId) {
        if (Date.parse(event.expiresAt) > Date.parse(state.challenge.expiresAt)) fail("Native control event expiry exceeds issued challenge");
      } else if (state.pendingIssue) {
        const buffered = state.pendingEvents ?? [];
        const existingBuffer = buffered.find((item) => item.challengeId === event.challengeId);
        if (existingBuffer) {
          if (existingBuffer.nonce !== event.nonce || existingBuffer.eventId !== event.eventId || existingBuffer.seq !== event.seq) fail("Buffered native challenge replay changed its binding");
          return { buffered: true };
        }
        if (buffered.length >= 8) fail("Too many native challenges are awaiting issue confirmation");
        state.pendingEvents = [...buffered, { ...event }];
        await saveObserverState(config.statePath, state);
        return { buffered: true };
      } else {
        fail("Native control event has no matching issued challenge");
      }
      const control = { challengeId: event.challengeId, nonce: event.nonce, eventId: event.eventId, seq: event.seq, expiresAt: event.expiresAt,
        requestId: controlRequestId(event.challengeId), delivered: true, uncertain: false };
      state.control[event.challengeId] = control;
      await saveObserverState(config.statePath, state);
      return control;
    });
  }

  async function admitObserved(challengeId, found) {
    const prepared = await mutateState(async () => {
      const state = await readObserverState(config.statePath);
      const control = state?.control?.[challengeId];
      if (!control) fail("Native control state is missing");
      if (control.admission) return { control, complete: true };
      if (found.nonce !== control.nonce || typeof found.turnId !== "string" || !found.turnId || !Number.isFinite(Date.parse(found.observedAt))) fail("Observed native turn does not prove the issued nonce");
      const admitBody = control.admitBody ?? { grantId: config.grantId, expectedGrantRevision: config.grantRevision, id: challengeId,
        nonce: control.nonce, nativeThreadId: config.nativeThreadId, nativeTurnId: found.turnId, observedAt: found.observedAt };
      const admitRequestId = control.admitRequestId ?? `${control.requestId}:admit`;
      if (!control.admitBody) {
        state.control[challengeId] = { ...control, observedTurnId: found.turnId, admitBody, admitRequestId };
        await saveObserverState(config.statePath, state);
      } else if (control.observedTurnId !== found.turnId) fail("Observed native turn changed during admission recovery");
      return { control: { ...control, admitBody, admitRequestId }, admitBody, admitRequestId };
    });
    if (prepared.complete) return prepared.control;
    const { admitBody, admitRequestId } = prepared;
    const proof = await deps.request("admit", admitBody, admitRequestId);
    if (!proof || proof.mode !== "native-wake" || proof.kind !== "native-admission" || !Number.isFinite(Date.parse(proof.expiresAt)) ||
        proof.generation !== config.generation || proof.profileRevision !== config.profileRevision || proof.grantRevision !== config.grantRevision) fail("Native admission proof response is invalid");
    if (Date.parse(proof.expiresAt) <= clock()) {
      const error = new Error("Native admission proof has expired");
      error.code = "NATIVE_PROOF_EXPIRED";
      throw error;
    }
    return mutateState(async () => {
      const latest = await readObserverState(config.statePath);
      const completed = { ...latest.control[challengeId], admission: { status: "verified", nativeTurnId: found.turnId, expiresAt: proof.expiresAt }, uncertain: false };
      latest.control[challengeId] = completed;
      latest.proof = { expiresAt: proof.expiresAt, nativeTurnId: found.turnId };
      if (latest.challenge?.id === challengeId) latest.challenge = null;
      const jitter = Math.floor(Math.max(0, Math.min(0.999999, random())) * RENEW_JITTER_MS);
      latest.nextAt = Date.parse(proof.expiresAt) - RENEW_EARLY_MS - jitter;
      await saveObserverState(config.statePath, latest);
      return completed;
    });
  }

  async function findExisting(challengeId, control) {
    const expectedText = nativeControlPrompt({ challengeId, nonce: control.nonce });
    return observerReader({ threadId: config.nativeThreadId, requestId: control.requestId, expectedText, timeoutMs: deps.observerTimeoutMs ?? 15_000,
      spawnImpl: deps.spawnImpl, codexBinary: deps.codexBinary ?? "codex", cwd: deps.cwd ?? process.cwd() });
  }

  async function processOne(challengeId) {
    let state = await readObserverState(config.statePath);
    const control = state?.control?.[challengeId];
    if (!control || control.admission) return control ?? null;
    const expired = Date.parse(control.expiresAt) <= clock();
    if (expired && !control.admitBody) return { ...control, expired: true };
    if ((!control.admitBody && !canRunControl()) || busy) return control;
    busy = true;
    try {
      if (control.admitBody) {
        let found;
        try { found = await findExisting(challengeId, control); }
        catch (error) { if (error?.code === "NATIVE_TURN_NOT_FOUND") return control; throw error; }
        try { return await admitObserved(challengeId, found); }
        catch (error) {
          if (!expired || (error?.code !== "NATIVE_PROOF_EXPIRED" && !/\((?:404|409)\)/.test(error?.message ?? ""))) throw error;
          await mutateState(async () => {
            const latest = await readObserverState(config.statePath);
            const current = latest?.control?.[challengeId];
            if (!current || current.admission) return;
            latest.control[challengeId] = { ...current, admission: { status: "expired", at: new Date(clock()).toISOString() }, uncertain: false };
            if (latest.challenge?.id === challengeId) latest.challenge = null;
            latest.nextAt = 0;
            await saveObserverState(config.statePath, latest);
          });
          return { ...control, expired: true };
        }
      }
      if (control.uncertain) {
        let found;
        try { found = await findExisting(challengeId, control); }
        catch (error) { if (error?.code === "NATIVE_TURN_NOT_FOUND") return control; throw error; }
        return admitObserved(challengeId, found);
      }
      await mutateState(async () => {
        state = await readObserverState(config.statePath);
        state.control[challengeId] = { ...state.control[challengeId], uncertain: true, stage: "native-start-pending" };
        await saveObserverState(config.statePath, state);
      });
      const expectedText = nativeControlPrompt({ challengeId, nonce: control.nonce });
      let rejected = false;
      let turnStartingReached = false;
      try {
        await deps.turnRunner({ sessionId: config.nativeThreadId, requestId: control.requestId, prompt: expectedText, codexBinary: deps.codexBinary ?? "codex",
          cwd: deps.cwd ?? process.cwd(), title: "Council native admission control", turnTimeoutMs: 60_000,
          onTurnStarting: async (info) => {
            turnStartingReached = true;
            if (info?.sessionId !== config.nativeThreadId) fail("Native control session changed");
          },
          onTurnStarted: async (info) => {
            if (info?.sessionId !== config.nativeThreadId || typeof info.turnId !== "string") fail("Native control turn identity is invalid");
            const found = await findExisting(challengeId, control);
            if (found.turnId !== info.turnId) fail("Observed native turn does not match the admitted turn");
            await admitObserved(challengeId, found);
          } });
      } catch (error) {
        const latest = (await readObserverState(config.statePath)).control[challengeId];
        if (latest?.admitBody) throw error;
        if (!turnStartingReached || error?.turnStartRejected === true) rejected = true;
        else {
          try {
            const found = await findExisting(challengeId, control);
            return await admitObserved(challengeId, found);
          } catch (readError) {
            if (readError?.code !== "NATIVE_TURN_NOT_FOUND") throw error;
          }
        }
      }
      state = await readObserverState(config.statePath);
      const latest = state.control[challengeId];
      if (latest?.admitBody || latest?.admission) return latest;
      if (!rejected) {
        try { return await admitObserved(challengeId, await findExisting(challengeId, control)); }
        catch (error) { if (error?.code !== "NATIVE_TURN_NOT_FOUND") throw error; }
      }
      if (rejected) {
        await mutateState(async () => {
          state = await readObserverState(config.statePath);
          state.control[challengeId] = { ...state.control[challengeId], uncertain: false, stage: "native-start-rejected" };
          await saveObserverState(config.statePath, state);
        });
      }
      return latest;
    } finally { busy = false; }
  }

  async function tick({ force = false } = {}) {
    if (ticking || busy) return { busy: true };
    ticking = true;
    try {
    let state = await mutateState(() => ensureState());
    if (halted || state.halted) return { halted: true };
    // A persisted admission is an idempotent proof readback, so recover it
    // before issuing a replacement challenge when its original nonce expires.
    for (const challengeId of Object.keys(state.control)) {
      if (!state.control[challengeId]?.admitBody || state.control[challengeId]?.admission) continue;
      try { await processOne(challengeId); }
      catch (error) {
        if (!/\((401|403)\)/.test(error?.message ?? "")) throw error;
        await mutateState(async () => {
          state = await readObserverState(config.statePath);
          state.halted = { at: new Date(clock()).toISOString(), status: "attention" };
          await saveObserverState(config.statePath, state);
        });
        halted = true;
        return { halted: true };
      }
    }
    state = await readObserverState(config.statePath);
    if (halted || state.halted) return { halted: true };
    let result;
    try {
      result = await issueIfDue(state, force);
      state = result.state;
    } catch (error) {
      if (/\((401|403)\)/.test(error?.message ?? "")) {
        await mutateState(async () => {
          state = await readObserverState(config.statePath);
          state.halted = { at: new Date(clock()).toISOString(), status: "attention" };
          await saveObserverState(config.statePath, state);
        });
        halted = true;
        return { halted: true };
      }
      throw error;
    }
    if (result.issued && !result.promoted) return { issued: true };
    for (const challengeId of Object.keys(state.control)) {
      try { await processOne(challengeId); }
      catch (error) {
        if (!/\((401|403)\)/.test(error?.message ?? "")) throw error;
        state = await readObserverState(config.statePath);
        await mutateState(async () => {
          state = await readObserverState(config.statePath);
          state.halted = { at: new Date(clock()).toISOString(), status: "attention" };
          await saveObserverState(config.statePath, state);
        });
        halted = true;
        return { halted: true };
      }
    }
    return { ok: true };
    } finally { ticking = false; }
  }

  return { tick, acceptEvent, process: processOne, status: () => ({ busy, halted }), scope, config };
}
