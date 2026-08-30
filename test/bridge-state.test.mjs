import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CodexWhatsAppBroker, CodexApprovalStore, sendWhatsAppNotification, sendWhatsAppReaction } from "../scripts/lib/bridge-state.mjs";

const sender = "15550000001@s.whatsapp.net";
const chat = "120363000000000001@g.us";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { now: Date.UTC(2026, 7, 27) };
  const statePath = path.join(root, "private", "state.json");
  const broker = new CodexWhatsAppBroker({ statePath, allowedSenders: [sender], allowedChats: [chat], notificationTarget: chat, taskInboxTarget: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" }, now: () => clock.now });
  return { broker, clock, statePath };
}

function createAndSend(broker, turnId = "turn-1", messageIds = ["WA.chunk-1"]) {
  const created = broker.create({ originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId, finalText: "Completed turn text\nwith markdown." });
  const finished = broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, messageIds });
  return { created, finished };
}

test("completed turn work log and final are sent in order then removed while every message is routed", (t) => {
  const { broker, statePath } = fixture(t);
  const created = broker.create({
    originHost: "regular-mac",
    sessionId: "11111111-1111-4111-8111-111111111111",
    turnId: "turn-a",
    activityText: "Project · Task\n\nWork log\n\nVisible update.",
    finalText: "Project · Task\n\nFinal\n\nCompleted turn text\nwith markdown.",
  });
  assert.deepEqual(created.notification.messages, [
    "Project · Task\n\nWork log\n\nVisible update.",
    "Project · Task\n\nFinal\n\nCompleted turn text\nwith markdown.",
  ]);
  const finished = broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, messageIds: ["WA.a", "WA.b"] });
  assert.equal(finished.status, "sent");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.routes[0].finalText, undefined);
  assert.equal(state.routes[0].activityText, undefined);
  assert.equal(state.routes[0].messageDigests.length, 2);
  assert.equal(JSON.stringify(state).includes("WA.a"), false);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
});

test("retrying create after a lost response reuses the exact durable route", (t) => {
  const { broker } = fixture(t);
  const input = { originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId: "turn-lost-create-response", finalText: "Durable result" };
  const first = broker.create(input);
  const retried = broker.create(input);
  assert.equal(retried.created, false);
  assert.equal(retried.route.id, first.route.id);
  assert.equal(retried.status, "sending");
  assert.equal(retried.notification, undefined);
});

test("replying to any chunk queues exact bodies in FIFO order and permits multiple replies", (t) => {
  const { broker, clock } = fixture(t);
  createAndSend(broker, "turn-b", ["WA.first", "WA.second"]);
  const one = broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.1", quotedMessageId: "WA.second", text: "first reply" });
  clock.now += 1;
  const two = broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.2", quotedMessageId: "WA.first", text: "second\nreply" });
  assert.equal(one.status, "queued");
  assert.equal(two.status, "queued");
  const first = broker.claim({ originHost: "regular-mac" });
  assert.equal(first.reply.body, "first reply");
  broker.complete({ originHost: "regular-mac", deliveryId: first.deliveryId });
  const second = broker.claim({ originHost: "regular-mac" });
  assert.equal(second.reply.body, "second\nreply");
});

test("a quoted Server Mac response stays on the Server Mac even though new tasks target the Regular Mac", (t) => {
  const { broker } = fixture(t);
  const created = broker.create({
    originHost: "server-mac",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "turn-server",
    finalText: "Server Mac result",
  });
  broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, messageIds: ["WA.server"] });
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.server", quotedMessageId: "WA.server", text: "continue there" }).status, "queued");
  assert.equal(broker.claim({ originHost: "regular-mac" }).status, "empty");
  const claimed = broker.claim({ originHost: "server-mac" });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.reply.sessionId, "33333333-3333-4333-8333-333333333333");
  assert.equal(claimed.reply.body, "continue there");
});

test("inbound message IDs dedupe without closing the route", (t) => {
  const { broker } = fixture(t);
  createAndSend(broker, "turn-c", ["WA.route"]);
  const payload = { chatId: chat, senderId: sender, messageId: "IN.same", quotedMessageId: "WA.route", text: "once" };
  assert.equal(broker.ingest(payload).status, "queued");
  assert.equal(broker.ingest(payload).status, "duplicate");
  assert.equal(broker.ingest({ ...payload, messageId: "IN.other", text: "again" }).status, "queued");
});

test("a reply earns one private receipt only after its exact Codex delivery is accepted", (t) => {
  const { broker, statePath } = fixture(t);
  createAndSend(broker, "turn-receipt", ["WA.receipt"]);
  const payload = { chatId: chat, senderId: sender, messageId: "IN.receipt", quotedMessageId: "WA.receipt", text: "continue" };
  const queued = broker.ingest(payload);
  assert.equal(queued.reply.receiptStatus, "pending");
  assert.equal(broker.ingest(payload).reply.receiptStatus, "pending");
  const claimed = broker.claim({ originHost: "regular-mac" });
  const accepted = broker.accept({ originHost: "regular-mac", deliveryId: claimed.deliveryId });
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.reaction, { chatId: chat, messageId: "IN.receipt", participant: sender, emoji: "👍" });
  const finished = broker.finishReceipt({ replyId: accepted.reply.id, receiptDeliveryId: accepted.receiptDeliveryId, sent: true });
  assert.equal(finished.status, "sent");
  assert.equal(broker.accept({ originHost: "regular-mac", deliveryId: claimed.deliveryId }).reaction, undefined);
  assert.equal(broker.ingest(payload).reply.receiptStatus, "sent");
  const stored = fs.readFileSync(statePath, "utf8");
  assert.equal(stored.includes("IN.receipt"), false);
});

test("accepted receipt delivery retries idempotently without replaying the Codex turn", (t) => {
  const { broker, clock } = fixture(t);
  assert.equal(broker.ingestNewTask({ chatId: chat, senderId: sender, messageId: "IN.retry-receipt", text: "dispatch" }).status, "queued");
  const claimed = broker.claim({ originHost: "regular-mac" });
  const accepted = broker.accept({ originHost: "regular-mac", deliveryId: claimed.deliveryId });
  assert.equal(broker.finishReceipt({ replyId: accepted.reply.id, receiptDeliveryId: accepted.receiptDeliveryId, sent: false }).status, "failed");
  clock.now += 60_001;
  const retry = broker.retryReceipt({ originHost: "regular-mac" });
  assert.equal(retry.status, "sending-receipt");
  assert.equal(retry.reaction.messageId, "IN.retry-receipt");
  assert.equal(broker.finishReceipt({ replyId: retry.reply.id, receiptDeliveryId: retry.receiptDeliveryId, sent: true }).status, "sent");
  assert.equal(broker.retryReceipt({ originHost: "regular-mac" }).status, "empty");
});

test("completion implies admission while a pre-admission terminal failure earns no receipt", (t) => {
  const { broker, statePath } = fixture(t);
  broker.ingestNewTask({ chatId: chat, senderId: sender, messageId: "IN.completed", text: "complete" });
  const completed = broker.claim({ originHost: "regular-mac" });
  broker.bindTask({ originHost: "regular-mac", replyId: completed.reply.id, deliveryId: completed.deliveryId, sessionId: "22222222-2222-4222-8222-222222222222" });
  broker.complete({ originHost: "regular-mac", deliveryId: completed.deliveryId });
  assert.equal(broker.retryReceipt({ originHost: "regular-mac" }).reaction.messageId, "IN.completed");

  broker.ingestNewTask({ chatId: chat, senderId: sender, messageId: "IN.failed", text: "fail" });
  const failed = broker.claim({ originHost: "regular-mac" });
  broker.fail({ originHost: "regular-mac", deliveryId: failed.deliveryId, reason: "Unavailable" });
  assert.equal(fs.readFileSync(statePath, "utf8").includes("IN.failed"), false);
});

test("authorized image and generic-file attachments stage once, claim privately, and delete on completion", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-bridge-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const attachmentStorePath = path.join(root, "broker", "attachments");
  fs.mkdirSync(cache);
  const image = path.join(cache, "photo.jpg");
  const document = path.join(cache, "invoice.pdf");
  fs.writeFileSync(image, "photo");
  fs.writeFileSync(document, "invoice");
  const broker = new CodexWhatsAppBroker({
    statePath: path.join(root, "broker", "state.json"),
    attachmentStorePath,
    attachmentSourceRoots: [cache],
    allowedSenders: [sender],
    allowedChats: [chat],
    notificationTarget: chat,
    taskInboxTarget: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" },
  });
  const payload = { chatId: chat, senderId: sender, messageId: "IN.files", text: "", attachments: [
    { path: image, name: "photo.jpg", mime: "image/jpeg", kind: "image" },
    { path: document, name: "invoice.pdf", mime: "application/pdf", kind: "file" },
  ] };
  assert.equal(broker.ingestNewTask(payload).status, "queued");
  assert.equal(broker.ingestNewTask(payload).status, "duplicate");
  assert.equal(fs.readdirSync(attachmentStorePath).length, 2);
  const claimed = broker.claim({ originHost: "regular-mac" });
  assert.equal(claimed.reply.body, "");
  assert.deepEqual(claimed.reply.attachments.map(({ kind, mime }) => ({ kind, mime })), [
    { kind: "image", mime: "image/jpeg" },
    { kind: "file", mime: "application/pdf" },
  ]);
  assert.equal(JSON.stringify(claimed).includes(cache), false);
  assert.equal(broker.bindTask({ originHost: "regular-mac", replyId: claimed.reply.id, deliveryId: claimed.deliveryId, sessionId: "22222222-2222-4222-8222-222222222222" }).status, "bound");
  assert.equal(broker.complete({ originHost: "regular-mac", deliveryId: claimed.deliveryId }).status, "completed");
  assert.deepEqual(fs.readdirSync(attachmentStorePath), []);
});

test("unauthorized and unknown-quote attachments fail before any file is staged", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-bridge-file-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const attachmentStorePath = path.join(root, "attachments");
  fs.mkdirSync(cache);
  const source = path.join(cache, "private.txt");
  fs.writeFileSync(source, "private");
  const broker = new CodexWhatsAppBroker({ statePath: path.join(root, "state.json"), attachmentStorePath, attachmentSourceRoots: [cache], allowedSenders: [sender], allowedChats: [chat], taskInboxTarget: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" } });
  const attachment = [{ path: source, name: "private.txt", mime: "text/plain", kind: "file" }];
  assert.equal(broker.ingestNewTask({ chatId: chat, senderId: "other@s.whatsapp.net", messageId: "IN.bad", text: "", attachments: attachment }).status, "ignored");
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.stale-file", quotedMessageId: "WA.unknown", text: "", attachments: attachment }).status, "stale");
  assert.equal(fs.existsSync(attachmentStorePath), false);
});

test("attachment byte staging happens outside the broker lock and cannot overwrite a concurrent route", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-bridge-stage-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "state.json");
  const other = new CodexWhatsAppBroker({ statePath, allowedSenders: [sender], allowedChats: [chat], taskInboxTarget: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" } });
  let concurrentCreated = false;
  const attachmentStore = {
    stage() {
      other.create({ originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId: "turn-during-stage", finalText: "Concurrent result" });
      concurrentCreated = true;
      return [{ storageName: "11111111-1111-4111-8111-111111111111.pdf", displayName: "file.pdf", mime: "application/pdf", kind: "file", size: 1, sha256: "a".repeat(64) }];
    },
    remove() {},
    sweep() {},
  };
  const broker = new CodexWhatsAppBroker({ statePath, allowedSenders: [sender], allowedChats: [chat], taskInboxTarget: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" }, attachmentStore });
  const result = broker.ingestNewTask({ chatId: chat, senderId: sender, messageId: "IN.race", text: "inspect", attachments: [{ path: "/not-used" }] });
  assert.equal(result.status, "queued");
  assert.equal(concurrentCreated, true);
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(stored.routes.some((route) => route.turnId === "turn-during-stage"), true);
  assert.equal(stored.replies.some((reply) => reply.inboundMessageDigest), true);
});

test("a missing configured media cache does not disable text-only broker traffic", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-bridge-missing-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = new CodexWhatsAppBroker({
    statePath: path.join(root, "state.json"),
    attachmentSourceRoots: [path.join(root, "not-created")],
    allowedSenders: [sender],
    allowedChats: [chat],
    notificationTarget: chat,
  });
  assert.equal(broker.create({ originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId: "turn-text", finalText: "text" }).status, "sending");
  assert.equal(broker.status({ originHost: "regular-mac" }).ok, true);
});

test("new-task ingestion is exact, deduplicated, bindable, and FIFO", (t) => {
  const { broker, clock } = fixture(t);
  const payload = { chatId: chat, senderId: sender, messageId: "IN.new-1", text: " exact new-task body\n" };
  assert.equal(broker.inboxTarget().status, "configured");
  assert.equal(broker.ingestNewTask(payload).status, "queued");
  assert.equal(broker.ingestNewTask(payload).status, "duplicate");
  clock.now += 1;
  assert.equal(broker.ingestNewTask({ ...payload, messageId: "IN.new-2", text: "second" }).status, "queued");
  const first = broker.claim({ originHost: "regular-mac" });
  assert.equal(first.reply.kind, "new-task");
  assert.equal(first.reply.body, " exact new-task body\n");
  assert.equal(broker.bindTask({ originHost: "regular-mac", replyId: first.reply.id, deliveryId: first.deliveryId, sessionId: "22222222-2222-4222-8222-222222222222" }).status, "bound");
  broker.complete({ originHost: "regular-mac", deliveryId: first.deliveryId });
  assert.equal(broker.claim({ originHost: "regular-mac" }).reply.body, "second");
});

test("an unconfigured task inbox fails visibly without queuing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-bridge-unconfigured-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = new CodexWhatsAppBroker({ statePath: path.join(root, "state.json"), allowedSenders: [sender], allowedChats: [chat] });
  const result = broker.ingestNewTask({ chatId: chat, senderId: sender, messageId: "IN.unconfigured", text: "work" });
  assert.equal(result.status, "unavailable");
  assert.match(result.acknowledgement, /task inbox/i);
  assert.equal(broker.status({ originHost: "regular-mac" }).replies.length, 0);
});

test("authorization and quoted route lookup fail closed while exact bodies are accepted", (t) => {
  const { broker } = fixture(t);
  createAndSend(broker, "turn-d", ["WA.safe"]);
  const base = { chatId: chat, senderId: sender, messageId: "IN.safe", quotedMessageId: "WA.safe", text: "ok" };
  assert.equal(broker.ingest({ ...base, senderId: "15550000002@s.whatsapp.net" }).status, "ignored");
  assert.equal(broker.ingest({ ...base, chatId: "120363999999999999@g.us" }).status, "ignored");
  assert.equal(broker.ingest({ ...base, quotedMessageId: "WA.unknown" }).status, "stale");
  assert.equal(broker.ingest({ ...base, text: "password: swordfish" }).status, "queued");
  assert.equal(broker.ingest({ ...base, text: "" }).status, "ignored");
});

test("completion deletes reply bodies and is idempotent", (t) => {
  const { broker, statePath } = fixture(t);
  createAndSend(broker, "turn-e", ["WA.complete"]);
  broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.complete", quotedMessageId: "WA.complete", text: "do it" });
  const claimed = broker.claim({ originHost: "regular-mac" });
  assert.equal(broker.complete({ originHost: "regular-mac", deliveryId: claimed.deliveryId }).status, "completed");
  assert.equal(broker.complete({ originHost: "regular-mac", deliveryId: claimed.deliveryId }).status, "completed");
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8")).replies[0];
  assert.equal(stored.body, undefined);
  assert.equal(stored.delivery, undefined);
});

test("failed delivery releases explicitly and claimed deliveries never auto-replay", (t) => {
  const { broker, clock } = fixture(t);
  createAndSend(broker, "turn-f", ["WA.release"]);
  broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.release", quotedMessageId: "WA.release", text: "retry me" });
  const claimed = broker.claim({ originHost: "regular-mac" });
  clock.now += 10 * 60 * 1_000;
  assert.equal(broker.claim({ originHost: "regular-mac" }).status, "empty");
  assert.equal(broker.release({ originHost: "regular-mac", deliveryId: claimed.deliveryId }).status, "released");
  assert.equal(broker.claim({ originHost: "regular-mac" }).status, "claimed");
});

test("a crashed claim recovers only after the bounded resume window", (t) => {
  const { broker, clock } = fixture(t);
  createAndSend(broker, "turn-crash", ["WA.crash"]);
  broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.crash", quotedMessageId: "WA.crash", text: "recover me" });
  broker.claim({ originHost: "regular-mac" });
  clock.now += 84 * 60 * 1_000;
  assert.equal(broker.claim({ originHost: "regular-mac" }).status, "empty");
  clock.now += 2 * 60 * 1_000;
  assert.equal(broker.claim({ originHost: "regular-mac" }).status, "claimed");
});

test("unavailable-task notices retry durably after a confirmed transport failure", (t) => {
  const { broker, clock } = fixture(t);
  broker.ingestNewTask({ chatId: chat, senderId: sender, messageId: "IN.fail-notice", text: "dispatch" });
  const claimed = broker.claim({ originHost: "regular-mac" });
  const failed = broker.fail({ originHost: "regular-mac", deliveryId: claimed.deliveryId, reason: "The Codex task needs attention in Codex." });
  assert.equal(failed.reply.failureNotificationStatus, "sending");
  assert.equal(broker.finishFailureNotification({ replyId: failed.reply.id, notificationDeliveryId: failed.notificationDeliveryId, sent: false }).status, "failed");
  clock.now += 60_001;
  const retry = broker.retryFailureNotification({ originHost: "regular-mac" });
  assert.equal(retry.status, "sending-failure");
  assert.equal(retry.notification.text, "The Codex task needs attention in Codex.");
  assert.equal(broker.finishFailureNotification({ replyId: retry.reply.id, notificationDeliveryId: retry.notificationDeliveryId, sent: true }).status, "sent");
});

test("routes and replies expire after thirty days", (t) => {
  const { broker, clock } = fixture(t);
  createAndSend(broker, "turn-g", ["WA.expire"]);
  broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.expire", quotedMessageId: "WA.expire", text: "later" });
  clock.now += 31 * 24 * 60 * 60 * 1_000;
  const status = broker.status({ originHost: "regular-mac" });
  assert.deepEqual(status.routes, []);
  assert.deepEqual(status.replies, []);
});

test("unconfirmed sends retain text for bounded retry then discard it", (t) => {
  const { broker, clock, statePath } = fixture(t);
  const created = broker.create({ originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId: "turn-h", finalText: "retry payload" });
  let result = broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: false, messageIds: [] });
  assert.equal(result.status, "notification-failed");
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    clock.now += 60_001;
    const retried = broker.retryNotification({ originHost: "regular-mac" });
    result = broker.finishNotification({ routeId: retried.route.id, notificationDeliveryId: retried.notificationDeliveryId, sent: false, messageIds: [] });
  }
  assert.equal(result.status, "notification-exhausted");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).routes[0].finalText, undefined);
});

test("transport-uncertain sends are never retried or routed", (t) => {
  const { broker, clock, statePath } = fixture(t);
  const created = broker.create({ originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId: "turn-uncertain", finalText: "possibly delivered" });
  const result = broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: false, messageIds: [], uncertain: true });
  assert.equal(result.status, "notification-exhausted");
  clock.now += 60_001;
  assert.equal(broker.retryNotification({ originHost: "regular-mac" }).status, "empty");
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8")).routes[0];
  assert.equal(stored.finalText, undefined);
  assert.equal(stored.messageDigests, undefined);
});

test("an expired in-flight send is treated as uncertain and discarded", (t) => {
  const { broker, clock, statePath } = fixture(t);
  broker.create({ originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId: "turn-crash", finalText: "possibly delivered before crash" });
  clock.now += 16 * 60_000 + 1;
  assert.equal(broker.retryNotification({ originHost: "regular-mac" }).status, "empty");
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8")).routes[0];
  assert.equal(stored.notification.status, "exhausted");
  assert.equal(stored.finalText, undefined);
});

test("status never exposes final or reply bodies", (t) => {
  const { broker } = fixture(t);
  createAndSend(broker, "turn-i", ["WA.status"]);
  broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.status", quotedMessageId: "WA.status", text: "private body" });
  assert.equal(JSON.stringify(broker.status({ originHost: "regular-mac" })).includes("private body"), false);
});

test("store rejects incompatible legacy state", (t) => {
  const { statePath } = fixture(t);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, requests: [] }));
  assert.throws(() => new CodexApprovalStore(statePath).load(), /invalid/);
});

test("pre-cutover state is rejected instead of retaining legacy behavior", (t) => {
  const { broker, statePath } = fixture(t);
  createAndSend(broker, "turn-migrate", ["WA.migrate"]);
  broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.migrate", quotedMessageId: "WA.migrate", text: "preserve me" });
  const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const legacy = { schemaVersion: 2, routes: current.routes, replies: current.replies.map(({ kind, sequence, ...reply }) => reply) };
  fs.writeFileSync(statePath, JSON.stringify(legacy));
  assert.throws(() => new CodexApprovalStore(statePath).load(), /invalid/);
});

test("WhatsApp sender requires all confirmed chunk IDs", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, async json() { return { messageId: "WA.2", messageIds: ["WA.1", "WA.2"] }; } };
  };
  const sent = await sendWhatsAppNotification({ target: chat, text: "full final", deliveryKey: "11111111-1111-4111-8111-111111111111" }, { bridgeUrl: "http://127.0.0.1:4567", fetchImpl });
  assert.deepEqual(sent.messageIds, ["WA.1", "WA.2"]);
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:4567/send", body: { chatId: chat, message: "full final", deliveryKey: "11111111-1111-4111-8111-111111111111", deliveryOffset: 0 } }]);
  await assert.rejects(
    () => sendWhatsAppNotification({ target: chat, text: "x", deliveryKey: "11111111-1111-4111-8111-111111111111" }, { bridgeUrl: "http://127.0.0.1:4567", fetchImpl: async () => ({ ok: true, async json() { return {}; } }) }),
    (error) => error.deliveryUncertain === true && /message IDs/.test(error.message),
  );
});

test("WhatsApp reactions use the loopback bridge and require explicit confirmation", async () => {
  const calls = [];
  const sent = await sendWhatsAppReaction(
    { chatId: chat, messageId: "IN.react", participant: sender, emoji: "👍" },
    {
      bridgeUrl: "http://127.0.0.1:4567/send",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) });
        return { ok: true, async json() { return { success: true }; } };
      },
    },
  );
  assert.equal(sent.status, "sent");
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:4567/react", body: { chatId: chat, messageId: "IN.react", emoji: "👍", participant: sender } }]);
  await assert.rejects(
    () => sendWhatsAppReaction({ chatId: chat, messageId: "IN.react", participant: sender, emoji: "👍" }, { bridgeUrl: "http://127.0.0.1:4567", fetchImpl: async () => ({ ok: true, async json() { return {}; } }) }),
    /confirm/,
  );
});

test("WhatsApp sender preserves work-log then final message boundaries", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, async json() { return { messageId: "WA.final", messageIds: ["WA.log", "WA.final"], messageIdGroups: [["WA.log"], ["WA.final"]] }; } };
  };
  const sent = await sendWhatsAppNotification({
    target: chat,
    messages: ["labeled work log", "labeled final"],
    deliveryKey: "11111111-1111-4111-8111-111111111111",
    deliveryOffset: 0,
  }, { bridgeUrl: "http://127.0.0.1:4567", fetchImpl });
  assert.deepEqual(sent.messageIds, ["WA.log", "WA.final"]);
  assert.deepEqual(calls[0].body, {
    chatId: chat,
    messages: ["labeled work log", "labeled final"],
    deliveryKey: "11111111-1111-4111-8111-111111111111",
    deliveryOffset: 0,
  });
});

test("a confirmed work log is not resent when the final message is retryable", async () => {
  await assert.rejects(
    () => sendWhatsAppNotification({
      target: chat,
      messages: ["labeled work log", "labeled final"],
      deliveryKey: "11111111-1111-4111-8111-111111111111",
    }, {
      bridgeUrl: "http://127.0.0.1:4567",
      fetchImpl: async () => ({
        ok: false,
        async json() {
          return {
            error: "final rejected",
            messageIds: ["WA.log"],
            messageIdGroups: [["WA.log"], []],
            failedMessageIndex: 1,
            failedUncertain: false,
          };
        },
      }),
    }),
    (error) => error.deliveryUncertain !== true && error.activityMessageIds?.[0] === "WA.log",
  );
});

test("broker retains only the failed final after a confirmed work log", async (t) => {
  const { broker, clock } = fixture(t);
  const created = broker.create({
    originHost: "regular-mac",
    sessionId: "11111111-1111-4111-8111-111111111111",
    turnId: "turn-retry-final",
    activityText: "work log",
    finalText: "final answer",
  });
  const failed = broker.finishNotification({
    routeId: created.route.id,
    notificationDeliveryId: created.notificationDeliveryId,
    sent: false,
    activityMessageIds: ["WA.log"],
  });
  assert.equal(failed.status, "notification-failed");
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.log", quotedMessageId: "WA.log", text: "continue" }).status, "queued");
  clock.now += 60_001;
  const retry = broker.retryNotification({ originHost: "regular-mac" });
  assert.deepEqual(retry.notification.messages, ["final answer"]);
  assert.equal(retry.notification.deliveryOffset, 1);
  const calls = [];
  await sendWhatsAppNotification(retry.notification, {
    bridgeUrl: "http://127.0.0.1:4567",
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, async json() { return { messageId: "WA.final", messageIds: ["WA.final"], messageIdGroups: [["WA.final"]] }; } };
    },
  });
  assert.equal(calls[0].deliveryOffset, 1);
  const sent = broker.finishNotification({ routeId: retry.route.id, notificationDeliveryId: retry.notificationDeliveryId, sent: true, messageIds: ["WA.final"] });
  assert.equal(sent.status, "sent");
  assert.equal(sent.route.messageCount, 2);
});

test("WhatsApp sender preserves confirmed IDs from a partial bridge failure", async () => {
  const sent = await sendWhatsAppNotification(
    { target: chat, text: "long final", deliveryKey: "11111111-1111-4111-8111-111111111111" },
    {
      bridgeUrl: "http://127.0.0.1:4567",
      fetchImpl: async () => ({ ok: false, async json() { return { error: "later chunk failed", messageIds: ["WA.partial-1"] }; } }),
    },
  );
  assert.deepEqual(sent, { ok: true, status: "partial", messageIds: ["WA.partial-1"] });
});

test("broker stdin accepts the worst escaped legal final envelope", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-envelope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/codex-whatsapp-broker.mjs"), "status"],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      input: `${JSON.stringify({ originHost: "regular-mac", padding: "\\\"".repeat(24_000) })}\n`,
      env: { ...process.env, CODEX_WHATSAPP_STATE: path.join(root, "state.json") },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("admission status reconciles a broker timeout without exposing message content", (t) => {
  const { broker } = fixture(t);
  assert.equal(broker.admissionStatus({ chatId: chat, senderId: sender, messageId: "IN.reconcile" }).status, "not-found");
  assert.equal(broker.ingestNewTask({ chatId: chat, senderId: sender, messageId: "IN.reconcile", text: "private text" }).status, "queued");
  const status = broker.admissionStatus({ chatId: chat, senderId: sender, messageId: "IN.reconcile" });
  assert.deepEqual(status, { ok: true, status: "accepted" });
  assert.equal(JSON.stringify(status).includes("private text"), false);
});

test("WhatsApp sender permits loopback only", async () => {
  await assert.rejects(() => sendWhatsAppNotification({ target: chat, text: "x", deliveryKey: "11111111-1111-4111-8111-111111111111" }, { bridgeUrl: "https://example.com" }), /loopback/);
});

test("partial notification state remains visible and its attempted chunks route", (t) => {
  const { broker } = fixture(t);
  const created = broker.create({ originHost: "regular-mac", sessionId: "11111111-1111-4111-8111-111111111111", turnId: "turn-partial", finalText: "chunk one and chunk two" });
  const finished = broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, partial: true, messageIds: ["CODEX0123456789ABCDEFGHIJ"] });
  assert.equal(finished.status, "partial");
  assert.equal(finished.route.notificationStatus, "partial");
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.partial", quotedMessageId: "CODEX0123456789ABCDEFGHIJ", text: "continue" }).status, "queued");
});
