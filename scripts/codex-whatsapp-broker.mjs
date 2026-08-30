#!/usr/bin/env node

import {
  CodexWhatsAppBroker,
  sendWhatsAppNotification,
  sendWhatsAppReaction,
} from "./lib/bridge-state.mjs";
import { bridgePaths, readConfig } from "./lib/runtime-config.mjs";

async function readStandardInput() {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 512 * 1_024) throw new Error("Input is too large");
  }
  if (!body.trim()) return {};
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Input must be a JSON object");
  }
  return parsed;
}

function brokerFromEnvironment() {
  const config = readConfig({ required: false }) ?? {
    schemaVersion: 1,
    role: "combined",
    hostId: "environment",
    gateway: {},
    whatsapp: {},
  };
  const paths = bridgePaths(config);
  const split = (value) =>
    Array.isArray(value)
      ? value
      : (value ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
  const statePath =
    process.env.CODEX_WHATSAPP_STATE ??
    paths.brokerState;
  const whatsappChatId =
    process.env.CODEX_WHATSAPP_TARGET ?? config.whatsapp?.chatId ?? null;
  const bridgeUrl =
    process.env.CODEX_WHATSAPP_BRIDGE_URL ?? config.whatsapp?.bridgeUrl ?? null;
  const allowedUsers = split(
    process.env.CODEX_WHATSAPP_ALLOWED_SENDERS ?? config.whatsapp?.allowedSenders,
  );
  const broker = new CodexWhatsAppBroker({
    statePath,
    allowedSenders: allowedUsers,
    allowedChats: [
      ...allowedUsers,
      ...split(process.env.CODEX_WHATSAPP_ALLOWED_CHATS ?? whatsappChatId),
    ],
    notificationTarget: whatsappChatId,
    taskInboxTarget: config.codexInbox ?? null,
    attachmentStorePath:
      process.env.CODEX_WHATSAPP_ATTACHMENT_STORE ??
      paths.brokerAttachments,
    attachmentSourceRoots: split(
      process.env.CODEX_WHATSAPP_ATTACHMENT_SOURCE_ROOTS ??
      config.whatsapp?.attachmentSourceRoots,
    ),
  });
  return { broker, bridgeUrl };
}

async function execute(broker, command, payload, bridgeUrl) {
  if (command === "create" || command === "retry-notification") {
    let result =
      command === "create" ? broker.create(payload) : broker.retryNotification(payload);
    if (command === "retry-notification" && !result.notification) result = broker.retryFailureNotification(payload);
    if (!result.notification) return result;
    let sent = false;
    let messageIds = [];
    let partial = false;
    let uncertain = false;
    let activityMessageIds = [];
    try {
      const delivery = await sendWhatsAppNotification(result.notification, { bridgeUrl });
      messageIds = delivery.messageIds;
      partial = delivery.status === "partial";
      sent = true;
    } catch (error) {
      sent = false;
      uncertain = error?.deliveryUncertain === true;
      activityMessageIds = Array.isArray(error?.activityMessageIds) ? error.activityMessageIds : [];
    }
    const failureNotice = Boolean(result.reply && !result.route);
    const recorded = failureNotice
      ? broker.finishFailureNotification({ replyId: result.reply.id, notificationDeliveryId: result.notificationDeliveryId, sent, uncertain })
      : broker.finishNotification({ routeId: result.route.id, notificationDeliveryId: result.notificationDeliveryId, sent, messageIds, activityMessageIds, partial, uncertain });
    delete result.notification;
    delete result.notificationDeliveryId;
    result.ok = recorded.ok;
    if (failureNotice) result.reply = recorded.reply ?? result.reply;
    else result.route = recorded.route ?? result.route;
    result.notification = { status: recorded.status };
    if (!sent) result.status = recorded.status;
    return result;
  }
  if (command === "ingest") return broker.ingest(payload);
  if (command === "ingest-new-task") return broker.ingestNewTask(payload);
  if (command === "inbox-target") return broker.inboxTarget();
  if (command === "admission-status") return broker.admissionStatus(payload);
  if (command === "bind-task") return broker.bindTask(payload);
  if (command === "claim") return broker.claim(payload);
  if (command === "accept" || command === "retry-receipt") {
    const result = command === "accept" ? broker.accept(payload) : broker.retryReceipt(payload);
    if (!result.reaction) return result;
    let sent = false;
    try { await sendWhatsAppReaction(result.reaction, { bridgeUrl }); sent = true; }
    catch { /* same-message reactions are idempotent and retry from durable broker state */ }
    const recorded = broker.finishReceipt({ replyId: result.reply.id, receiptDeliveryId: result.receiptDeliveryId, sent });
    delete result.reaction;
    delete result.receiptDeliveryId;
    result.receiptStatus = recorded.status;
    result.reply = recorded.reply ?? result.reply;
    return result;
  }
  if (command === "complete") return broker.complete(payload);
  if (command === "release") return broker.release(payload);
  if (command === "fail") {
    const result = broker.fail(payload);
    if (result.notification) {
      let sent = false, uncertain = false;
      try { await sendWhatsAppNotification(result.notification, { bridgeUrl }); sent = true; }
      catch (error) { uncertain = error?.deliveryUncertain === true; }
      const recorded = broker.finishFailureNotification({ replyId: result.reply.id, notificationDeliveryId: result.notificationDeliveryId, sent, uncertain });
      result.reply = recorded.reply ?? result.reply;
      result.notificationStatus = recorded.status;
      delete result.notification;
      delete result.notificationDeliveryId;
    }
    return result;
  }
  if (command === "status") return broker.status(payload);
  throw new Error("Unsupported command");
}

try {
  const payload = await readStandardInput();
  const command = process.argv[2] ?? payload.command;
  if (typeof command !== "string" || !command) throw new Error("A command is required");
  const runtime = brokerFromEnvironment();
  const result = await execute(runtime.broker, command, payload, runtime.bridgeUrl);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(
    `${JSON.stringify({ ok: false, status: "error", error: error?.message ?? "Unknown error" })}\n`,
  );
}
