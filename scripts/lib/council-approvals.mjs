import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const JID = /^[0-9]{1,32}(?:-[0-9]{1,32})?@(g\.us|s\.whatsapp\.net|lid)$/i;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const OWNER_MARKER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PERMIT_KEYS = ["caseId", "rev", "digest", "scope", "issuedBy", "issuedAt", "expiresAt"];
const PERMIT_ID = /^[A-Za-z0-9_-]{22,256}$/;
const POLL_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;

function stablePollRequestId(pollMessageId, messageId, verdict) {
  const digest = createHash("sha256").update(`${messageId}\n${pollMessageId}\n${verdict}`).digest("hex").slice(0, 48);
  return `council-poll-vote:${digest}`;
}

function normalizeJid(value, group = false) {
  const text = String(value ?? "").trim();
  if (!JID.test(text)) return null;
  if (group !== text.toLowerCase().endsWith("@g.us")) return null;
  return text.toLowerCase();
}

export function parseCouncilApproval(value) {
  const text = String(value ?? "").trim();
  const match = /^(APPROVE|REJECT) ([A-Za-z0-9][A-Za-z0-9_-]{0,63}) REV ([1-9][0-9]{0,8}) DIGEST ([a-f0-9]{64})$/.exec(text);
  if (!match) return null;
  const [, verdict, caseId, revision, digest] = match;
  if (!CASE_ID.test(caseId) || !DIGEST.test(digest)) return null;
  return { verdict: verdict === "APPROVE" ? "approved" : "rejected", caseId, rev: Number(revision), digest: digest.toLowerCase() };
}

function configuredApproval(config) {
  const value = config?.councilApprovals;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const chatId = String(value.chatId ?? "").trim();
  const allowedSenders = Array.isArray(value.allowedSenders) ? value.allowedSenders.map((v) => String(v).trim()).filter(Boolean) : [];
  const councilUrl = String(value.councilUrl ?? "").trim().replace(/\/$/, "");
  const credentialFile = value.codexCredentialFile == null ? "" : String(value.codexCredentialFile).trim();
  const tokenEnv = value.codexTokenEnv == null ? "" : String(value.codexTokenEnv).trim();
  const scope = String(value.scope ?? "design").trim();
  const workspace = String(value.workspace ?? "").trim();
  if (!chatId || !allowedSenders.length || !/^https:\/\//i.test(councilUrl) || (!credentialFile && !tokenEnv) || (credentialFile && tokenEnv)) return null;
  if (tokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) return null;
  if (credentialFile && !path.isAbsolute(credentialFile)) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(scope) || !/^[A-Za-z0-9_-]{1,64}$/.test(workspace)) return null;
  return { chatId, allowedSenders, councilUrl, credentialFile, tokenEnv, scope, workspace };
}

export function readBearerCredential(options) {
  const { credentialFile, tokenEnv } = options;
  if (tokenEnv) {
    const token = process.env[tokenEnv];
    if (!token || !String(token).trim()) throw new Error("Codex Council credential is unavailable");
    return String(token).trim();
  }
  let stat;
  try {
    stat = fs.lstatSync(credentialFile);
  } catch {
    throw new Error("Codex Council credential is unavailable");
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Codex Council credential file must be a private owner-readable file");
  const token = fs.readFileSync(credentialFile, "utf8").trim();
  if (!token || token.length > 4096 || /\s/.test(token)) throw new Error("Codex Council credential is invalid");
  return token;
}

async function councilJson(url, token, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.headers ?? {}) },
    });
    let data = null;
    try { data = await response.json(); } catch { /* normalized below */ }
    if (!response.ok) { const error = new Error(`Council request failed (${response.status})`); error.status = response.status; throw error; }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Council returned invalid data");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function workspaceRequest(configured, extra = {}) {
  return { ...extra, headers: { "x-council-workspace": configured.workspace, ...(extra.headers ?? {}) } };
}

function councilDecision(value) {
  return value?.decision && typeof value.decision === "object" ? value.decision : value;
}

function exactDecision(decision, { caseId, rev, scope }) {
  return decision && decision.caseId === caseId && decision.rev === rev && decision.scope === scope && (decision.verdict === "approved" || decision.verdict === "rejected");
}

function exactDecisionAnyScope(decision, { caseId, rev }) {
  return decision && decision.caseId === caseId && decision.rev === rev
    && typeof decision.scope === "string" && /^[A-Za-z0-9._*:/-]{1,128}$/.test(decision.scope)
    && (decision.verdict === "approved" || decision.verdict === "rejected");
}

function exactPollStatus(status, { pollId, scope }) {
  return status?.registered === true
    && status.pollId === pollId
    && typeof status.caseId === "string"
    && CASE_ID.test(status.caseId)
    && Number.isSafeInteger(status.rev)
    && status.rev > 0
    && typeof status.digest === "string"
    && DIGEST.test(status.digest)
    && status.digest === status.digest.toLowerCase()
    && status.scope === scope
    && /^[A-Za-z0-9._*:/-]{1,128}$/.test(status.scope)
    && new Set(["active", "consumed", "expired", "stale"]).has(status.status)
    && (status.status !== "consumed" || Number.isFinite(Date.parse(String(status.consumedAt))))
    && (status.decisionChannel === undefined || new Set(["portal", "whatsapp"]).has(status.decisionChannel));
}

function samePollBinding(left, right) {
  return left.pollId === right.pollId
    && left.caseId === right.caseId
    && left.rev === right.rev
    && left.digest === right.digest
    && left.scope === right.scope;
}

function exactPollDecision(decision, pollStatus, pollId, scope) {
  return decision
    && decision.pollId === pollId
    && decision.caseId === pollStatus.caseId
    && decision.rev === pollStatus.rev
    && typeof decision.digest === "string"
    && DIGEST.test(decision.digest)
    && decision.digest.toLowerCase() === pollStatus.digest
    && decision.scope === scope
    && decision.scope === pollStatus.scope
    && (decision.verdict === "approved" || decision.verdict === "rejected");
}

async function readExactPollDecision(pollMessageId, pollStatus, configured, token, fetcher, requestId = "") {
  const readback = await fetcher(`${configured.councilUrl}/api/whatsapp/poll/decision?workspace=${encodeURIComponent(configured.workspace)}&pollId=${encodeURIComponent(pollMessageId)}`, token, workspaceRequest(configured, requestId ? { headers: { "x-request-id": requestId } } : {}));
  const decision = councilDecision(readback);
  if (!exactPollDecision(decision, pollStatus, pollMessageId, pollStatus.scope)) throw new Error("Council returned invalid poll decision readback");
  return decision;
}

async function readExactConsumedPollStatus(statusUrl, pollMessageId, pollStatus, configured, token, fetcher, requestId = "") {
  const refreshed = await fetcher(statusUrl, token, workspaceRequest(configured, requestId ? { headers: { "x-request-id": requestId } } : {}));
  if (!exactPollStatus(refreshed, { pollId: pollMessageId, scope: pollStatus.scope }) || !samePollBinding(refreshed, pollStatus) || refreshed.status !== "consumed") {
    throw new Error("Council poll consumption was not confirmed");
  }
  return refreshed;
}

async function readExistingCouncilDecision(approval, configured, token, fetcher) {
  const url = `${configured.councilUrl}/api/whatsapp/decision?workspace=${encodeURIComponent(configured.workspace)}&caseId=${encodeURIComponent(approval.caseId)}&rev=${approval.rev}&digest=${approval.digest}`;
  try {
    const response = await fetcher(url, token, workspaceRequest(configured));
    const decision = councilDecision(response);
    if (!exactDecisionAnyScope(decision, { caseId: approval.caseId, rev: approval.rev })) throw new Error("Council returned invalid decision readback");
    return decision;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export function isCurrentWhatsappPermit(permit, { caseId, rev, digest, scope, nowMs = Date.now() } = {}) {
  if (!permit || typeof permit !== "object" || Array.isArray(permit)) return false;
  if (Object.keys(permit).length !== PERMIT_KEYS.length || PERMIT_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(permit, key))) return false;
  if (permit.caseId !== caseId || permit.rev !== rev || typeof permit.digest !== "string" || !DIGEST.test(permit.digest) || permit.digest.toLowerCase() !== String(digest).toLowerCase()) return false;
  if (typeof permit.scope !== "string" || permit.scope !== scope || !/^[A-Za-z0-9._*:/-]{1,128}$/.test(permit.scope)) return false;
  if (typeof permit.issuedBy !== "string" || !OWNER_MARKER.test(permit.issuedBy.trim())) return false;
  const issuedAt = Date.parse(String(permit.issuedAt));
  const expiresAt = Date.parse(String(permit.expiresAt));
  return Number.isFinite(issuedAt) && issuedAt <= nowMs && Number.isFinite(expiresAt) && expiresAt > nowMs;
}

export async function processCouncilApproval(text, config, { fetcher = councilJson, context = null } = {}) {
  const approval = parseCouncilApproval(text);
  if (!approval) return { ok: false, message: "Use exactly: APPROVE|REJECT case_id REV n DIGEST sha256" };
  const configured = configuredApproval(config);
  if (!configured) return { ok: false, message: "Council Approvals is not configured." };
  if (config?.councilPush?.enabled === true && String(config.councilPush.workspace ?? "default") !== configured.workspace) return { ok: false, message: "Council approval and push workspaces do not match." };
  const chatId = normalizeJid(context?.chatId, true);
  const senderId = normalizeJid(context?.senderId, false);
  const messageId = String(context?.messageId ?? "").trim();
  const allowedSenders = configured.allowedSenders.map((value) => normalizeJid(value, false));
  if (!chatId || chatId !== normalizeJid(configured.chatId, true) || !senderId || !allowedSenders.includes(senderId) || !MESSAGE_ID.test(messageId)) {
    return { ok: false, message: "Council approval sender or message identity is not allowed." };
  }
  const token = readBearerCredential(configured);
  const existing = await readExistingCouncilDecision(approval, configured, token, fetcher);
  if (existing) {
    if (existing.verdict === approval.verdict) return { ok: true, duplicate: true, message: `Council ${approval.verdict} was already recorded for ${approval.caseId} rev ${approval.rev}.`, result: existing };
    return { ok: false, message: `Council ${existing.verdict} is already recorded for ${approval.caseId} rev ${approval.rev}; no change was made.` };
  }
  const permitResponse = await fetcher(`${configured.councilUrl}/api/whatsapp/permit?workspace=${encodeURIComponent(configured.workspace)}&caseId=${encodeURIComponent(approval.caseId)}&rev=${approval.rev}&digest=${approval.digest}`, token, workspaceRequest(configured));
  const permitSource = permitResponse?.whatsappPermit && typeof permitResponse.whatsappPermit === "object" ? permitResponse.whatsappPermit : permitResponse?.permit && typeof permitResponse.permit === "object" ? permitResponse.permit : permitResponse;
  const { permitId: _permitId, ...permit } = permitSource && typeof permitSource === "object" ? permitSource : {};
  const permitScope = typeof permit?.scope === "string" && /^[A-Za-z0-9._*:/-]{1,128}$/.test(permit.scope) ? permit.scope : null;
  if (!permitScope || !isCurrentWhatsappPermit(permit, { caseId: approval.caseId, rev: approval.rev, digest: approval.digest, scope: permitScope })) return { ok: false, message: "No current owner-issued WhatsApp permit matches this proposal." };
  const permitId = typeof permitResponse?.permitId === "string" ? permitResponse.permitId.trim() : typeof permit?.permitId === "string" ? permit.permitId.trim() : "";
  if (!PERMIT_ID.test(permitId)) return { ok: false, message: "No current Council permit reference is available." };
  const requestId = `whatsapp-approval:${chatId}:${messageId}:${approval.caseId}:${approval.rev}:${approval.digest}`;
  try {
    const result = await fetcher(`${configured.councilUrl}/api/whatsapp/decision`, token, workspaceRequest(configured, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ requestId, caseId: approval.caseId, rev: approval.rev, verdict: approval.verdict, scope: permitScope, permitId }),
    }));
    return { ok: true, message: `Council ${approval.verdict} recorded for ${approval.caseId} rev ${approval.rev}.`, result };
  } catch (error) {
    // A bounded POST may have committed before its transport response was lost.
    // Read the exact Council decision with the same identity; never consult a
    // local Codex admission store or infer success from the timeout.
    try {
      const readback = await fetcher(`${configured.councilUrl}/api/whatsapp/decision?workspace=${encodeURIComponent(configured.workspace)}&caseId=${encodeURIComponent(approval.caseId)}&rev=${approval.rev}&digest=${approval.digest}`, token, workspaceRequest(configured, {
        headers: { "x-request-id": requestId, "x-council-request-id": requestId },
      }));
      const decision = readback?.decision && typeof readback.decision === "object" ? readback.decision : readback;
      if (decision && decision.caseId === approval.caseId && decision.rev === approval.rev && decision.verdict === approval.verdict && decision.scope === permitScope) {
        return { ok: true, recovered: true, message: `Council ${approval.verdict} recorded for ${approval.caseId} rev ${approval.rev}.`, result: readback };
      }
    } catch {
      // Preserve the original uncertainty; the owner can retry the same stable command.
    }
    throw new Error(`Council decision outcome is uncertain; exact readback failed (${error?.message ?? "request failure"})`);
  }
}

export async function recoverCouncilApproval(text, config, { fetcher = councilJson, context = null } = {}) {
  const approval = parseCouncilApproval(text);
  const configured = configuredApproval(config);
  if (!approval || !configured) return { ok: false, message: "Council approval outcome is not recoverable." };
  if (config?.councilPush?.enabled === true && String(config.councilPush.workspace ?? "default") !== configured.workspace) return { ok: false, message: "Council approval and push workspaces do not match." };
  const chatId = normalizeJid(context?.chatId, true);
  const senderId = normalizeJid(context?.senderId, false);
  const messageId = String(context?.messageId ?? "").trim();
  const allowedSenders = configured.allowedSenders.map((value) => normalizeJid(value, false));
  if (!chatId || chatId !== normalizeJid(configured.chatId, true) || !senderId || !allowedSenders.includes(senderId) || !MESSAGE_ID.test(messageId)) return { ok: false, message: "Council approval outcome is not recoverable." };
  const requestId = `whatsapp-approval:${chatId}:${messageId}:${approval.caseId}:${approval.rev}:${approval.digest}`;
  const token = readBearerCredential(configured);
  try {
    const readback = await fetcher(`${configured.councilUrl}/api/whatsapp/decision?workspace=${encodeURIComponent(configured.workspace)}&caseId=${encodeURIComponent(approval.caseId)}&rev=${approval.rev}&digest=${approval.digest}`, token, workspaceRequest(configured, {
      headers: { "x-request-id": requestId, "x-council-request-id": requestId },
    }));
    const decision = readback?.decision && typeof readback.decision === "object" ? readback.decision : readback;
    if (decision && decision.caseId === approval.caseId && decision.rev === approval.rev && decision.verdict === approval.verdict && typeof decision.scope === "string" && /^[A-Za-z0-9._*:/-]{1,128}$/.test(decision.scope)) {
      return { ok: true, recovered: true, message: `Council ${approval.verdict} recorded for ${approval.caseId} rev ${approval.rev}.`, result: readback };
    }
  } catch {
    // A missing or unavailable readback is not evidence that the decision failed.
  }
  return { ok: false, message: "Council approval outcome is uncertain; no exact decision readback was available." };
}

export async function processCouncilPollVote(payload, config, { fetcher = councilJson, registrationWaitMs = 15_000 } = {}) {
  const configured = configuredApproval(config);
  if (!configured || config?.councilApprovals?.nativePolls !== true) return { ok: false, status: "ignored", message: "Native Council polls are not configured." };
  const chatId = normalizeJid(payload?.chatId, true);
  const senderId = normalizeJid(payload?.senderId, false);
  const messageId = String(payload?.messageId ?? "").trim();
  const pollMessageId = String(payload?.pollMessageId ?? "").trim();
  const allowedSenders = configured.allowedSenders.map((value) => normalizeJid(value, false));
  const selectedOptions = Array.isArray(payload?.selectedOptions) ? payload.selectedOptions.map((value) => String(value).trim()) : [];
  if (!chatId || chatId !== normalizeJid(configured.chatId, true) || !senderId || !allowedSenders.includes(senderId) || !MESSAGE_ID.test(messageId) || !POLL_MESSAGE_ID.test(pollMessageId) || selectedOptions.length !== 1 || !new Set(["Approve", "Reject"]).has(selectedOptions[0])) {
    return { ok: false, status: "rejected", message: "This Council poll vote is not valid for the configured owner chat." };
  }
  const token = readBearerCredential(configured);
  const statusUrl = `${configured.councilUrl}/api/whatsapp/poll/status?workspace=${encodeURIComponent(configured.workspace)}&pollId=${encodeURIComponent(pollMessageId)}`;
  let pollStatus;
  const registrationAttempts = Math.max(1, Math.ceil(registrationWaitMs / 100));
  for (let attempt = 0; attempt < registrationAttempts; attempt += 1) {
    try { pollStatus = await fetcher(statusUrl, token, workspaceRequest(configured)); break; }
    catch (error) {
      if (error?.status === 404) { if (attempt + 1 < registrationAttempts) await new Promise((resolve) => setTimeout(resolve, 100)); else return { ok: false, status: "unclaimed", message: "This poll is not a registered Council approval." }; }
      else throw new Error(`Council poll status is uncertain; decision was not attempted (${error?.message ?? "request failure"})`);
    }
  }
  if (!pollStatus || pollStatus.registered !== true) return { ok: false, status: "unclaimed", message: "This poll is not a registered Council approval." };
  const pollScope = typeof pollStatus.scope === "string" && /^[A-Za-z0-9._*:/-]{1,128}$/.test(pollStatus.scope) ? pollStatus.scope : null;
  if (!pollScope || !exactPollStatus(pollStatus, { pollId: pollMessageId, scope: pollScope })) return { ok: false, status: "bound-failed", message: "This Council poll registration is not exactly bound; no decision was recorded." };
  const verdict = selectedOptions[0] === "Approve" ? "approved" : "rejected";
  if (pollStatus.status === "consumed") {
    try {
      const decision = await readExactPollDecision(pollMessageId, pollStatus, configured, token, fetcher);
      if (decision.verdict === verdict) return { ok: true, status: "accepted", duplicate: true, message: pollStatus.decisionChannel === "portal" ? `Council ${decision.verdict} was already recorded in the portal; this poll vote made no change.` : "Council poll decision was already recorded." };
      return { ok: false, status: "bound-failed", message: `This Council poll already recorded ${decision.verdict}; no change was made.` };
    } catch (error) {
      throw new Error(`Council poll decision status is uncertain; exact readback failed (${error?.message ?? "request failure"})`);
    }
  }
  if (pollStatus.status !== "active") return { ok: false, status: "bound-failed", message: `This Council poll is ${pollStatus.status}; no decision was recorded.` };
  const requestId = stablePollRequestId(pollMessageId, messageId, verdict);
  let result;
  try {
    result = await fetcher(`${configured.councilUrl}/api/whatsapp/poll/decision`, token, workspaceRequest(configured, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ pollId: pollMessageId, verdict }) }));
  } catch (error) {
    try {
      const decision = await readExactPollDecision(pollMessageId, pollStatus, configured, token, fetcher, requestId);
      await readExactConsumedPollStatus(statusUrl, pollMessageId, pollStatus, configured, token, fetcher, requestId);
      if (decision.verdict === verdict) return { ok: true, status: "accepted", recovered: true, message: "Council poll decision was recorded." };
      return { ok: false, status: "bound-failed", message: `This Council poll already recorded ${decision.verdict}; no change was made.` };
    } catch { /* preserve uncertainty below */ }
    throw new Error(`Council poll decision outcome is uncertain; exact readback failed (${error?.message ?? "request failure"})`);
  }
  let decision;
  try {
    decision = await readExactPollDecision(pollMessageId, pollStatus, configured, token, fetcher, requestId);
    await readExactConsumedPollStatus(statusUrl, pollMessageId, pollStatus, configured, token, fetcher, requestId);
  } catch (error) {
    throw new Error(`Council poll decision outcome is uncertain; exact readback failed (${error?.message ?? "request failure"})`);
  }
  if (decision.verdict !== verdict) return { ok: false, status: "bound-failed", message: `This Council poll already recorded ${decision.verdict}; no change was made.` };
  const acknowledgement = result?.acknowledgement;
  return { ok: true, status: "accepted", message: typeof acknowledgement === "string" && acknowledgement.trim() ? acknowledgement.slice(0, 500) : `Council ${selectedOptions[0].toLowerCase()} vote recorded.` };
}

export { configuredApproval };
