import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = 1;
const MAX_LEDGER_BYTES = 1_048_576;
const MAX_ROWS = 1_024;
const TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 15_000;

function identifier(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requestKey(value) {
  if (!(typeof value === "string" || typeof value === "number") || typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("request id is invalid");
  }
  return JSON.stringify(value);
}

function namespacedRequestKey(requestId, connectionId = "default") {
  return JSON.stringify([identifier(connectionId, "connection id"), requestKey(requestId)]);
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, ephemeralThreads: [], pending: [], bindings: [], resolvedRequests: [] };
}

function validateState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.ephemeralThreads) ||
      !Array.isArray(value.pending) || !Array.isArray(value.bindings) || !Array.isArray(value.resolvedRequests) ||
      value.ephemeralThreads.length + value.pending.length + value.bindings.length + value.resolvedRequests.length > MAX_ROWS * 4) {
    throw new Error("Prediction binding ledger is invalid");
  }
  for (const row of value.ephemeralThreads) {
    identifier(row.threadId, "prediction thread id"); identifier(row.sourceThreadId, "source thread id");
    if (!Number.isSafeInteger(row.createdAt) || !["registered", "ambiguous"].includes(row.status)) throw new Error("Prediction thread record is invalid");
  }
  for (const row of value.pending) {
    if (typeof row.requestKey !== "string" || JSON.parse(row.requestKey).length !== 2) throw new Error("Pending prediction request key is invalid"); identifier(row.threadId, "prediction thread id");
    identifier(row.sourceThreadId, "source thread id"); identifier(row.sourceTurnId, "source turn id");
    if (!Number.isSafeInteger(row.createdAt) || typeof row.ambiguous !== "boolean") throw new Error("Pending prediction record is invalid");
  }
  for (const row of value.bindings) {
    identifier(row.threadId, "prediction thread id"); identifier(row.turnId, "prediction turn id");
    identifier(row.sourceThreadId, "source thread id"); identifier(row.sourceTurnId, "source turn id");
    if (!Number.isSafeInteger(row.createdAt) || !["bound", "ambiguous"].includes(row.status)) throw new Error("Prediction binding record is invalid");
  }
  for (const row of value.resolvedRequests) {
    if (typeof row.requestKey !== "string" || JSON.parse(row.requestKey).length !== 2) throw new Error("Resolved prediction request key is invalid"); identifier(row.threadId, "prediction thread id"); identifier(row.turnId, "prediction turn id");
    identifier(row.sourceThreadId, "source thread id"); identifier(row.sourceTurnId, "source turn id");
    if (!Number.isSafeInteger(row.createdAt)) throw new Error("Resolved prediction request is invalid");
  }
  return value;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Prediction binding directory is unsafe");
  fs.chmodSync(directory, 0o700);
}

function assertPrivateDirectory(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o700) throw new Error("Prediction binding directory is unsafe");
  return true;
}

function assertPrivateFile(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600) throw new Error("Prediction binding file is unsafe");
  if (stat.size > MAX_LEDGER_BYTES) throw new Error("Prediction binding ledger exceeds its size limit");
  return true;
}

export class PredictionBindingLedger {
  constructor(filePath, { now = () => Date.now(), lockTimeoutMs = LOCK_TIMEOUT_MS, lockStaleMs = LOCK_STALE_MS } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("An absolute prediction binding path is required");
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
  }

  #load() {
    if (!assertPrivateDirectory(path.dirname(this.filePath))) return emptyState();
    if (!assertPrivateFile(this.filePath)) return emptyState();
    return validateState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  #save(state) {
    validateState(state);
    const data = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(data) > MAX_LEDGER_BYTES) throw new Error("Prediction binding ledger exceeds its size limit");
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, data);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      const directoryDescriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  #transact(callback) {
    const directory = path.dirname(this.filePath);
    ensurePrivateDirectory(directory);
    const token = crypto.randomUUID();
    const started = Date.now();
    while (true) {
      try { fs.writeFileSync(this.lockPath, token, { flag: "wx", mode: 0o600 }); break; }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const lock = fs.lstatSync(this.lockPath);
          if (!lock.isFile() || lock.isSymbolicLink() || (typeof process.getuid === "function" && lock.uid !== process.getuid())) throw new Error("Prediction binding lock is unsafe");
          if (Date.now() - lock.mtimeMs > this.lockStaleMs) { fs.unlinkSync(this.lockPath); continue; }
        } catch (statError) { if (statError?.code === "ENOENT") continue; throw statError; }
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error("Prediction binding ledger is busy");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      const state = this.#load();
      const result = callback(state);
      const cutoff = this.now() - TTL_MS;
      state.ephemeralThreads = state.ephemeralThreads.filter((row) => row.createdAt >= cutoff).slice(-MAX_ROWS);
      state.pending = state.pending.filter((row) => row.createdAt >= cutoff).slice(-MAX_ROWS);
      state.bindings = state.bindings.filter((row) => row.createdAt >= cutoff).slice(-MAX_ROWS);
      state.resolvedRequests = state.resolvedRequests.filter((row) => row.createdAt >= cutoff).slice(-MAX_ROWS);
      this.#save(state);
      return result;
    } finally {
      try { if (fs.readFileSync(this.lockPath, "utf8") === token) fs.unlinkSync(this.lockPath); } catch { /* another owner or crash cleanup */ }
    }
  }

  registerEphemeralThread({ threadId, sourceThreadId }) {
    threadId = identifier(threadId, "prediction thread id"); sourceThreadId = identifier(sourceThreadId, "source thread id");
    const now = this.now();
    return this.#transact((state) => {
      const existing = state.ephemeralThreads.find((row) => row.threadId === threadId);
      if (existing && existing.sourceThreadId !== sourceThreadId) { existing.status = "ambiguous"; return { status: "ambiguous" }; }
      if (!existing) state.ephemeralThreads.push({ threadId, sourceThreadId, createdAt: now, status: "registered" });
      return { status: existing?.status ?? "registered" };
    });
  }

  recordPending({ requestId, connectionId = "default", threadId, sourceThreadId, sourceTurnId }) {
    const key = namespacedRequestKey(requestId, connectionId);
    threadId = identifier(threadId, "prediction thread id"); sourceThreadId = identifier(sourceThreadId, "source thread id"); sourceTurnId = identifier(sourceTurnId, "source turn id");
    const now = this.now();
    return this.#transact((state) => {
      const ephemeral = state.ephemeralThreads.find((row) => row.threadId === threadId);
      if (!ephemeral || ephemeral.status !== "registered" || ephemeral.sourceThreadId !== sourceThreadId) return { status: "unregistered" };
      const existing = state.pending.find((row) => row.requestKey === key);
      if (existing) {
        if (existing.threadId !== threadId || existing.sourceThreadId !== sourceThreadId || existing.sourceTurnId !== sourceTurnId) existing.ambiguous = true;
        return { status: existing.ambiguous ? "ambiguous" : "pending" };
      }
      const resolved = state.resolvedRequests.find((row) => row.requestKey === key);
      if (resolved) return { status: "ambiguous" };
      state.pending.push({ requestKey: key, threadId, sourceThreadId, sourceTurnId, createdAt: now, ambiguous: false });
      return { status: "pending" };
    });
  }

  #finalize(state, pending, turnId) {
    turnId = identifier(turnId, "prediction turn id");
    if (!pending || pending.ambiguous) return { status: "ambiguous" };
    const existing = state.bindings.find((row) => row.threadId === pending.threadId && row.turnId === turnId);
    if (existing && (existing.sourceThreadId !== pending.sourceThreadId || existing.sourceTurnId !== pending.sourceTurnId)) {
      existing.status = "ambiguous";
      return { status: "ambiguous" };
    }
    if (!existing) state.bindings.push({ threadId: pending.threadId, turnId, sourceThreadId: pending.sourceThreadId, sourceTurnId: pending.sourceTurnId, createdAt: this.now(), status: "bound" });
    const resolved = state.resolvedRequests.find((row) => row.requestKey === pending.requestKey);
    if (resolved && (resolved.threadId !== pending.threadId || resolved.turnId !== turnId || resolved.sourceThreadId !== pending.sourceThreadId || resolved.sourceTurnId !== pending.sourceTurnId)) {
      const old = state.bindings.find((row) => row.threadId === resolved.threadId && row.turnId === resolved.turnId);
      if (old) old.status = "ambiguous";
      const current = state.bindings.find((row) => row.threadId === pending.threadId && row.turnId === turnId);
      if (current) current.status = "ambiguous";
      return { status: "ambiguous" };
    }
    if (!resolved) state.resolvedRequests.push({ requestKey: pending.requestKey, threadId: pending.threadId, turnId, sourceThreadId: pending.sourceThreadId, sourceTurnId: pending.sourceTurnId, createdAt: this.now() });
    state.pending = state.pending.filter((row) => row.requestKey !== pending.requestKey);
    return { status: "bound", threadId: pending.threadId, turnId, sourceThreadId: pending.sourceThreadId, sourceTurnId: pending.sourceTurnId };
  }

  finalizeByRequest({ requestId, connectionId = "default", threadId, turnId }) {
    const key = namespacedRequestKey(requestId, connectionId);
    threadId = identifier(threadId, "prediction thread id");
    return this.#transact((state) => {
      const pending = state.pending.find((row) => row.requestKey === key);
      if (pending && pending.threadId !== threadId) { pending.ambiguous = true; return { status: "ambiguous" }; }
      if (pending) return this.#finalize(state, pending, turnId);
      const resolved = state.resolvedRequests.find((row) => row.requestKey === key);
      if (resolved && resolved.threadId === threadId && resolved.turnId === turnId) return { status: "bound", ...resolved, sourceThreadId: resolved.sourceThreadId, sourceTurnId: resolved.sourceTurnId };
      if (resolved) {
        const prior = state.bindings.find((row) => row.threadId === resolved.threadId && row.turnId === resolved.turnId);
        if (prior) prior.status = "ambiguous";
        return { status: "ambiguous" };
      }
      return { status: "unbound" };
    });
  }

  finalizePending({ threadId, turnId }) {
    threadId = identifier(threadId, "prediction thread id");
    return this.#transact((state) => {
      const pending = state.pending.filter((row) => row.threadId === threadId && !row.ambiguous);
      if (pending.length !== 1 || state.pending.some((row) => row.threadId === threadId && row.ambiguous)) return { status: pending.length ? "ambiguous" : "unbound" };
      return this.#finalize(state, pending[0], turnId);
    });
  }

  cancelPending({ requestId, connectionId = "default" }) {
    const key = namespacedRequestKey(requestId, connectionId);
    return this.#transact((state) => {
      const before = state.pending.length;
      state.pending = state.pending.filter((row) => row.requestKey !== key);
      return { status: state.pending.length < before ? "cancelled" : "unbound" };
    });
  }

  resolveStopBinding({ threadId, turnId }) {
    threadId = identifier(threadId, "prediction thread id"); turnId = identifier(turnId, "prediction turn id");
    const state = this.#load();
    const matches = state.bindings.filter((row) => row.threadId === threadId && row.turnId === turnId);
    if (matches.some((row) => row.status === "ambiguous")) return { status: "ambiguous" };
    if (matches.length === 1) return { status: "bound", threadId, turnId, sourceThreadId: matches[0].sourceThreadId, sourceTurnId: matches[0].sourceTurnId };
    if (matches.length > 1) return { status: "ambiguous" };
    if (state.pending.some((row) => row.threadId === threadId)) return { status: "pending" };
    return { status: "unbound" };
  }
}

let defaultLedger;
export function resolveStopBinding(input) {
  const filePath = process.env.CODEX_PREDICTION_BINDINGS_PATH || path.join(os.homedir(), ".config", "codex-whatsapp-bridge", "prediction-bindings.json");
  try {
    defaultLedger ??= new PredictionBindingLedger(filePath);
    if (defaultLedger.filePath !== filePath) defaultLedger = new PredictionBindingLedger(filePath);
    return defaultLedger.resolveStopBinding(input);
  } catch {
    return { status: "error" };
  }
}
