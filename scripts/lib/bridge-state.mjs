import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CodexAttachmentStore,
  validateAttachmentRecords,
} from "./attachments.mjs";

const SCHEMA_VERSION = 4;
const ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const CLAIM_LEASE_MS = 85 * 60 * 1_000;
const RETRY_DELAY_MS = 60_000;
const MAX_SEND_ATTEMPTS = 3;
const NOTIFICATION_LEASE_MS = 16 * 60_000;
const NOTIFICATION_TIMEOUT_MS = 15 * 60_000;
const RECEIPT_LEASE_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 10_000;
const MAX_FINAL_LENGTH = 48_000;
const MAX_ACTIVITY_LENGTH = 3_900;
const MAX_REPLY_LENGTH = 8_000;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;

function text(value, name, maximum, multiline = false) {
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  const normalized = multiline ? value : value.trim();
  if (!value.trim() || normalized.length > maximum) throw new Error(`${name} is invalid`);
  if (CONTROL.test(normalized) || (!multiline && /[\r\n]/.test(normalized))) {
    throw new Error(`${name} contains unsupported control characters`);
  }
  return normalized;
}

function optional(value, name, maximum) {
  return value === undefined || value === null || value === ""
    ? null
    : text(value, name, maximum);
}

function time(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function host(value) {
  return text(value, "originHost", 128).toLocaleLowerCase("en-US");
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validMessageId(value, name = "messageId") {
  const result = text(value, name, 256);
  if (!MESSAGE_ID.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function jid(value) {
  const match = String(value ?? "").trim().toLowerCase().match(
    /^([0-9]{1,32}(?:-[0-9]{1,32})?)(?::[0-9]{1,3})?@(s\.whatsapp\.net|c\.us|lid|g\.us)$/,
  );
  if (!match || (match[1].includes("-") && match[2] !== "g.us")) return null;
  return `${match[1]}@${match[2] === "c.us" ? "s.whatsapp.net" : match[2]}`;
}

export function normalizeWhatsAppIdentifier(value) {
  return jid(value);
}

function allowed(value, allowlist) {
  const normalized = jid(value);
  return Boolean(normalized && allowlist.some((candidate) => jid(candidate) === normalized));
}

function storedDigest(value, name) {
  const result = text(value, name, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function validateRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) throw new Error("Stored route is invalid");
  text(route.id, "stored route id", 64);
  host(route.originHost);
  text(route.sessionId, "stored sessionId", 128);
  text(route.turnId, "stored turnId", 128);
  time(route.createdAt, "stored createdAt", 0);
  time(route.expiresAt, "stored expiresAt", 0);
  if (!route.notification || typeof route.notification !== "object" || Array.isArray(route.notification)) throw new Error("Stored notification is invalid");
  if (!new Set(["ready", "sending", "failed", "sent", "partial", "exhausted"]).has(route.notification.status)) throw new Error("Stored notification status is invalid");
  if (!Number.isInteger(route.notification.attempts) || route.notification.attempts < 0 || route.notification.attempts > MAX_SEND_ATTEMPTS) throw new Error("Stored notification attempts are invalid");
  if (route.finalText !== undefined) text(route.finalText, "stored finalText", MAX_FINAL_LENGTH, true);
  if (route.activityText !== undefined) text(route.activityText, "stored activityText", MAX_ACTIVITY_LENGTH, true);
  if (route.messageDigests !== undefined) {
    if (!Array.isArray(route.messageDigests) || route.messageDigests.length === 0) throw new Error("Stored route message digests are invalid");
    route.messageDigests.forEach((item) => storedDigest(item, "stored message digest"));
  }
  if (new Set(["sent", "partial"]).has(route.notification.status)) {
    if (route.finalText !== undefined || route.activityText !== undefined || route.messageDigests === undefined) throw new Error("Stored sent route is invalid");
  }
  if (route.notification.status === "sending") {
    text(route.notification.deliveryId, "stored notification deliveryId", 64);
    time(route.notification.leaseExpiresAt, "stored notification lease", 0);
  }
  if (new Set(["ready", "sending", "failed"]).has(route.notification.status) && route.finalText === undefined) throw new Error("Stored pending route is invalid");
  if (new Set(["partial", "exhausted"]).has(route.notification.status) && (route.finalText !== undefined || route.activityText !== undefined)) throw new Error("Stored terminal route is invalid");
  return route;
}

function validateReply(reply) {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Stored reply is invalid");
  text(reply.id, "stored reply id", 64);
  if (!new Set(["quoted", "new-task"]).has(reply.kind)) throw new Error("Stored reply kind is invalid");
  if (reply.kind === "quoted") text(reply.routeId, "stored routeId", 64);
  else if (reply.routeId !== undefined) throw new Error("Stored new-task reply route is invalid");
  host(reply.originHost);
  if (reply.sessionId !== undefined) text(reply.sessionId, "stored sessionId", 128);
  if (reply.kind === "quoted" && reply.sessionId === undefined) throw new Error("Stored quoted reply session is invalid");
  if (reply.kind === "quoted") text(reply.turnId, "stored turnId", 128);
  else if (reply.turnId !== undefined) throw new Error("Stored new-task reply turn is invalid");
  if (!Number.isSafeInteger(reply.sequence) || reply.sequence < 1) throw new Error("Stored reply sequence is invalid");
  storedDigest(reply.inboundMessageDigest, "stored inbound message digest");
  if (reply.acceptedAt !== undefined) time(reply.acceptedAt, "stored acceptedAt", 0);
  if (reply.receiptSentAt !== undefined) time(reply.receiptSentAt, "stored receiptSentAt", 0);
  if (reply.receiptExhaustedAt !== undefined) time(reply.receiptExhaustedAt, "stored receiptExhaustedAt", 0);
  if (reply.receipt) {
    if (typeof reply.receipt !== "object" || Array.isArray(reply.receipt)) throw new Error("Stored receipt is invalid");
    if (!jid(reply.receipt.chatId)) throw new Error("Stored receipt chat is invalid");
    validMessageId(reply.receipt.messageId, "stored receipt messageId");
    if (reply.receipt.participant !== undefined && !jid(reply.receipt.participant)) throw new Error("Stored receipt participant is invalid");
    if (!new Set(["pending", "sending", "failed"]).has(reply.receipt.status)) throw new Error("Stored receipt status is invalid");
    if (!Number.isInteger(reply.receipt.attempts) || reply.receipt.attempts < 0 || reply.receipt.attempts > MAX_SEND_ATTEMPTS) throw new Error("Stored receipt attempts are invalid");
    if (reply.receipt.status === "sending") {
      text(reply.receipt.deliveryId, "stored receipt deliveryId", 64);
      time(reply.receipt.leaseExpiresAt, "stored receipt lease", 0);
    }
  }
  if (reply.receipt && (reply.receiptSentAt !== undefined || reply.receiptExhaustedAt !== undefined)) throw new Error("Stored terminal receipt is invalid");
  if (reply.receiptSentAt !== undefined && reply.receiptExhaustedAt !== undefined) throw new Error("Stored receipt outcome is invalid");
  if (!new Set(["queued", "claimed", "completed", "failed"]).has(reply.status)) throw new Error("Stored reply status is invalid");
  time(reply.receivedAt, "stored receivedAt", 0);
  time(reply.expiresAt, "stored expiresAt", 0);
  if (new Set(["completed", "failed"]).has(reply.status)) {
    if (reply.body !== undefined || reply.attachments !== undefined || reply.delivery !== undefined) throw new Error("Stored completed reply is invalid");
    if (reply.status === "completed") text(reply.completedDeliveryId, "stored completedDeliveryId", 64);
    else {
      text(reply.failureReason, "stored failureReason", 512, true);
      if (!reply.failureNotification || !new Set(["ready", "sending", "failed", "sent", "exhausted"]).has(reply.failureNotification.status)) throw new Error("Stored failure notification is invalid");
      if (!Number.isInteger(reply.failureNotification.attempts) || reply.failureNotification.attempts < 0 || reply.failureNotification.attempts > MAX_SEND_ATTEMPTS) throw new Error("Stored failure notification attempts are invalid");
      if (reply.failureNotification.status === "sending") {
        text(reply.failureNotification.deliveryId, "stored failure deliveryId", 64);
        time(reply.failureNotification.leaseExpiresAt, "stored failure lease", 0);
      }
    }
  } else {
    if (typeof reply.body !== "string" || reply.body.length > MAX_REPLY_LENGTH || CONTROL.test(reply.body)) throw new Error("Stored reply body is invalid");
    const attachments = validateAttachmentRecords(reply.attachments ?? []);
    if (!reply.body.trim() && attachments.length === 0) throw new Error("Stored reply has no input");
  }
  if (reply.status === "completed" && !reply.sessionId) throw new Error("Stored completed reply session is invalid");
  if (reply.status === "claimed") {
    if (!reply.delivery || typeof reply.delivery !== "object") throw new Error("Stored claimed reply is invalid");
    text(reply.delivery.id, "stored delivery id", 64);
    time(reply.delivery.expiresAt, "stored delivery expiry", 0);
  } else if (reply.delivery !== undefined) throw new Error("Stored reply delivery is invalid");
  return reply;
}

function validateState(parsed) {
  if (
    !parsed ||
    parsed.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(parsed.routes) ||
    !Array.isArray(parsed.replies) ||
    !Number.isSafeInteger(parsed.nextSequence) || parsed.nextSequence < 1
  ) {
    throw new Error("Stored approval state is invalid");
  }
  parsed.routes.forEach(validateRoute);
  parsed.replies.forEach(validateReply);
  if (parsed.replies.some((reply) => reply.sequence >= parsed.nextSequence)) throw new Error("Stored reply sequence cursor is invalid");
  if (new Set(parsed.routes.map((route) => route.id)).size !== parsed.routes.length) throw new Error("Stored route IDs are invalid");
  if (new Set(parsed.replies.map((reply) => reply.inboundMessageDigest)).size !== parsed.replies.length) throw new Error("Stored inbound message digests are invalid");
  const routeIds = new Set(parsed.routes.map((route) => route.id));
  if (parsed.replies.some((reply) => reply.kind === "quoted" && !routeIds.has(reply.routeId))) throw new Error("Stored reply route is invalid");
  return parsed;
}

export class CodexApprovalStore {
  constructor(filePath, { lockTimeoutMs = 2_000, lockStaleMs = 15_000 } = {}) {
    if (!filePath) throw new Error("A state file path is required");
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return { schemaVersion: SCHEMA_VERSION, routes: [], replies: [], nextSequence: 1 };
    }
    return validateState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  save(state) {
    validateState(state);
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      const directoryDescriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  transact(callback) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const token = crypto.randomUUID();
    const startedAt = Date.now();
    while (true) {
      try {
        fs.writeFileSync(this.lockPath, token, { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(this.lockPath).mtimeMs > this.lockStaleMs) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) throw new Error("Approval state is busy");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      const state = this.load();
      const result = callback(state);
      this.save(state);
      return result;
    } finally {
      try {
        if (fs.readFileSync(this.lockPath, "utf8") === token) fs.unlinkSync(this.lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function prune(state, now) {
  const removedAttachments = [];
  const live = new Set(state.routes.filter((route) => route.expiresAt > now).map((route) => route.id));
  state.routes = state.routes.filter((route) => live.has(route.id));
  state.replies = state.replies.filter((reply) => {
    const keep = reply.expiresAt > now && (reply.kind === "new-task" || live.has(reply.routeId));
    if (!keep) removedAttachments.push(...(reply.attachments ?? []));
    return keep;
  });
  return removedAttachments;
}

function routeSummary(route) {
  return {
    id: route.id,
    originHost: route.originHost,
    sessionId: route.sessionId,
    turnId: route.turnId,
    createdAt: route.createdAt,
    expiresAt: route.expiresAt,
    notificationStatus: route.notification.status,
    messageCount: route.messageDigests?.length ?? 0,
  };
}

function replySummary(reply) {
  return {
    id: reply.id,
    kind: reply.kind,
    sequence: reply.sequence,
    ...(reply.routeId ? { routeId: reply.routeId } : {}),
    originHost: reply.originHost,
    ...(reply.sessionId ? { sessionId: reply.sessionId } : {}),
    ...(reply.turnId ? { turnId: reply.turnId } : {}),
    status: reply.status,
    receivedAt: reply.receivedAt,
    expiresAt: reply.expiresAt,
    attachmentCount: reply.attachments?.length ?? 0,
    receiptStatus: reply.receiptSentAt !== undefined
      ? "sent"
      : reply.receiptExhaustedAt !== undefined
        ? "exhausted"
        : (reply.receipt?.status ?? "unavailable"),
    ...(reply.failureNotification ? { failureNotificationStatus: reply.failureNotification.status } : {}),
  };
}

function reserve(route, now) {
  if (!route.finalText || route.notification.status === "sent") return null;
  if (route.notification.status === "sending" && route.notification.leaseExpiresAt > now) return null;
  if (route.notification.attempts >= MAX_SEND_ATTEMPTS) return null;
  const deliveryId = crypto.randomUUID();
  route.notification = {
    status: "sending",
    deliveryId,
    claimedAt: now,
    leaseExpiresAt: now + NOTIFICATION_LEASE_MS,
    attempts: route.notification.attempts + 1,
  };
  return deliveryId;
}

function outboundNotification(route, target) {
  return {
    target,
    messages: [...(route.activityText ? [route.activityText] : []), route.finalText],
    deliveryKey: route.id,
    deliveryOffset: route.activityText ? 0 : (route.messageDigests?.length ?? 0),
  };
}

function reserveFailure(reply, now) {
  const notification = reply.failureNotification;
  if (!notification || notification.status === "sent" || notification.status === "exhausted" || (notification.status === "sending" && notification.leaseExpiresAt > now) || notification.attempts >= MAX_SEND_ATTEMPTS) return null;
  const deliveryId = crypto.randomUUID();
  reply.failureNotification = { status: "sending", deliveryId, claimedAt: now, leaseExpiresAt: now + NOTIFICATION_LEASE_MS, attempts: notification.attempts + 1 };
  return deliveryId;
}

function reserveReceipt(reply, now) {
  const receipt = reply.receipt;
  if (!reply.acceptedAt || !receipt || receipt.status === "sending" && receipt.leaseExpiresAt > now || receipt.attempts >= MAX_SEND_ATTEMPTS) return null;
  const deliveryId = crypto.randomUUID();
  reply.receipt = {
    chatId: receipt.chatId,
    messageId: receipt.messageId,
    ...(receipt.participant ? { participant: receipt.participant } : {}),
    status: "sending",
    deliveryId,
    claimedAt: now,
    leaseExpiresAt: now + RECEIPT_LEASE_MS,
    attempts: receipt.attempts + 1,
  };
  return deliveryId;
}

function receiptTarget(chatId, senderId, messageId) {
  const normalizedChat = jid(chatId);
  const normalizedSender = jid(senderId);
  if (!normalizedChat || !normalizedSender) throw new Error("Receipt target is invalid");
  return {
    chatId: normalizedChat,
    messageId: validMessageId(messageId),
    ...(normalizedChat.endsWith("@g.us") ? { participant: normalizedSender } : {}),
    status: "pending",
    attempts: 0,
  };
}

export class CodexWhatsAppBroker {
  constructor({ statePath, allowedSenders = [], allowedChats = [], notificationTarget = null, taskInboxTarget = null, attachmentStorePath = null, attachmentSourceRoots = [], now = () => Date.now(), claimLeaseMs = CLAIM_LEASE_MS, store = null, attachmentStore = null }) {
    this.store = store ?? new CodexApprovalStore(statePath);
    const resolvedAttachmentStorePath = attachmentStorePath ?? path.join(path.dirname(statePath), "attachments");
    this.attachmentStore = attachmentStore ?? new CodexAttachmentStore(resolvedAttachmentStorePath, attachmentSourceRoots);
    this.allowedSenders = allowedSenders;
    this.allowedChats = allowedChats;
    this.notificationTarget = notificationTarget;
    if (taskInboxTarget) {
      const cwd = text(taskInboxTarget.cwd, "task inbox cwd", 1_024);
      if (!path.isAbsolute(cwd)) throw new Error("Task inbox cwd must be absolute");
      this.taskInboxTarget = { originHost: host(taskInboxTarget.originHost), cwd };
    } else this.taskInboxTarget = null;
    this.now = now;
    this.claimLeaseMs = claimLeaseMs;
  }

  transact(now, callback) {
    let expiredAttachments = [];
    const result = this.store.transact((state) => {
      expiredAttachments = prune(state, now);
      return callback(state);
    });
    try { this.attachmentStore.remove(expiredAttachments); } catch { /* committed broker state remains authoritative; sweep retries cleanup */ }
    try {
      const referenced = new Set(this.store.load().replies.flatMap((reply) => (reply.attachments ?? []).map((attachment) => attachment.storageName)));
      this.attachmentStore.sweep(referenced, now);
    } catch { /* orphan cleanup never changes broker delivery semantics */ }
    return result;
  }

  create(input) {
    const now = this.now();
    const originHost = host(input?.originHost);
    const sessionId = text(input?.sessionId, "sessionId", 128);
    const turnId = text(input?.turnId, "turnId", 128);
    const finalText = text(input?.finalText, "finalText", MAX_FINAL_LENGTH, true);
    const activityText = input?.activityText === undefined || input?.activityText === null || input?.activityText === ""
      ? null
      : text(input.activityText, "activityText", MAX_ACTIVITY_LENGTH, true);
    const createdAt = time(input?.createdAt, "createdAt", now);
    return this.transact(now, (state) => {
      const existing = state.routes.find((route) => route.originHost === originHost && route.sessionId === sessionId && route.turnId === turnId);
      if (existing) {
        const notificationDeliveryId = reserve(existing, now);
        return {
          ok: true,
          status: existing.notification.status,
          created: false,
          route: routeSummary(existing),
          ...(notificationDeliveryId ? { notificationDeliveryId, notification: outboundNotification(existing, this.notificationTarget) } : {}),
        };
      }
      const route = {
        id: crypto.randomUUID(), originHost, sessionId, turnId, finalText,
        ...(activityText ? { activityText } : {}),
        createdAt, expiresAt: createdAt + ROUTE_TTL_MS,
        notification: { status: "ready", attempts: 0 },
      };
      const notificationDeliveryId = reserve(route, now);
      state.routes.push(route);
      return { ok: true, status: "sending", created: true, route: routeSummary(route), notificationDeliveryId, notification: outboundNotification(route, this.notificationTarget) };
    });
  }

  retryNotification(input = {}) {
    const now = this.now();
    const originHost = optional(input.originHost, "originHost", 128)?.toLowerCase() ?? null;
    return this.transact(now, (state) => {
      for (const item of state.routes) {
        if (item.finalText && item.notification.status === "sending" && item.notification.leaseExpiresAt <= now) {
          item.notification = { status: "exhausted", exhaustedAt: now, attempts: item.notification.attempts };
          delete item.finalText;
          delete item.activityText;
        }
      }
      const route = state.routes.filter((item) => item.finalText && (!originHost || item.originHost === originHost) && item.notification.status === "failed" && item.notification.attempts < MAX_SEND_ATTEMPTS && item.notification.failedAt + RETRY_DELAY_MS <= now).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!route) return { ok: true, status: "empty" };
      const notificationDeliveryId = reserve(route, now);
      return notificationDeliveryId ? { ok: true, status: "sending", route: routeSummary(route), notificationDeliveryId, notification: outboundNotification(route, this.notificationTarget) } : { ok: true, status: "empty" };
    });
  }

  finishNotification(input) {
    const now = this.now();
    const routeId = text(input?.routeId, "routeId", 64);
    const deliveryId = text(input?.notificationDeliveryId, "notificationDeliveryId", 64);
    const messageIds = Array.isArray(input?.messageIds) ? [...new Set(input.messageIds.map((item) => validMessageId(item)))] : [];
    const activityMessageIds = Array.isArray(input?.activityMessageIds) ? [...new Set(input.activityMessageIds.map((item) => validMessageId(item)))] : [];
    return this.transact(now, (state) => {
      const route = state.routes.find((item) => item.id === routeId);
      if (!route || route.notification.status !== "sending" || route.notification.deliveryId !== deliveryId) return { ok: true, status: "stale" };
      if (activityMessageIds.length > 0) {
        route.messageDigests = [...new Set([...(route.messageDigests ?? []), ...activityMessageIds.map(digest)])];
        delete route.activityText;
      }
      if (input?.sent === true && messageIds.length > 0) {
        route.messageDigests = [...new Set([...(route.messageDigests ?? []), ...messageIds.map(digest)])];
        const status = input?.partial === true ? "partial" : "sent";
        route.notification = { status, sentAt: now, attempts: route.notification.attempts };
        delete route.finalText;
        delete route.activityText;
        return { ok: true, status, route: routeSummary(route) };
      }
      if (input?.uncertain === true || route.notification.attempts >= MAX_SEND_ATTEMPTS) {
        route.notification = { status: "exhausted", exhaustedAt: now, attempts: route.notification.attempts };
        delete route.finalText;
        delete route.activityText;
      } else {
        route.notification = { status: "failed", failedAt: now, attempts: route.notification.attempts };
      }
      return { ok: false, status: route.notification.status === "exhausted" ? "notification-exhausted" : "notification-failed", route: routeSummary(route) };
    });
  }

  ingest(input) {
    const now = this.now();
    const chatId = optional(input?.chatId, "chatId", 192);
    const senderId = optional(input?.senderId, "senderId", 192);
    const messageId = optional(input?.messageId, "messageId", 256);
    const quotedMessageId = optional(input?.quotedMessageId, "quotedMessageId", 256);
    const attachmentInputs = input?.attachments ?? [];
    const body = typeof input?.text === "string" ? input.text : "";
    if (!chatId || !senderId || !messageId || !quotedMessageId || body.length > MAX_REPLY_LENGTH || CONTROL.test(body) || (!body.trim() && (!Array.isArray(attachmentInputs) || attachmentInputs.length === 0)) || !Array.isArray(attachmentInputs) || !MESSAGE_ID.test(messageId) || !MESSAGE_ID.test(quotedMessageId) || !allowed(senderId, this.allowedSenders) || !allowed(chatId, this.allowedChats)) {
      return { ok: true, status: "ignored", acknowledgement: "That quoted Codex reply could not be accepted. Reply in Codex instead." };
    }
    const inboundMessageDigest = digest(messageId);
    const quotedDigest = digest(quotedMessageId);
    const admission = this.transact(now, (state) => {
      const duplicate = state.replies.find((reply) => reply.inboundMessageDigest === inboundMessageDigest);
      if (duplicate) return { result: { ok: true, status: "duplicate", reply: replySummary(duplicate), acknowledgement: "That reply was already queued for Codex." } };
      const candidates = state.routes.filter((route) => route.messageDigests?.includes(quotedDigest));
      if (candidates.length !== 1) return { result: { ok: true, status: "stale", acknowledgement: "That quoted Codex turn is unknown or expired. Reply in Codex instead." } };
      return { routeId: candidates[0].id };
    });
    if (admission.result) return admission.result;
    let staged = [];
    try {
      staged = this.attachmentStore.stage(attachmentInputs);
      const committed = this.transact(this.now(), (state) => {
      const duplicate = state.replies.find((reply) => reply.inboundMessageDigest === inboundMessageDigest);
      if (duplicate) return { stored: false, result: { ok: true, status: "duplicate", reply: replySummary(duplicate), acknowledgement: "That reply was already queued for Codex." } };
      const route = state.routes.find((candidate) => candidate.id === admission.routeId && candidate.messageDigests?.includes(quotedDigest));
      if (!route) return { stored: false, result: { ok: true, status: "stale", acknowledgement: "That quoted Codex turn is unknown or expired. Reply in Codex instead." } };
      const reply = { id: crypto.randomUUID(), kind: "quoted", sequence: state.nextSequence++, routeId: route.id, originHost: route.originHost, sessionId: route.sessionId, turnId: route.turnId, inboundMessageDigest, body, ...(staged.length ? { attachments: staged } : {}), receipt: receiptTarget(chatId, senderId, messageId), status: "queued", receivedAt: now, expiresAt: route.expiresAt };
      state.replies.push(reply);
      return { stored: true, result: { ok: true, status: "queued", reply: replySummary(reply), acknowledgement: "Reply queued for Codex." } };
      });
      if (!committed.stored) {
        try { this.attachmentStore.remove(staged); } catch { /* orphan sweep is the final cleanup boundary */ }
      }
      return committed.result;
    } catch (error) {
      try { this.attachmentStore.remove(staged); } catch { /* orphan sweep is the final cleanup boundary */ }
      throw error;
    }
  }

  ingestNewTask(input) {
    const now = this.now();
    const chatId = optional(input?.chatId, "chatId", 192);
    const senderId = optional(input?.senderId, "senderId", 192);
    const messageId = optional(input?.messageId, "messageId", 256);
    const attachmentInputs = input?.attachments ?? [];
    const body = typeof input?.text === "string" ? input.text : "";
    if (!chatId || !senderId || !messageId || body.length > MAX_REPLY_LENGTH || CONTROL.test(body) || (!body.trim() && (!Array.isArray(attachmentInputs) || attachmentInputs.length === 0)) || !Array.isArray(attachmentInputs) || !MESSAGE_ID.test(messageId) || !allowed(senderId, this.allowedSenders) || !allowed(chatId, this.allowedChats)) return { ok: true, status: "ignored" };
    if (!this.taskInboxTarget) return { ok: true, status: "unavailable", acknowledgement: "The Codex task inbox is not configured." };
    const inboundMessageDigest = digest(messageId);
    const admission = this.transact(now, (state) => {
      const duplicate = state.replies.find((reply) => reply.inboundMessageDigest === inboundMessageDigest);
      return duplicate
        ? { result: { ok: true, status: "duplicate", reply: replySummary(duplicate), acknowledgement: "That message was already queued for Codex." } }
        : { admitted: true };
    });
    if (admission.result) return admission.result;
    let staged = [];
    try {
      staged = this.attachmentStore.stage(attachmentInputs);
      const committed = this.transact(this.now(), (state) => {
      const duplicate = state.replies.find((reply) => reply.inboundMessageDigest === inboundMessageDigest);
      if (duplicate) return { stored: false, result: { ok: true, status: "duplicate", reply: replySummary(duplicate), acknowledgement: "That message was already queued for Codex." } };
      const targetHost = host(this.taskInboxTarget.originHost);
      const reply = { id: crypto.randomUUID(), kind: "new-task", sequence: state.nextSequence++, originHost: targetHost, inboundMessageDigest, body, ...(staged.length ? { attachments: staged } : {}), receipt: receiptTarget(chatId, senderId, messageId), status: "queued", receivedAt: now, expiresAt: now + ROUTE_TTL_MS };
      state.replies.push(reply);
      return { stored: true, result: { ok: true, status: "queued", reply: replySummary(reply), acknowledgement: "Message queued for a new Codex task." } };
      });
      if (!committed.stored) {
        try { this.attachmentStore.remove(staged); } catch { /* orphan sweep is the final cleanup boundary */ }
      }
      return committed.result;
    } catch (error) {
      try { this.attachmentStore.remove(staged); } catch { /* orphan sweep is the final cleanup boundary */ }
      throw error;
    }
  }

  inboxTarget() {
    if (!this.taskInboxTarget) return { ok: true, status: "unconfigured" };
    return { ok: true, status: "configured", target: { ...this.taskInboxTarget } };
  }

  admissionStatus(input) {
    const chatId = optional(input?.chatId, "chatId", 192);
    const senderId = optional(input?.senderId, "senderId", 192);
    const messageId = optional(input?.messageId, "messageId", 256);
    if (!chatId || !senderId || !messageId || !MESSAGE_ID.test(messageId) || !allowed(senderId, this.allowedSenders) || !allowed(chatId, this.allowedChats)) {
      return { ok: true, status: "not-found" };
    }
    const inboundMessageDigest = digest(messageId);
    return this.transact(this.now(), (state) => ({
      ok: true,
      status: state.replies.some((reply) => reply.inboundMessageDigest === inboundMessageDigest)
        ? "accepted"
        : "not-found",
    }));
  }

  bindTask(input) {
    const now = this.now();
    const originHost = host(input?.originHost);
    const replyId = text(input?.replyId, "replyId", 64);
    const deliveryId = text(input?.deliveryId, "deliveryId", 64);
    const sessionId = text(input?.sessionId, "sessionId", 128);
    return this.transact(now, (state) => {
      const reply = state.replies.find((item) => item.id === replyId && item.originHost === originHost);
      if (!reply || reply.kind !== "new-task") return { ok: true, status: "stale" };
      if (reply.sessionId) {
        if (reply.sessionId !== sessionId) throw new Error("New-task reply is already bound to another task");
        return { ok: true, status: "bound", reply: replySummary(reply) };
      }
      if (reply.status !== "claimed" || reply.delivery?.id !== deliveryId) return { ok: true, status: "stale" };
      reply.sessionId = sessionId;
      return { ok: true, status: "bound", reply: replySummary(reply) };
    });
  }

  claim(input) {
    const now = this.now();
    const originHost = host(input?.originHost);
    return this.transact(now, (state) => {
      for (const item of state.replies) {
        if (item.status === "claimed" && item.delivery.expiresAt <= now) { item.status = "queued"; delete item.delivery; }
      }
      const queued = state.replies.filter((item) => item.originHost === originHost && item.status === "queued").sort((a, b) => a.sequence - b.sequence);
      const reply = queued.find((candidate) => !candidate.sessionId || !state.replies.some((item) => item.originHost === originHost && item.sessionId === candidate.sessionId && item.status === "claimed"));
      if (!reply) return { ok: true, status: "empty" };
      const deliveryId = crypto.randomUUID();
      reply.status = "claimed";
      reply.delivery = { id: deliveryId, claimedAt: now, expiresAt: Math.min(reply.expiresAt, now + this.claimLeaseMs) };
      return { ok: true, status: "claimed", deliveryId, reply: { ...replySummary(reply), body: reply.body, ...(reply.attachments ? { attachments: reply.attachments } : {}) } };
    });
  }

  fail(input) {
    const now = this.now();
    const originHost = host(input?.originHost);
    const deliveryId = text(input?.deliveryId, "deliveryId", 64);
    const reason = text(input?.reason, "reason", 512, true);
    let attachments = [];
    const result = this.transact(now, (state) => {
      const reply = state.replies.find((item) => item.originHost === originHost && item.status === "claimed" && item.delivery?.id === deliveryId);
      if (!reply) return { ok: true, status: "stale" };
      reply.status = "failed";
      reply.failedAt = now;
      reply.failureReason = reason;
      reply.failureNotification = { status: "ready", attempts: 0 };
      attachments = reply.attachments ?? [];
      delete reply.body;
      delete reply.attachments;
      delete reply.delivery;
      if (!reply.acceptedAt) delete reply.receipt;
      const notificationDeliveryId = reserveFailure(reply, now);
      return { ok: true, status: "failed", reply: replySummary(reply), notificationDeliveryId, notification: { target: this.notificationTarget, text: reason, deliveryKey: reply.id } };
    });
    try { this.attachmentStore.remove(attachments); } catch { /* committed terminal state prevents replay; sweep retries cleanup */ }
    return result;
  }

  accept(input) {
    const now = this.now();
    const originHost = host(input?.originHost);
    const deliveryId = text(input?.deliveryId, "deliveryId", 64);
    return this.transact(now, (state) => {
      const reply = state.replies.find((item) => item.originHost === originHost && (
        item.completedDeliveryId === deliveryId ||
        item.status === "claimed" && item.delivery?.id === deliveryId
      ));
      if (!reply) return { ok: true, status: "stale" };
      reply.acceptedAt ??= now;
      const receiptDeliveryId = reserveReceipt(reply, now);
      return {
        ok: true,
        status: "accepted",
        reply: replySummary(reply),
        ...(receiptDeliveryId ? {
          receiptDeliveryId,
          reaction: {
            chatId: reply.receipt.chatId,
            messageId: reply.receipt.messageId,
            ...(reply.receipt.participant ? { participant: reply.receipt.participant } : {}),
            emoji: "👍",
          },
        } : {}),
      };
    });
  }

  retryReceipt(input = {}) {
    const now = this.now();
    const originHost = input.originHost ? host(input.originHost) : null;
    return this.transact(now, (state) => {
      for (const reply of state.replies) {
        if (reply.receipt?.status === "sending" && reply.receipt.leaseExpiresAt <= now) {
          if (reply.receipt.attempts >= MAX_SEND_ATTEMPTS) {
            reply.receiptExhaustedAt = now;
            delete reply.receipt;
            continue;
          }
          reply.receipt = {
            chatId: reply.receipt.chatId,
            messageId: reply.receipt.messageId,
            ...(reply.receipt.participant ? { participant: reply.receipt.participant } : {}),
            status: "failed",
            failedAt: now,
            attempts: reply.receipt.attempts,
          };
        }
      }
      const reply = state.replies
        .filter((item) => item.acceptedAt && item.receipt && (!originHost || item.originHost === originHost) && (
          item.receipt.status === "pending" ||
          item.receipt.status === "failed" && item.receipt.failedAt + RETRY_DELAY_MS <= now
        ))
        .sort((a, b) => a.sequence - b.sequence)[0];
      if (!reply) return { ok: true, status: "empty" };
      const receiptDeliveryId = reserveReceipt(reply, now);
      return {
        ok: true,
        status: "sending-receipt",
        reply: replySummary(reply),
        receiptDeliveryId,
        reaction: {
          chatId: reply.receipt.chatId,
          messageId: reply.receipt.messageId,
          ...(reply.receipt.participant ? { participant: reply.receipt.participant } : {}),
          emoji: "👍",
        },
      };
    });
  }

  finishReceipt(input) {
    const now = this.now();
    const replyId = text(input?.replyId, "replyId", 64);
    const deliveryId = text(input?.receiptDeliveryId, "receiptDeliveryId", 64);
    return this.transact(now, (state) => {
      const reply = state.replies.find((item) => item.id === replyId);
      if (!reply || reply.receipt?.status !== "sending" || reply.receipt.deliveryId !== deliveryId) return { ok: true, status: "stale" };
      if (input?.sent === true) {
        reply.receiptSentAt = now;
        delete reply.receipt;
      } else if (reply.receipt.attempts >= MAX_SEND_ATTEMPTS) {
        reply.receiptExhaustedAt = now;
        delete reply.receipt;
      } else {
        reply.receipt = {
          chatId: reply.receipt.chatId,
          messageId: reply.receipt.messageId,
          ...(reply.receipt.participant ? { participant: reply.receipt.participant } : {}),
          status: "failed",
          failedAt: now,
          attempts: reply.receipt.attempts,
        };
      }
      return { ok: input?.sent === true, status: replySummary(reply).receiptStatus, reply: replySummary(reply) };
    });
  }

  retryFailureNotification(input = {}) {
    const now = this.now();
    const originHost = input.originHost ? host(input.originHost) : null;
    return this.transact(now, (state) => {
      for (const reply of state.replies) {
        if (reply.status === "failed" && reply.failureNotification?.status === "sending" && reply.failureNotification.leaseExpiresAt <= now) reply.failureNotification = { status: "exhausted", exhaustedAt: now, attempts: reply.failureNotification.attempts };
      }
      const reply = state.replies.filter((item) => item.status === "failed" && (!originHost || item.originHost === originHost) && item.failureNotification?.status === "failed" && item.failureNotification.attempts < MAX_SEND_ATTEMPTS && item.failureNotification.failedAt + RETRY_DELAY_MS <= now).sort((a, b) => a.sequence - b.sequence)[0];
      if (!reply) return { ok: true, status: "empty" };
      const notificationDeliveryId = reserveFailure(reply, now);
      return { ok: true, status: "sending-failure", reply: replySummary(reply), notificationDeliveryId, notification: { target: this.notificationTarget, text: reply.failureReason, deliveryKey: reply.id } };
    });
  }

  finishFailureNotification(input) {
    const now = this.now();
    const replyId = text(input?.replyId, "replyId", 64);
    const deliveryId = text(input?.notificationDeliveryId, "notificationDeliveryId", 64);
    return this.transact(now, (state) => {
      const reply = state.replies.find((item) => item.id === replyId && item.status === "failed");
      if (!reply || reply.failureNotification?.status !== "sending" || reply.failureNotification.deliveryId !== deliveryId) return { ok: true, status: "stale" };
      if (input?.sent === true) reply.failureNotification = { status: "sent", sentAt: now, attempts: reply.failureNotification.attempts };
      else if (input?.uncertain === true || reply.failureNotification.attempts >= MAX_SEND_ATTEMPTS) reply.failureNotification = { status: "exhausted", exhaustedAt: now, attempts: reply.failureNotification.attempts };
      else reply.failureNotification = { status: "failed", failedAt: now, attempts: reply.failureNotification.attempts };
      return { ok: input?.sent === true, status: reply.failureNotification.status, reply: replySummary(reply) };
    });
  }

  complete(input) {
    const now = this.now();
    const originHost = host(input?.originHost);
    const deliveryId = text(input?.deliveryId, "deliveryId", 64);
    let attachments = [];
    const result = this.transact(now, (state) => {
      const completed = state.replies.find((reply) => reply.originHost === originHost && reply.completedDeliveryId === deliveryId);
      if (completed) return { ok: true, status: "completed", reply: replySummary(completed) };
      const reply = state.replies.find((item) => item.originHost === originHost && item.status === "claimed" && item.delivery?.id === deliveryId);
      if (!reply) return { ok: true, status: "stale" };
      reply.status = "completed";
      reply.completedAt = now;
      reply.acceptedAt ??= now;
      reply.completedDeliveryId = deliveryId;
      attachments = reply.attachments ?? [];
      delete reply.body;
      delete reply.attachments;
      delete reply.delivery;
      return { ok: true, status: "completed", reply: replySummary(reply) };
    });
    try { this.attachmentStore.remove(attachments); } catch { /* committed terminal state prevents replay; sweep retries cleanup */ }
    return result;
  }

  release(input) {
    const now = this.now();
    const originHost = host(input?.originHost);
    const deliveryId = text(input?.deliveryId, "deliveryId", 64);
    return this.transact(now, (state) => {
      const reply = state.replies.find((item) => item.originHost === originHost && item.status === "claimed" && item.delivery?.id === deliveryId);
      if (!reply) return { ok: true, status: "stale" };
      reply.status = "queued";
      delete reply.delivery;
      return { ok: true, status: "released", reply: replySummary(reply) };
    });
  }

  status(input = {}) {
    const now = this.now();
    const originHost = input.originHost ? host(input.originHost) : null;
    const sessionId = input.sessionId ? text(input.sessionId, "sessionId", 128) : null;
    return this.transact(now, (state) => {
      const routes = state.routes.filter((route) => (!originHost || route.originHost === originHost) && (!sessionId || route.sessionId === sessionId));
      const routeIds = new Set(routes.map((route) => route.id));
      const replies = state.replies.filter((reply) => reply.kind === "new-task" ? (!originHost || reply.originHost === originHost) && (!sessionId || reply.sessionId === sessionId) : routeIds.has(reply.routeId));
      const routeCounts = {}, replyCounts = {};
      for (const route of routes) routeCounts[route.notification.status] = (routeCounts[route.notification.status] ?? 0) + 1;
      for (const reply of replies) replyCounts[reply.status] = (replyCounts[reply.status] ?? 0) + 1;
      return { ok: true, status: "ok", routeCounts, replyCounts, taskInboxTarget: this.taskInboxTarget, routes: routes.map(routeSummary), replies: replies.map(replySummary) };
    });
  }
}

export function approvalBrokerFromEnvironment(environment = process.env) {
  const split = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const inboxHost = environment.CODEX_TASK_INBOX_HOST;
  const inboxCwd = environment.CODEX_TASK_INBOX_CWD;
  return new CodexWhatsAppBroker({ statePath: environment.CODEX_WHATSAPP_STATE, allowedSenders: split(environment.CODEX_WHATSAPP_ALLOWED_SENDERS), allowedChats: split(environment.CODEX_WHATSAPP_ALLOWED_CHATS), notificationTarget: environment.CODEX_WHATSAPP_WHATSAPP_TARGET ?? null, taskInboxTarget: inboxHost && inboxCwd ? { originHost: inboxHost, cwd: inboxCwd } : null, attachmentStorePath: environment.CODEX_WHATSAPP_ATTACHMENT_STORE, attachmentSourceRoots: split(environment.CODEX_WHATSAPP_ATTACHMENT_SOURCE_ROOTS) });
}

export async function sendWhatsAppNotification(notification, { bridgeUrl, fetchImpl = globalThis.fetch, timeoutMs = NOTIFICATION_TIMEOUT_MS } = {}) {
  if (!notification || typeof notification !== "object") throw new Error("Notification is invalid");
  const target = text(notification.target, "notification target", 192);
  const messages = Array.isArray(notification.messages)
    ? notification.messages.map((item, index) => text(item, `notification message ${index + 1}`, MAX_FINAL_LENGTH, true))
    : [text(notification.text, "notification text", MAX_FINAL_LENGTH, true)];
  if (messages.length < 1 || messages.length > 2) throw new Error("Notification messages are invalid");
  const deliveryKey = text(notification.deliveryKey, "notification delivery key", 64);
  const deliveryOffset = notification.deliveryOffset ?? 0;
  if (!Number.isSafeInteger(deliveryOffset) || deliveryOffset < 0 || deliveryOffset > 1_000) throw new Error("Notification delivery offset is invalid");
  const url = new URL(text(bridgeUrl, "WhatsApp bridge URL", 512));
  if (url.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) throw new Error("WhatsApp bridge URL must use loopback HTTP");
  url.pathname = "/send";
  let response;
  const validateGroups = (value) => {
    if (!Array.isArray(value) || value.length !== messages.length || value.some((group) => !Array.isArray(group))) return null;
    return value.map((group) => [...new Set(group.map((item) => validMessageId(item)))]);
  };
  try {
    const body = messages.length === 1
      ? { chatId: target, message: messages[0], deliveryKey, deliveryOffset }
      : { chatId: target, messages, deliveryKey, deliveryOffset };
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const error = new Error("WhatsApp notification delivery is uncertain", { cause });
    error.deliveryUncertain = true;
    throw error;
  }
  if (!response?.ok) {
    let failure;
    try { failure = await response.json(); } catch { /* an HTTP rejection before delivery is retryable */ }
    let groups = null;
    try { groups = validateGroups(failure?.messageIdGroups); }
    catch (cause) {
      const error = new Error("WhatsApp bridge returned inconsistent message groups", { cause });
      error.deliveryUncertain = true;
      throw error;
    }
    if (
      messages.length === 2 &&
      failure?.failedMessageIndex === 1 &&
      failure?.failedUncertain !== true &&
      groups && groups[1].length === 0
    ) {
      const error = new Error("WhatsApp bridge rejected the final notification message");
      error.activityMessageIds = groups[0];
      throw error;
    }
    if (Array.isArray(failure?.messageIds) && failure.messageIds.length > 0) {
      let messageIds;
      try { messageIds = [...new Set(failure.messageIds.map((item) => validMessageId(item)))]; }
      catch (cause) {
        const error = new Error("WhatsApp bridge returned inconsistent partial message IDs", { cause });
        error.deliveryUncertain = true;
        throw error;
      }
      return { ok: true, status: "partial", messageIds };
    }
    throw new Error("WhatsApp bridge rejected the notification");
  }
  let payload;
  try { payload = await response.json(); } catch (cause) {
    const error = new Error("WhatsApp bridge returned an invalid notification result", { cause });
    error.deliveryUncertain = true;
    throw error;
  }
  if (!Array.isArray(payload?.messageIds) || payload.messageIds.length === 0) {
    const error = new Error("WhatsApp bridge did not confirm message IDs");
    error.deliveryUncertain = true;
    throw error;
  }
  let messageIds;
  try {
    messageIds = [...new Set(payload.messageIds.map((item) => validMessageId(item)))];
    const groups = validateGroups(payload.messageIdGroups);
    if (messages.length === 2 && (!groups || groups[1].length === 0)) throw new Error("final message was not confirmed");
    if (payload.messageId && !messageIds.includes(validMessageId(payload.messageId))) {
      throw new Error("inconsistent message IDs");
    }
  } catch (cause) {
    const error = new Error("WhatsApp bridge returned inconsistent message IDs", { cause });
    error.deliveryUncertain = true;
    throw error;
  }
  return { ok: true, status: "sent", messageIds };
}

export async function sendWhatsAppReaction(reaction, { bridgeUrl, fetchImpl = globalThis.fetch, timeoutMs = RECEIPT_TIMEOUT_MS } = {}) {
  if (!reaction || typeof reaction !== "object") throw new Error("Reaction is invalid");
  const chatId = jid(reaction.chatId);
  const messageId = validMessageId(reaction.messageId);
  const participant = reaction.participant === undefined ? null : jid(reaction.participant);
  if (!chatId || reaction.participant !== undefined && !participant) throw new Error("Reaction target is invalid");
  const emoji = text(reaction.emoji, "reaction emoji", 16);
  const url = new URL(text(bridgeUrl, "WhatsApp bridge URL", 512));
  if (url.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) throw new Error("WhatsApp bridge URL must use loopback HTTP");
  url.pathname = "/react";
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, messageId, emoji, ...(participant ? { participant } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new Error("WhatsApp reaction delivery failed", { cause });
  }
  if (!response?.ok) throw new Error("WhatsApp bridge rejected the reaction");
  let payload;
  try { payload = await response.json(); } catch (cause) { throw new Error("WhatsApp bridge returned an invalid reaction result", { cause }); }
  if (payload?.success !== true) throw new Error("WhatsApp bridge did not confirm the reaction");
  return { ok: true, status: "sent" };
}
