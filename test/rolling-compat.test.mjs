import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexApprovalStore, CodexWhatsAppBroker } from "../scripts/lib/bridge-state.mjs";

const sender = "15550000001@s.whatsapp.net";
const chat = "120363000000000001@g.us";
const sourceSession = "11111111-1111-4111-8111-111111111111";
const predictionSession = "22222222-2222-4222-8222-222222222222";

// Contract: the first post-restart state writes remain readable by schema-4 Stop hooks.
// Regression: a schema bump, missing uncertain finalText, sent finalText, or reply over 8,000 chars
// would make a still-running old hook reject or fail to commit shared state during app restart.
// Keeper: suggestion-broker tests retain the one-time quote/poll race and attachment routing contract.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-compat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "private", "state.json");
  const clock = { now: Date.UTC(2026, 9, 18) };
  const options = { statePath, allowedSenders: [sender], allowedChats: [chat], notificationTarget: chat, now: () => clock.now };
  const broker = new CodexWhatsAppBroker(options);
  return { broker, statePath, clock };
}

function makeSuggestion(broker, turnId, suggestionText) {
  const source = broker.create({ originHost: "regular-mac", sessionId: sourceSession, turnId, finalText: "Source answer" });
  assert.equal(source.status, "sending");
  const suggestion = broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId,
    predictionSessionId: predictionSession, predictionTurnId: `prediction-${turnId}`, suggestionText });
  broker.finishNotification({ routeId: suggestion.route.id, notificationDeliveryId: suggestion.notificationDeliveryId,
    sent: true, messageIds: [`WA.${turnId}`] });
  return suggestion;
}

test("schema 4 remains unchanged as suggestion metadata advances through sent and consumed states", (t) => {
  const { broker, statePath } = fixture(t);
  const suggestion = makeSuggestion(broker, "turn-sent", "exact suggestion");
  const stateAfterSend = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const sentRoute = stateAfterSend.routes.find((route) => route.id === suggestion.route.id);
  assert.equal(stateAfterSend.schemaVersion, 4);
  assert.equal(sentRoute.notification.status, "sent");
  assert.equal(sentRoute.finalText, undefined);
  assert.equal(sentRoute.suggestionText, "exact suggestion");
  assert.equal(sentRoute.suggestionMessageDigests.length, 1);

  assert.equal(broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.turn-sent", quotedMessageId: "WA.turn-sent", text: "add this" }).status, "queued");
  const stateAfterQuote = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(stateAfterQuote.schemaVersion, 4);
  assert.equal(stateAfterQuote.routes.find((route) => route.id === suggestion.route.id).consumedMessageDigest.length, 64);
  assert.equal(stateAfterQuote.replies[0].body, "exact suggestion\n\nadd this");
  assert.equal(new CodexApprovalStore(statePath).load().schemaVersion, 4);
});

test("uncertain suggestion keeps old-hook-readable payload and duplicate Stop cannot resend", (t) => {
  const { broker, statePath, clock } = fixture(t);
  const source = broker.create({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-uncertain", finalText: "Source answer" });
  const suggestion = broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-uncertain",
    predictionSessionId: predictionSession, predictionTurnId: "prediction-turn-uncertain", suggestionText: "possibly sent" });
  broker.beginNotificationDelivery({ routeId: suggestion.route.id, notificationDeliveryId: suggestion.notificationDeliveryId });
  clock.now += 17 * 60 * 1000;

  const uncertain = broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-uncertain",
    predictionSessionId: predictionSession, predictionTurnId: "prediction-turn-uncertain", suggestionText: "possibly sent" });
  assert.equal(uncertain.status, "notification-uncertain");
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const route = persisted.routes.find((item) => item.id === suggestion.route.id);
  assert.equal(persisted.schemaVersion, 4);
  assert.equal(route.notification.status, "uncertain");
  assert.ok(route.finalText.includes("possibly sent"));
  assert.equal(route.suggestionText, "possibly sent");

  const duplicate = broker.createSuggestion({ originHost: "regular-mac", sessionId: sourceSession, turnId: "turn-uncertain",
    predictionSessionId: predictionSession, predictionTurnId: "prediction-turn-uncertain", suggestionText: "possibly sent" });
  assert.equal(duplicate.status, "notification-uncertain");
  assert.equal(duplicate.notification, undefined);
  assert.equal(broker.retryNotification({ originHost: "regular-mac" }).status, "empty");
});

test("addition exceeding old-hook 8,000-character reply limit is visibly rejected before consumption", (t) => {
  const { broker, statePath } = fixture(t);
  const suggestionText = "s".repeat(7_998);
  makeSuggestion(broker, "turn-too-long", suggestionText);

  const rejected = broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.too-long", quotedMessageId: "WA.turn-too-long", text: "append" });
  assert.equal(rejected.status, "suggestion-reply-too-long");
  assert.match(rejected.acknowledgement, /8,000-character reply limit/);
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const route = persisted.routes.find((item) => item.kind === "suggestion");
  assert.equal(route.consumedAt, undefined);
  assert.equal(persisted.replies.length, 0);
  assert.equal(route.expiresAt, persisted.routes.find((item) => item.kind !== "suggestion").expiresAt);

  makeSuggestion(broker, "turn-exact-boundary", "s".repeat(7_990));
  const exactBoundary = broker.ingest({ chatId: chat, senderId: sender, messageId: "IN.exact-boundary", quotedMessageId: "WA.turn-exact-boundary", text: "12345678" });
  assert.equal(exactBoundary.status, "queued");
  assert.equal(broker.claim({ originHost: "regular-mac" }).reply.body.length, 8_000);
});
