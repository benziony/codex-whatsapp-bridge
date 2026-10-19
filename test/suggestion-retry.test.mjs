import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { PredictionBindingLedger } from "../scripts/lib/prediction-bindings.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const source = "11111111-1111-4111-8111-111111111111";
const prediction = "22222222-2222-4222-8222-222222222222";
const chat = "120363000000000001@g.us";
const sender = "15550000001@s.whatsapp.net";

function command(script, args, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, "scripts", script), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim() ? JSON.parse(stdout) : null) : reject(new Error(`command failed ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suggestion-retry-"));
  const calls = [];
  const outcomes = { "/send": [200, 503, 200], "/send-poll": [503, 200] };
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const status = outcomes[req.url]?.shift() ?? 200;
    const id = `WA.${calls.length + 1}`; calls.push({ url: req.url, body, status, id });
    res.statusCode = status; res.setHeader("content-type", "application/json");
    if (status === 200) res.end(JSON.stringify(req.url === "/send-poll" ? { pollMessageId: id, messageIds: [id] } : { messageIds: [id] }));
    else res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const ledgerPath = path.join(root, "private", "bindings.json");
  const brokerPath = path.join(root, "broker.json");
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, role: "combined", hostId: "fixture-host",
    codex: { home: path.join(root, "codex"), statePath: path.join(root, "client.json") },
    gateway: { repositoryPath: repo, statePath: brokerPath },
    whatsapp: { chatId: chat, allowedSenders: [sender], bridgeUrl: `http://127.0.0.1:${server.address().port}` } }));
  const env = { ...process.env, CODEX_WHATSAPP_CONFIG: configPath, CODEX_PREDICTION_BINDINGS_PATH: ledgerPath, NODE_NO_WARNINGS: "1" };
  const broker = (action, payload = {}) => command("codex-whatsapp-broker.mjs", [action], payload, env);
  const stop = (sessionId, turnId, body) => command("codex-whatsapp-client.mjs", ["hook"], { hook_event_name: "Stop", session_id: sessionId, turn_id: turnId, last_assistant_message: body }, env);
  const poll = () => command("codex-whatsapp-client.mjs", ["poll"], {}, env);
  const state = () => JSON.parse(fs.readFileSync(brokerPath, "utf8"));
  const makeFailedAtElapsed = (routeId, phase) => {
    const current = state(); const route = current.routes.find((item) => item.id === routeId);
    if (phase === "notification") route.notification.failedAt = Date.now() - 61_000;
    else route.suggestionPoll.failedAt = Date.now() - 61_000;
    fs.writeFileSync(brokerPath, JSON.stringify(current));
  };
  const waitForCalls = async (count) => {
    const deadline = Date.now() + 5_000;
    while (calls.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls.length, count, `expected ${count} sends; observed ${calls.length}`);
  };
  const waitForRoute = async (routeId, predicate) => {
    const deadline = Date.now() + 5_000;
    while (!predicate(state().routes.find((item) => item.id === routeId)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return state().routes.find((item) => item.id === routeId);
  };
  return { calls, broker, stop, poll, state, makeFailedAtElapsed, waitForCalls, waitForRoute, ledgerPath };
}

test("poll retries definite suggestion and native-poll failures without replaying Stop", async (t) => {
  const f = await fixture(t);
  const ledger = new PredictionBindingLedger(f.ledgerPath);
  ledger.registerEphemeralThread({ threadId: prediction, sourceThreadId: source });
  ledger.recordPending({ requestId: "source-turn", threadId: prediction, sourceThreadId: source, sourceTurnId: "source-turn" });
  ledger.finalizeByRequest({ requestId: "source-turn", threadId: prediction, turnId: "prediction-turn" });

  await f.broker("create", { originHost: "fixture-host", sessionId: source, turnId: "source-turn", finalText: "Source answer" });
  await f.stop(prediction, "prediction-turn", JSON.stringify({ suggestion: "Send exactly once " + "x".repeat(256) }));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, "/send");
  const initial = f.state().routes.find((item) => item.kind === "suggestion");
  assert.equal(initial.notification.status, "failed");
  const routeId = initial.id;
  f.makeFailedAtElapsed(routeId, "notification");

  await f.poll();
  await f.waitForCalls(4);
  await f.waitForRoute(routeId, (route) => route.suggestionPoll.status === "failed");
  assert.equal(f.calls[2].url, "/send");
  assert.equal(f.calls[2].status, 200);
  assert.equal(f.calls[3].url, "/send-poll");
  assert.equal(f.calls[3].status, 503);
  assert.equal(f.state().routes.find((item) => item.id === routeId).notification.status, "sent");
  assert.equal(f.state().routes.find((item) => item.id === routeId).suggestionPoll.status, "failed");
  f.makeFailedAtElapsed(routeId, "poll");

  await f.poll();
  await f.waitForCalls(5);
  await f.waitForRoute(routeId, (route) => route.suggestionPoll.status === "sent");
  assert.equal(f.calls[4].url, "/send-poll");
  assert.equal(f.calls[4].status, 200);
  assert.equal(f.calls[3].body.deliveryKey, f.calls[4].body.deliveryKey);
  const final = f.state().routes.find((item) => item.id === routeId);
  assert.equal(final.notification.status, "sent");
  assert.equal(final.suggestionPoll.status, "sent");
  assert.equal(f.calls.filter((call) => call.url === "/send").length, 3);
});
