import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { PredictionBindingLedger, resolveStopBinding } from "../scripts/lib/prediction-bindings.mjs";

const proxyPath = path.resolve("scripts/codex-prediction-proxy.mjs");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prediction-proxy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(executable, args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    child.stdin.end(input);
  });
}

function interactive(executable, args, env) {
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const output = []; const stderr = []; const waiters = []; let buffered = "";
  child.stdout.on("data", (chunk) => {
    output.push(chunk); buffered += chunk.toString("utf8");
    while (buffered.includes("\n") && waiters.length) { const index = buffered.indexOf("\n"); const line = buffered.slice(0, index + 1); buffered = buffered.slice(index + 1); waiters.shift()(line); }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return {
    child,
    nextLine: () => new Promise((resolve) => waiters.push(resolve)),
    write: (text) => child.stdin.write(text),
    end: () => child.stdin.end(),
    result: () => new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(output), stderr: Buffer.concat(stderr) })); }),
  };
}

test("stdio proxy registers only exact ephemeral forks, persists turn bindings before forwarding, and preserves protocol bytes", async (t) => {
  const dir = tempDir(t);
  const fakeCli = path.join(dir, "fake-codex.mjs");
  const capturePath = path.join(dir, "input.bin");
  const argsPath = path.join(dir, "args.json");
  const ledgerPath = path.join(dir, "private", "prediction-bindings.json");
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.PROXY_ARGS_PATH,JSON.stringify(process.argv.slice(2)));
const input=[];const queue=[];let pending=Buffer.alloc(0);let active=false;
const emit=(s)=>process.stdout.write(s);
const next=()=>{if(active||!queue.length)return;active=true;const m=queue.shift();setImmediate(()=>{if(m.method==='thread/fork')emit(JSON.stringify({id:m.id,result:{thread:{id:'prediction-thread'}}})+'\\n');else if(m.method==='turn/start'){const state=JSON.parse(fs.readFileSync(process.env.CODEX_PREDICTION_BINDINGS_PATH,'utf8'));if(!state.pending.some(x=>x.threadId==='prediction-thread'&&x.sourceThreadId==='source-thread'&&x.sourceTurnId==='source-turn'))process.exitCode=31;emit(JSON.stringify({method:'turn/started',params:{threadId:'prediction-thread',turn:{id:'prediction-turn'}}})+'\\n');emit(JSON.stringify({id:m.id,result:{turn:{id:'prediction-turn'}}})+'\\n');emit(JSON.stringify({method:'turn/completed',params:{threadId:'prediction-thread',turn:{id:'prediction-turn',items:[{type:'agentMessage',text:'OUTPUT_SECRET_NEVER_STORE'}]}}})+'\\n');}active=false;next();});};
process.stderr.write('private stderr fixture\\n');
process.stdin.on('data',chunk=>{input.push(chunk);pending=pending.length?Buffer.concat([pending,chunk]):chunk;while(true){const i=pending.indexOf(10);if(i<0)break;const line=pending.subarray(0,i+1);pending=pending.subarray(i+1);queue.push(JSON.parse(line.toString()));}next();});
process.stdin.on('end',()=>{fs.writeFileSync(process.env.PROXY_CAPTURE_PATH,Buffer.concat(input));});
`);
  fs.chmodSync(fakeCli, 0o700);
  const env = { ...process.env, CODEX_PREDICTION_REAL_CLI_PATH: fakeCli, CODEX_PREDICTION_BINDINGS_PATH: ledgerPath, PROXY_CAPTURE_PATH: capturePath, PROXY_ARGS_PATH: argsPath };
  const input = [
    ` ${JSON.stringify({ id: 10, method: "thread/fork", params: { threadId: "source-thread", experimentalPredictionMode: true, ephemeral: true, threadSource: "composer_predictions", excludeTurns: true } })}\r\n`,
    `\t${JSON.stringify({ id: 11, method: "turn/start", params: { threadId: "prediction-thread", prompt: "INPUT_SECRET_NEVER_STORE", responsesapiClientMetadata: { prediction_source_thread_id: "source-thread", prediction_source_turn_id: "source-turn" } } })} \n`,
  ].join("");
  const expectedOutput = [
    JSON.stringify({ id: 10, result: { thread: { id: "prediction-thread" } } }),
    JSON.stringify({ method: "turn/started", params: { threadId: "prediction-thread", turn: { id: "prediction-turn" } } }),
    JSON.stringify({ id: 11, result: { turn: { id: "prediction-turn" } } }),
    JSON.stringify({ method: "turn/completed", params: { threadId: "prediction-thread", turn: { id: "prediction-turn", items: [{ type: "agentMessage", text: "OUTPUT_SECRET_NEVER_STORE" }] } } }),
  ].join("\n") + "\n";
  const desktopArgs = ["-c", "features.code_mode_host=true", "app-server", "--listen", "stdio://", "--analytics-default-enabled"];
  const session = interactive(process.execPath, [proxyPath, ...desktopArgs], env);
  const split = input.indexOf("\n") + 1;
  session.write(input.slice(0, split));
  await session.nextLine();
  session.write(input.slice(split));
  const resultPromise = session.result();
  session.end();
  const result = await resultPromise;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.toString(), expectedOutput);
  assert.equal(result.stderr.toString(), "private stderr fixture\n");
  assert.deepEqual(fs.readFileSync(capturePath), Buffer.from(input));
  assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")), desktopArgs);
  const ledgerText = fs.readFileSync(ledgerPath, "utf8");
  assert.equal(ledgerText.includes("INPUT_SECRET_NEVER_STORE"), false);
  assert.equal(ledgerText.includes("OUTPUT_SECRET_NEVER_STORE"), false);
  assert.deepEqual(new PredictionBindingLedger(ledgerPath).resolveStopBinding({ threadId: "prediction-thread", turnId: "prediction-turn" }), {
    status: "bound", threadId: "prediction-thread", turnId: "prediction-turn", sourceThreadId: "source-thread", sourceTurnId: "source-turn",
  });
  assert.equal(fs.statSync(path.dirname(ledgerPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600);
});

test("oversized JSON lines are forwarded but their suffix is never parsed as a separate frame", async (t) => {
  const dir = tempDir(t);
  const fakeCli = path.join(dir, "fake-codex.mjs");
  const ledgerPath = path.join(dir, "private", "prediction-bindings.json");
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
let pending=Buffer.alloc(0);
const emit=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
process.stdin.on('data',chunk=>{pending=pending.length?Buffer.concat([pending,chunk]):chunk;while(true){const i=pending.indexOf(10);if(i<0)break;const line=pending.subarray(0,i+1);pending=pending.subarray(i+1);let m;try{m=JSON.parse(line.toString())}catch{continue}if(m.method==='thread/fork')emit({id:m.id,result:{thread:{id:'prediction-thread'}}});if(m.method==='turn/start'){emit({method:'turn/started',params:{threadId:'prediction-thread',turn:{id:'suffix-turn'}}});emit({id:m.id,result:{turn:{id:'suffix-turn'}}});}}});
`);
  fs.chmodSync(fakeCli, 0o700);
  const env = { ...process.env, CODEX_PREDICTION_REAL_CLI_PATH: fakeCli, CODEX_PREDICTION_BINDINGS_PATH: ledgerPath };
  const session = interactive(process.execPath, [proxyPath, "app-server", "--listen", "stdio://"], env);
  session.write(JSON.stringify({ id: 1, method: "thread/fork", params: { threadId: "source-thread", experimentalPredictionMode: true, ephemeral: true, threadSource: "composer_predictions", excludeTurns: true } }) + "\n");
  await session.nextLine();
  const suffix = JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "prediction-thread", responsesapiClientMetadata: { prediction_source_thread_id: "source-thread", prediction_source_turn_id: "source-turn" } } }) + "\n";
  session.write("x".repeat(1_048_577));
  session.write(suffix);
  const resultPromise = session.result();
  session.end();
  const result = await resultPromise;
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), JSON.stringify({ id: 1, result: { thread: { id: "prediction-thread" } } }) + "\n");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.pending.length, 0);
  assert.equal(ledger.bindings.length, 0);
});

test("ledger treats conflicting source tuples and ambiguous pending requests as non-bindable", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "ledger", "bindings.json");
  const ledger = new PredictionBindingLedger(filePath, { now: () => 1_000 });
  assert.equal(ledger.registerEphemeralThread({ threadId: "prediction", sourceThreadId: "source-a" }).status, "registered");
  assert.equal(ledger.recordPending({ requestId: 1, threadId: "prediction", sourceThreadId: "source-a", sourceTurnId: "turn-a" }).status, "pending");
  assert.equal(ledger.recordPending({ requestId: 2, threadId: "prediction", sourceThreadId: "source-a", sourceTurnId: "turn-b" }).status, "pending");
  assert.equal(ledger.finalizePending({ threadId: "prediction", turnId: "prediction-turn" }).status, "ambiguous");
  assert.equal(ledger.resolveStopBinding({ threadId: "prediction", turnId: "prediction-turn" }).status, "pending");
  assert.equal(ledger.finalizeByRequest({ requestId: 1, threadId: "prediction", turnId: "prediction-turn" }).status, "bound");
  assert.equal(ledger.finalizeByRequest({ requestId: 2, threadId: "prediction", turnId: "prediction-turn" }).status, "ambiguous");
  assert.equal(ledger.resolveStopBinding({ threadId: "prediction", turnId: "prediction-turn" }).status, "ambiguous");
  assert.equal(ledger.registerEphemeralThread({ threadId: "prediction", sourceThreadId: "source-b" }).status, "ambiguous");
});

test("connection-local RPC ids do not collide across proxy process restarts", (t) => {
  const dir = tempDir(t);
  const ledger = new PredictionBindingLedger(path.join(dir, "ledger", "bindings.json"));
  ledger.registerEphemeralThread({ threadId: "prediction", sourceThreadId: "source" });
  ledger.recordPending({ requestId: 7, connectionId: "process-one", threadId: "prediction", sourceThreadId: "source", sourceTurnId: "source-turn-one" });
  ledger.recordPending({ requestId: 7, connectionId: "process-two", threadId: "prediction", sourceThreadId: "source", sourceTurnId: "source-turn-two" });
  assert.equal(ledger.finalizeByRequest({ requestId: 7, connectionId: "process-one", threadId: "prediction", turnId: "prediction-turn-one" }).status, "bound");
  assert.equal(ledger.finalizeByRequest({ requestId: 7, connectionId: "process-two", threadId: "prediction", turnId: "prediction-turn-two" }).status, "bound");
  assert.equal(ledger.resolveStopBinding({ threadId: "prediction", turnId: "prediction-turn-one" }).sourceTurnId, "source-turn-one");
  assert.equal(ledger.resolveStopBinding({ threadId: "prediction", turnId: "prediction-turn-two" }).sourceTurnId, "source-turn-two");
});

test("non-app-server invocations forward every argument and keep the real CLI from recursing into the proxy", async (t) => {
  const dir = tempDir(t);
  const fakeCli = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),cliPath:process.env.CODEX_CLI_PATH}));\n`);
  fs.chmodSync(fakeCli, 0o700);
  const result = await run(process.execPath, [proxyPath, "--version", "--flag", "value"], { ...process.env, CODEX_PREDICTION_REAL_CLI_PATH: fakeCli });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.toString()), { args: ["--version", "--flag", "value"], cliPath: fs.realpathSync(fakeCli) });
});

test("Stop resolver fails closed for absent, corrupt, or unsafe ledgers", (t) => {
  const dir = tempDir(t);
  const old = process.env.CODEX_PREDICTION_BINDINGS_PATH;
  t.after(() => { if (old === undefined) delete process.env.CODEX_PREDICTION_BINDINGS_PATH; else process.env.CODEX_PREDICTION_BINDINGS_PATH = old; });
  const filePath = path.join(dir, "ledger", "bindings.json");
  process.env.CODEX_PREDICTION_BINDINGS_PATH = filePath;
  assert.equal(resolveStopBinding({ threadId: "t", turnId: "u" }).status, "unbound");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, "not-json", { mode: 0o600 });
  assert.equal(resolveStopBinding({ threadId: "t", turnId: "u" }).status, "error");
});
