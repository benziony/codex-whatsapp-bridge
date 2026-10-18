#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PredictionBindingLedger } from "./lib/prediction-bindings.mjs";

const MAX_JSON_LINE_BYTES = 1_048_576;

function requestKey(value) {
  if (!(typeof value === "string" || typeof value === "number") || typeof value === "number" && !Number.isFinite(value)) return null;
  return JSON.stringify(value);
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }

function privateLedgerPath(env) {
  return env.CODEX_PREDICTION_BINDINGS_PATH || path.join(os.homedir(), ".config", "codex-whatsapp-bridge", "prediction-bindings.json");
}

function realCliPath(env) {
  const requested = env.CODEX_PREDICTION_REAL_CLI_PATH;
  if (typeof requested !== "string" || !path.isAbsolute(requested)) throw new Error("CODEX_PREDICTION_REAL_CLI_PATH must be an absolute path");
  const resolved = fs.realpathSync(requested);
  if (!fs.statSync(resolved).isFile()) throw new Error("Configured real Codex CLI is not a file");
  if (resolved === fs.realpathSync(fileURLToPath(import.meta.url))) throw new Error("Prediction proxy cannot invoke itself");
  return resolved;
}

function writeWithBackpressure(source, destination, resume) {
  if (!destination.write(source)) {
    source.pause?.();
    destination.once("drain", () => resume?.());
    return false;
  }
  return true;
}

function lineTap({ input, output, childInput = null, childOutput = null, beforeInput = () => {}, beforeOutput = () => {} }) {
  let pending = Buffer.alloc(0);
  let discardingOversizedLine = false;
  const send = (frame) => {
    if (childInput) {
      if (!childInput.write(frame)) { input.pause(); childInput.once("drain", () => input.resume()); }
    }
    else if (!output.write(frame)) { childOutput.pause(); output.once("drain", () => childOutput.resume()); }
  };
  input.on("data", (chunk) => {
    if (discardingOversizedLine) {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) { send(chunk); return; }
      send(chunk.subarray(0, newline + 1));
      chunk = chunk.subarray(newline + 1);
      discardingOversizedLine = false;
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.length > MAX_JSON_LINE_BYTES) { const overflow = pending; pending = Buffer.alloc(0); discardingOversizedLine = true; send(overflow); }
        break;
      }
      const frameLength = newline + 1;
      const frame = pending.subarray(0, frameLength);
      pending = pending.subarray(frameLength);
      if (frame.length <= MAX_JSON_LINE_BYTES) {
        const message = parseJsonLine(frame);
        if (message) {
          try { (childInput ? beforeInput : beforeOutput)(message); } catch { /* metadata failure never changes Codex protocol bytes */ }
        }
      }
      send(frame);
    }
  });
  input.on("end", () => {
    if (pending.length) { send(pending); pending = Buffer.alloc(0); }
    if (childInput) childInput.end();
  });
  input.on("error", () => { if (childInput && !childInput.destroyed) childInput.end(); });
}

function parseJsonLine(frame) {
  try {
    const message = JSON.parse(frame.toString("utf8"));
    return object(message) ? message : null;
  } catch { return null; }
}

function directExec(executable, args, env) {
  const child = spawn(executable, args, { stdio: "inherit", env: { ...env, CODEX_CLI_PATH: executable }, shell: false });
  child.once("error", () => { process.exitCode = 127; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 + (os.constants?.signals?.[signal] ?? 1) : 1); });
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"]) process.once(signal, () => { try { child.kill(signal); } catch { /* child already exited */ } });
}

function runStdioProxy(executable, args, env) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...env, CODEX_CLI_PATH: executable }, shell: false });
  const ledger = new PredictionBindingLedger(privateLedgerPath(env));
  const connectionId = crypto.randomUUID();
  const forkRequests = new Map();
  const startRequests = new Map();
  const pendingThreads = new Set();
  const safe = (operation) => { try { return operation(); } catch { return null; } };

  const beforeInput = (message) => {
    const key = requestKey(message.id);
    if (typeof message.method !== "string" || !object(message.params)) return;
    if (message.method === "thread/fork" && key) {
      const params = message.params;
      const eligible = typeof params.threadId === "string" && params.experimentalPredictionMode === true &&
        params.ephemeral === true && params.threadSource === "composer_predictions" && params.excludeTurns === true;
      const existing = forkRequests.get(key);
      if (existing) forkRequests.set(key, null);
      else forkRequests.set(key, eligible ? { sourceThreadId: params.threadId } : null);
      return;
    }
    if (message.method !== "turn/start" || !key) return;
    const params = message.params;
    const metadata = params.responsesapiClientMetadata;
    const sourceThreadId = object(metadata) ? metadata.prediction_source_thread_id : null;
    const sourceTurnId = object(metadata) ? metadata.prediction_source_turn_id : null;
    if (typeof params.threadId !== "string" || typeof sourceThreadId !== "string" || typeof sourceTurnId !== "string") return;
    const result = safe(() => ledger.recordPending({ requestId: message.id, connectionId, threadId: params.threadId, sourceThreadId, sourceTurnId }));
    if (result?.status === "pending") {
      startRequests.set(key, { threadId: params.threadId });
      pendingThreads.add(params.threadId);
    } else startRequests.set(key, null);
  };

  const beforeOutput = (message) => {
    const key = requestKey(message.id);
    if (key && !message.method && forkRequests.has(key)) {
      const source = forkRequests.get(key);
      forkRequests.delete(key);
      if (source && !message.error) {
        const threadId = message.result?.thread?.id;
        if (typeof threadId === "string") safe(() => ledger.registerEphemeralThread({ threadId, sourceThreadId: source.sourceThreadId }));
      }
    }
    if (message.method === "turn/started" && object(message.params) && typeof message.params.threadId === "string" && pendingThreads.has(message.params.threadId)) {
      const turnId = message.params.turn?.id;
      if (typeof turnId === "string") safe(() => ledger.finalizePending({ threadId: message.params.threadId, turnId }));
      return;
    }
    if (key && !message.method && startRequests.has(key)) {
      const request = startRequests.get(key);
      startRequests.delete(key);
      if (!request) return;
      if (message.error) {
        safe(() => ledger.cancelPending({ requestId: message.id, connectionId }));
        return;
      }
      const turnId = message.result?.turn?.id;
      if (typeof turnId === "string") safe(() => ledger.finalizeByRequest({ requestId: message.id, connectionId, threadId: request.threadId, turnId }));
    }
  };

  const streamTap = (source, destination) => {
    source.on("data", (chunk) => {
      if (!destination.write(chunk)) { source.pause(); destination.once("drain", () => source.resume()); }
    });
    source.on("end", () => destination.end());
    source.on("error", () => destination.end());
  };

  lineTap({ input: process.stdin, output: child.stdin, childInput: child.stdin, beforeInput });
  lineTap({ input: child.stdout, output: process.stdout, childOutput: child.stdout, beforeOutput });
  streamTap(child.stderr, process.stderr);

  process.stdin.resume();
  const shutdown = (signal) => { try { child.kill(signal); } catch { /* child already exited */ } };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"]) process.once(signal, () => shutdown(signal));
  child.once("error", () => { process.exitCode = 127; });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + (os.constants?.signals?.[signal] ?? 1) : 1);
    if (!process.stdin.destroyed) process.stdin.pause();
  });
}

try {
  const executable = realCliPath(process.env);
  const args = process.argv.slice(2);
  const commandIndex = args.indexOf("app-server");
  const listenIndex = args.indexOf("--listen");
  const listenEquals = args.find((arg) => arg.startsWith("--listen="));
  const listenValue = listenIndex >= 0 ? args[listenIndex + 1] : listenEquals?.slice("--listen=".length);
  const stdioAppServer = commandIndex >= 0 && (listenValue === undefined || listenValue.startsWith("stdio://"));
  if (stdioAppServer) runStdioProxy(executable, args, process.env);
  else directExec(executable, args, process.env);
} catch {
  process.exitCode = 127;
}
