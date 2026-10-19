import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexApprovalStore, CodexWhatsAppBroker } from "../scripts/lib/bridge-state.mjs";

const sender = "15550000001@s.whatsapp.net";
const otherSender = "15550000002@s.whatsapp.net";
const chat = "120363000000000001@g.us";
const sourceSession = "11111111-1111-4111-8111-111111111111";
const predictionSession = "22222222-2222-4222-8222-222222222222";

// Contract: a prediction stays bound to its exact source record and may be accepted only once.
// Regression: revision freshness checks or ordinary quote routing could reject the original target or consume a vote/quote race twice.
// Keeper: existing bridge-state tests cover ordinary quotes and FIFO; this adds the distinct durable suggestion-consumption boundary.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suggestion-broker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "private", "state.json");
  const clock = { now: Date.UTC(2026, 9, 18) };
  const options = { statePath, allowedSenders: [sender], allowedChats: [chat], notificationTarget: chat, now: () => clock.now };
  const broker = new CodexWhatsAppBroker(options);
  const source = (turnId, createdAt = undefined) => broker.create({ originHost: "regular-mac", sessionId: sourceSession, turnId, finalText: `Source ${turnId}`, ...(createdAt === undefined ? {} : { createdAt }) });
  // Characterize pre-upgrade routes after they have already been persisted; the new
  // compact layout has separate coverage below.
  const legacySuggestion = (input) => {
    const result = broker.createSuggestion(input);
    if (!result.created) return result;
    const state = broker.store.load();
    const route = state.routes.find((item) => item.id === result.route.id);
    delete route.suggestionLayout;
    const prefix = "Codex composer suggestion\n\nReply to this message to send the exact suggestion with your additions appended, or choose Send suggestion or Dismiss in the poll below.\n\n";
    const preview = route.suggestionText.length > 900 ? `${route.suggestionText.slice(0, 900)}… [preview truncated]` : route.suggestionText;
    route.suggestionPollContext = `Codex composer suggestion preview:\n${preview}\n\nQuoting the suggestion message sends the exact suggestion with your added text.`;
    route.finalText = `${prefix}${route.suggestionText}`;
    route.notification = { status: "sending", deliveryId: crypto.randomUUID(), claimedAt: clock.now, leaseExpiresAt: clock.now + 16 * 60_000, attempts: 1 };
    route.suggestionPoll = { status: "ready", attempts: 0 };
    broker.store.save(state);
    return { ...result, status: "sending", phase: "notification", notificationDeliveryId: route.notification.deliveryId,
      notification: { target: chat, messages: [route.finalText], deliveryKey: route.id, deliveryOffset: 0 } };
  };
  const suggest = (turnId, suggestionText = "  exact suggestion\n") => legacySuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId, predictionSessionId: predictionSession, predictionTurnId: `prediction-${turnId}`, suggestionText });
  const sent = (result, ids) => broker.finishNotification({ routeId: result.route.id, notificationDeliveryId: result.notificationDeliveryId, sent: true, messageIds: ids });
  const pollReady = (result, messageId = "WA.poll") => {
    const suggestionText = broker.store.load().routes.find((route) => route.id === result.route.id).suggestionText;
    const reserved = broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId: result.route.turnId, predictionSessionId: predictionSession, predictionTurnId: `prediction-${result.route.turnId}`, suggestionText });
    assert.equal(reserved.phase, "poll");
    broker.beginSuggestionPoll({ routeId: reserved.route.id, pollDeliveryId: reserved.pollDeliveryId });
    assert.equal(broker.finishSuggestionPoll({ routeId: reserved.route.id, pollDeliveryId: reserved.pollDeliveryId, sent: true, pollMessageId: messageId, messageIds: ["WA.poll-context", messageId] }).status, "sent");
    return reserved.route.id;
  };
  return { broker, options, statePath, clock, source, suggest, legacySuggestion, sent, pollReady };
}

test("suggestion prompt and independent notification/poll phases survive restart with exact IDs and text", (t) => {
  const { broker, options, statePath, source, suggest, sent, pollReady } = fixture(t);
  const prompt = " exact suggestion\n";
  source("turn-1");
  const created = suggest("turn-1", prompt);
  assert.equal(created.phase, "notification");
  assert.ok(created.notification.messages[0].startsWith("Codex composer suggestion\n\n"));
  assert.ok(created.notification.messages[0].includes("choose Send suggestion or Dismiss"));
  assert.ok(created.notification.messages[0].endsWith(prompt));
  assert.equal(created.notification.deliveryKey, created.route.id);
  broker.beginNotificationDelivery({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId });
  assert.equal(sent(created, ["WA.suggestion-1", "WA.suggestion-2"]).status, "sent");
  const pollRouteId = pollReady(created);
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(stored.schemaVersion, 4);
  const storedSuggestion = stored.routes.find((route) => route.kind === "suggestion");
  assert.equal(storedSuggestion.suggestionText, prompt);
  assert.equal(storedSuggestion.suggestionMessageDigests.length, 2);
  assert.equal(storedSuggestion.suggestionPoll.status, "sent");
  assert.equal(storedSuggestion.suggestionPoll.messageIdDigest.length, 64);
  const restarted = new CodexWhatsAppBroker(options);
  const quote = restarted.ingest({ chatId: chat, senderId: sender, messageId: "IN.quote", quotedMessageId: "WA.suggestion-2", text: "please add this" });
  assert.equal(quote.status, "queued");
  const claimed = restarted.claim({ originHost: "regular-mac" });
  assert.equal(claimed.reply.body, `${prompt}\n\nplease add this`);
  assert.equal(claimed.reply.expectedSourceTurnId, undefined);
  assert.equal(pollRouteId, created.route.id);
});

test("suggestion poll previews bounded content while stored and quoted suggestion text stays exact", (t) => {
  const { broker, source, suggest, sent } = fixture(t);
  source("turn-preview");
  const exactText = "Distinctive opening.\n" + "suggestion body ".repeat(100);
  const created = suggest("turn-preview", exactText);
  broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, messageIds: ["WA.suggestion"] });
  const poll = broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-preview", predictionSessionId: predictionSession, predictionTurnId: "prediction-turn-preview", suggestionText: exactText });
  assert.equal(poll.phase, "poll");
  assert.ok(poll.poll.context.includes("Distinctive opening."));
  assert.ok(poll.poll.context.includes("[preview truncated]"));
  assert.ok(poll.poll.context.length <= 1_200);
  assert.equal(broker.store.load().routes.find((route) => route.id === created.route.id).suggestionText, exactText);
  assert.equal(created.notification.messages[0].endsWith(exactText), true);
});

test("existing suggestion routes keep their original poll context across upgrade", (t) => {
  const { broker, options, source, suggest } = fixture(t);
  source("turn-legacy-context");
  const created = suggest("turn-legacy-context", "legacy exact suggestion");
  broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, messageIds: ["WA.legacy-suggestion"] });
  const state = broker.store.load();
  delete state.routes.find((route) => route.id === created.route.id).suggestionPollContext;
  broker.store.save(state);
  const upgraded = new CodexWhatsAppBroker(options);
  const poll = upgraded.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-legacy-context", predictionSessionId: predictionSession, predictionTurnId: "prediction-turn-legacy-context", suggestionText: "legacy exact suggestion" });
  assert.equal(poll.poll.context, "Codex composer suggestion. Quoting the suggestion message sends it with your added text.");
});

test("source turns are scoped to the original Codex session inside one shared WhatsApp group", (t) => {
  const { broker, options, legacySuggestion } = fixture(t);
  const otherSession = "33333333-3333-4333-8333-333333333333";
  const firstSource = broker.create({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-chat-a", finalText: "A" });
  const secondSource = broker.create({ originHost: "regular-mac", sessionId: otherSession, turnId: "turn-chat-b", finalText: "B" });
  const mkSuggestion = (sessionId, turnId, predictionTurnId, suggestionText) => legacySuggestion({ originHost: "regular-mac", sessionId, turnId, predictionSessionId: predictionSession, predictionTurnId, suggestionText });
  const first = mkSuggestion(sourceSession, firstSource.route.turnId, "prediction-a", "suggestion A");
  const second = mkSuggestion(otherSession, secondSource.route.turnId, "prediction-b", "suggestion B");
  assert.equal(first.status, "sending");
  assert.equal(second.status, "sending");
  assert.equal(mkSuggestion(sourceSession, firstSource.route.turnId, "prediction-a", "changed text").status, "prediction-conflict");
  for (const [suggestion, notifyId, messageId, voteId] of [[first, "WA.suggestion-a", "WA.poll-a", "IN.vote-a"], [second, "WA.suggestion-b", "WA.poll-b", "IN.vote-b"]]) {
    broker.beginNotificationDelivery({ routeId: suggestion.route.id, notificationDeliveryId: suggestion.notificationDeliveryId });
    broker.finishNotification({ routeId: suggestion.route.id, notificationDeliveryId: suggestion.notificationDeliveryId, sent: true, messageIds: [notifyId] });
    const poll = mkSuggestion(suggestion.route.sessionId, suggestion.route.turnId, suggestion.route.id === first.route.id ? "prediction-a" : "prediction-b", suggestion.route.id === first.route.id ? "suggestion A" : "suggestion B");
    assert.equal(poll.phase, "poll");
    broker.beginSuggestionPoll({ routeId: poll.route.id, pollDeliveryId: poll.pollDeliveryId });
    broker.finishSuggestionPoll({ routeId: poll.route.id, pollDeliveryId: poll.pollDeliveryId, sent: true, pollMessageId: messageId, messageIds: [messageId] });
    assert.equal(broker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: voteId, pollMessageId: messageId, selectedOptions: ["Send suggestion"] }).status, "queued");
  }
  const claims = new Set();
  for (let i = 0; i < 2; i += 1) claims.add(broker.claim({ originHost: "regular-mac" }).reply.sessionId);
  assert.deepEqual(claims, new Set([sourceSession, otherSession]));
  assert.equal(new CodexWhatsAppBroker(options).status({ originHost: "regular-mac" }).ok, true);
});

test("vote and quote consume one suggestion atomically, and unknown or unauthorized polls are ignored", (t) => {
  const { broker, options, source, suggest, sent, pollReady } = fixture(t);
  const concurrentBroker = new CodexWhatsAppBroker(options);
  source("turn-race");
  const created = suggest("turn-race", "suggested body");
  broker.beginNotificationDelivery({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId });
  sent(created, ["WA.suggestion"]);
  pollReady(created);
  assert.equal(broker.suggestionPollVote({ chatId: chat, senderId: otherSender, messageId: "IN.unauth", pollMessageId: "WA.poll", selectedOptions: ["Send suggestion"] }).status, "ignored");
  assert.equal(broker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: "IN.unknown", pollMessageId: "WA.unknown", selectedOptions: ["Send suggestion"] }).status, "ignored");
  const vote = concurrentBroker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: "IN.vote", pollMessageId: "WA.poll", selectedOptions: ["Send suggestion"] });
  assert.equal(vote.status, "queued");
  assert.equal(concurrentBroker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: "IN.vote", pollMessageId: "WA.poll", selectedOptions: ["Send suggestion"] }).status, "duplicate");
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.quote-race", quotedMessageId: "WA.suggestion", text: "extra" }).status, "stale");
  assert.equal(broker.claim({ originHost: "regular-mac" }).reply.body, "suggested body");
});

test("quote wins the same one-time race and preserves attachments through suggestion append", (t) => {
  const { broker, options, source, suggest, sent, pollReady } = fixture(t);
  const concurrentBroker = new CodexWhatsAppBroker(options);
  source("turn-quote-wins");
  const created = suggest("turn-quote-wins", "exact\n suggestion ");
  broker.beginNotificationDelivery({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId });
  sent(created, ["WA.suggestion"]);
  pollReady(created);
  const attachmentStore = broker.attachmentStore;
  const originalStage = attachmentStore.stage.bind(attachmentStore);
  attachmentStore.stage = () => [{ storageName: "11111111-1111-4111-8111-111111111111.pdf", displayName: "a.pdf", mime: "application/pdf", kind: "file", size: 1, sha256: "a".repeat(64) }];
  t.after(() => { attachmentStore.stage = originalStage; });
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.quote-first", quotedMessageId: "WA.suggestion", text: " add-on ", attachments: [{ path: "/not-opened" }] }).status, "queued");
  assert.equal(concurrentBroker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: "IN.vote-late", pollMessageId: "WA.poll", selectedOptions: ["Send suggestion"] }).status, "ignored");
  const claimed = broker.claim({ originHost: "regular-mac" });
  assert.equal(claimed.reply.body, "exact\n suggestion \n\n add-on ");
  assert.equal(claimed.reply.attachments[0].displayName, "a.pdf");
});

test("older suggestions retain exact source routing across newer turns while claims remain recoverable", (t) => {
  const { broker, source, suggest, legacySuggestion, sent, statePath, clock } = fixture(t);
  assert.equal(suggest("no-source-record", "must not infer a source").status, "stale-source");
  source("turn-old");
  const old = suggest("turn-old", "old prompt");
  broker.beginNotificationDelivery({ routeId: old.route.id, notificationDeliveryId: old.notificationDeliveryId });
  assert.equal(broker.finishNotification({ routeId: old.route.id, notificationDeliveryId: old.notificationDeliveryId, sent: false }).status, "notification-failed");
  const sourceCreatedAt = Date.UTC(2026, 9, 18) + 2;
  source("turn-new", sourceCreatedAt);
  source("turn-delayed-older", sourceCreatedAt - 1);
  clock.now += 60_000;
  const retried = broker.retryNotification({ originHost: "regular-mac" });
  assert.equal(retried.status, "sending-suggestion");
  assert.equal(retried.route.turnId, "turn-old");
  broker.beginNotificationDelivery({ routeId: retried.route.id, notificationDeliveryId: retried.notificationDeliveryId });
  sent(retried, ["WA.old-suggestion"]);
  const retriedPoll = broker.retryNotification({ originHost: "regular-mac" });
  assert.equal(retriedPoll.status, "sending-suggestion-poll");
  assert.equal(retriedPoll.route.turnId, "turn-old");
  broker.beginSuggestionPoll({ routeId: retriedPoll.route.id, pollDeliveryId: retriedPoll.pollDeliveryId });
  broker.finishSuggestionPoll({ routeId: retriedPoll.route.id, pollDeliveryId: retriedPoll.pollDeliveryId, sent: true, pollMessageId: "WA.old-poll", messageIds: ["WA.old-poll"] });
  const late = legacySuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-old", predictionSessionId: predictionSession, predictionTurnId: "prediction-turn-old-late", suggestionText: "late old prompt" });
  assert.equal(late.status, "sending");
  broker.beginNotificationDelivery({ routeId: late.route.id, notificationDeliveryId: late.notificationDeliveryId });
  sent(late, ["WA.late-old-suggestion"]);
  assert.equal(suggest("turn-new", "new prompt").status, "sending");
  const newerNotification = broker.store.load().routes.find((route) => route.kind === "suggestion" && route.turnId === "turn-new");
  assert.equal(newerNotification.finalText.endsWith("new prompt"), true);
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.old-quote", quotedMessageId: "WA.late-old-suggestion", text: "append old" }).status, "queued");
  assert.equal(broker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: "IN.old-vote", pollMessageId: "WA.old-poll", selectedOptions: ["Send suggestion"] }).status, "queued");
  assert.equal(broker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: "IN.old-vote-again", pollMessageId: "WA.old-poll", selectedOptions: ["Send suggestion"] }).status, "ignored");
  const firstClaim = broker.claim({ originHost: "regular-mac" });
  assert.equal(firstClaim.status, "claimed");
  assert.equal(firstClaim.reply.body, "late old prompt\n\nappend old");
  assert.equal(firstClaim.reply.sessionId, sourceSession);
  assert.equal(firstClaim.reply.turnId, "turn-old");
  assert.equal(firstClaim.reply.expectedSourceTurnId, undefined);
  assert.equal(broker.accept({ originHost: "regular-mac", deliveryId: firstClaim.deliveryId }).status, "accepted");
  assert.equal(broker.release({ originHost: "regular-mac", deliveryId: firstClaim.deliveryId }).status, "released");
  const recovered = broker.claim({ originHost: "regular-mac" });
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.reply.body, "late old prompt\n\nappend old");
  assert.equal(recovered.reply.sessionId, sourceSession);
  assert.equal(recovered.reply.turnId, "turn-old");
  assert.equal(recovered.reply.expectedSourceTurnId, undefined);
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.replies.some((reply) => Object.hasOwn(reply, "expectedSourceTurnId")), false);
  assert.equal(persisted.replies.find((reply) => reply.id === recovered.reply.id).acceptedAt, clock.now);
  assert.equal(broker.complete({ originHost: "regular-mac", deliveryId: recovered.deliveryId }).status, "completed");
  const approved = broker.claim({ originHost: "regular-mac" });
  assert.equal(approved.status, "claimed");
  assert.equal(approved.reply.body, "old prompt");
  assert.equal(approved.reply.sessionId, sourceSession);
  assert.equal(approved.reply.turnId, "turn-old");
  assert.equal(approved.reply.expectedSourceTurnId, undefined);
});

test("dismiss consumes without a reply and schema 4 stays stable without latest-source metadata", (t) => {
  const { broker, statePath, source, suggest, sent, pollReady } = fixture(t);
  source("turn-dismiss");
  const dismissed = suggest("turn-dismiss", "discard this");
  broker.beginNotificationDelivery({ routeId: dismissed.route.id, notificationDeliveryId: dismissed.notificationDeliveryId });
  sent(dismissed, ["WA.dismiss"]);
  pollReady(dismissed, "WA.dismiss-poll");
  assert.equal(broker.suggestionPollVote({ chatId: chat, senderId: sender, messageId: "IN.dismiss", pollMessageId: "WA.dismiss-poll", selectedOptions: ["Dismiss"] }).status, "dismissed");
  assert.equal(broker.claim({ originHost: "regular-mac" }).status, "empty");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const digestId = "routine-digest-global-2026-10-18";
  state.routes.push({ id: digestId, originHost: "gateway", sessionId: "routine-2026-10-18", turnId: digestId,
    createdAt: Date.UTC(2026, 9, 18), expiresAt: Date.UTC(2026, 10, 17), notification: { status: "sent", attempts: 1, sentAt: Date.UTC(2026, 9, 18) },
    messageDigests: ["a".repeat(64)], informational: true, digestDate: "2026-10-18", digestIdentity: digestId, digestItems: [] });
  state.schemaVersion = 4;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const loaded = new CodexApprovalStore(statePath).load();
  assert.equal(loaded.schemaVersion, 4);
  assert.equal(Object.hasOwn(loaded, "sourceTurns"), false);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).schemaVersion, 4);
});

test("uncertain native poll retries reuse stable delivery keys without crossing phases", (t) => {
  const { broker, source, suggest, statePath } = fixture(t);
  source("turn-retry");
  const created = suggest("turn-retry", "retry exact body");
  broker.beginNotificationDelivery({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId });
  broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, messageIds: ["WA.retry"] });
  const poll = suggest("turn-retry", "retry exact body");
  assert.equal(poll.phase, "poll");
  assert.equal(poll.poll.deliveryKey, created.route.id);
  broker.beginSuggestionPoll({ routeId: poll.route.id, pollDeliveryId: poll.pollDeliveryId });
  assert.equal(broker.finishSuggestionPoll({ routeId: poll.route.id, pollDeliveryId: poll.pollDeliveryId, sent: false, uncertain: true }).status, "uncertain");
  const retryPoll = suggest("turn-retry", "retry exact body");
  assert.equal(retryPoll.phase, "poll");
  assert.equal(retryPoll.poll.deliveryKey, created.route.id);
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const route = stored.routes.find((item) => item.kind === "suggestion");
  assert.equal(route.notification.status, "sent");
  assert.equal(route.suggestionPoll.status, "sending");
});

test("partially delivered suggestion notifications cannot accept quoted replies", (t) => {
  const { broker, source, suggest } = fixture(t);
  source("turn-partial");
  const created = suggest("turn-partial", "partially delivered prompt");
  broker.beginNotificationDelivery({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId });
  assert.equal(broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId, sent: true, partial: true, messageIds: ["WA.partial"] }).status, "partial");
  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.partial-quote", quotedMessageId: "WA.partial", text: "reply" }).status, "stale");
  assert.equal(broker.claim({ originHost: "regular-mac" }).status, "empty");
});

test("ready failure notices are retried after broker restart", (t) => {
  const { broker, options, statePath, clock, source, sent } = fixture(t);
  const route = source("turn-ready-failure");
  sent(route, ["WA.ready-failure"]);
  broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.ready-failure", quotedMessageId: "WA.ready-failure", text: "dispatch" });
  const claimed = broker.claim({ originHost: "regular-mac" });
  const failed = broker.fail({ originHost: "regular-mac", deliveryId: claimed.deliveryId, reason: "The Codex task needs attention in Codex." });
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  persisted.replies.find((reply) => reply.id === failed.reply.id).failureNotification = { status: "ready", attempts: 0 };
  fs.writeFileSync(statePath, JSON.stringify(persisted));
  clock.now += 1;
  const restarted = new CodexWhatsAppBroker(options);
  const retry = restarted.retryFailureNotification({ originHost: "regular-mac" });
  assert.equal(retry.status, "sending-failure");
  assert.equal(retry.notification.text, "The Codex task needs attention in Codex.");
  assert.equal(restarted.finishFailureNotification({ replyId: retry.reply.id, notificationDeliveryId: retry.notificationDeliveryId, sent: true }).status, "sent");
});

test("a crash after notification send intent becomes uncertain and never resends the full prompt", (t) => {
  const { broker, clock, source, suggest, statePath } = fixture(t);
  source("turn-crash");
  const created = suggest("turn-crash", "possibly already sent");
  broker.beginNotificationDelivery({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId });
  clock.now += 17 * 60 * 1000;
  const recovered = suggest("turn-crash", "possibly already sent");
  assert.equal(recovered.status, "notification-uncertain");
  assert.equal(recovered.notification, undefined);
  const route = JSON.parse(fs.readFileSync(statePath, "utf8")).routes.find((item) => item.kind === "suggestion");
  assert.equal(route.notification.status, "uncertain");
  assert.ok(route.finalText.includes("possibly already sent"));
  assert.equal(route.suggestionText, "possibly already sent");
  const repeated = suggest("turn-crash", "possibly already sent");
  assert.equal(repeated.status, "notification-uncertain");
  assert.equal(repeated.notification, undefined);
  assert.equal(broker.retryNotification({ originHost: "regular-mac" }).status, "empty");
});

test("compact suggestion layout uses one poll at 255 units and exact text plus poll at 256", (t) => {
  const { broker, options, source, statePath } = fixture(t);
  for (const [turnId, exact, expectedPhase] of [
    ["turn-short", `  ${"🟢".repeat(125)}\n \t`, "poll"],
    ["turn-long", `  ${"🟢".repeat(125)}\n \tX`, "notification"],
  ]) {
    source(turnId);
    const created = broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId,
      predictionSessionId: predictionSession, predictionTurnId: `prediction-${turnId}`, suggestionText: exact });
    assert.equal(created.phase, expectedPhase);
    assert.equal(created.route.notificationStatus, expectedPhase === "poll" ? "ready" : "sending");
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8")).routes.find((route) => route.id === created.route.id);
    assert.equal(saved.suggestionText, exact);
    assert.equal(exact.length, expectedPhase === "poll" ? 255 : 256);
    assert.equal(saved.finalText, exact);
    assert.equal(saved.suggestionLayout, expectedPhase === "poll" ? "compact-short-v1" : "compact-long-v1");
    assert.equal(new CodexApprovalStore(statePath).load().schemaVersion, 4);
    if (expectedPhase === "notification") {
      assert.deepEqual(created.notification.messages, [exact]);
      assert.equal(created.notification.singleMessage, true);
      broker.finishNotification({ routeId: created.route.id, notificationDeliveryId: created.notificationDeliveryId,
        sent: true, messageIds: [`WA.text-${turnId}`] });
    } else {
      assert.equal(broker.retryNotification({ originHost: "regular-mac" }).status, "empty");
    }
    const reserved = expectedPhase === "poll" ? created : broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId,
      predictionSessionId: predictionSession, predictionTurnId: `prediction-${turnId}`, suggestionText: exact });
    assert.equal(reserved.phase, "poll");
    assert.equal(reserved.poll.context, null);
    assert.equal(reserved.poll.question, expectedPhase === "poll" ? exact : "Send this suggestion?");
    assert.deepEqual(reserved.poll.options, ["Send suggestion", "Dismiss"]);
    broker.beginSuggestionPoll({ routeId: reserved.route.id, pollDeliveryId: reserved.pollDeliveryId });
    const pollId = `WA.poll-${turnId}`;
    broker.finishSuggestionPoll({ routeId: reserved.route.id, pollDeliveryId: reserved.pollDeliveryId,
      sent: true, pollMessageId: pollId, messageIds: [pollId] });
    const restarted = new CodexWhatsAppBroker(options);
    assert.equal(restarted.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId,
      predictionSessionId: predictionSession, predictionTurnId: `prediction-${turnId}`, suggestionText: exact }).phase, undefined);
    const quoteId = expectedPhase === "poll" ? pollId : `WA.text-${turnId}`;
    assert.equal(restarted.ingest({ chatId: chat, senderId: otherSender, messageId: `IN.unauth-${turnId}`, quotedMessageId: quoteId, text: "extra" }).status, "ignored");
    assert.equal(restarted.ingest({ chatId: chat, senderId: sender, messageId: `IN.quote-${turnId}`, quotedMessageId: quoteId, text: "  added 🟡 " }).status, "queued");
    const claim = restarted.claim({ originHost: "regular-mac" });
    assert.equal(claim.reply.body, `${exact}\n\n  added 🟡 `);
    restarted.complete({ originHost: "regular-mac", deliveryId: claim.deliveryId });
    assert.equal(restarted.ingest({ chatId: chat, senderId: sender, messageId: `IN.repeat-${turnId}`, quotedMessageId: pollId, text: "again" }).status, "stale");
  }
});
