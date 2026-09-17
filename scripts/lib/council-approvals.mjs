import fs from "node:fs";
import path from "node:path";

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const JID = /^[0-9]{1,32}(?:-[0-9]{1,32})?@(g\.us|s\.whatsapp\.net|lid)$/i;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const OWNER_MARKER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PERMIT_KEYS = ["caseId", "rev", "digest", "scope", "issuedBy", "issuedAt", "expiresAt"];
const PERMIT_ID = /^[A-Za-z0-9_-]{22,256}$/;

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
    if (!response.ok) throw new Error(`Council request failed (${response.status})`);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Council returned invalid data");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function workspaceRequest(configured, extra = {}) {
  return { ...extra, headers: { "x-council-workspace": configured.workspace, ...(extra.headers ?? {}) } };
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
  const dashboard = await fetcher(`${configured.councilUrl}/api/dashboard?workspace=${encodeURIComponent(configured.workspace)}`, token, workspaceRequest(configured));
  const pending = Array.isArray(dashboard.pendingDecisions) ? dashboard.pendingDecisions : [];
  const proposal = pending.find((item) => item?.caseId === approval.caseId && item?.rev === approval.rev);
  if (!proposal || proposal.superseded === true) return { ok: false, message: `No pending Council proposal matches ${approval.caseId} rev ${approval.rev}.` };
  if (typeof proposal.digest !== "string" || !DIGEST.test(proposal.digest) || proposal.digest.toLowerCase() !== approval.digest) return { ok: false, message: "Digest mismatch; no decision was recorded." };
  const permitResponse = await fetcher(`${configured.councilUrl}/api/whatsapp/permit?workspace=${encodeURIComponent(configured.workspace)}&caseId=${encodeURIComponent(approval.caseId)}&rev=${approval.rev}&digest=${approval.digest}`, token, workspaceRequest(configured));
  const permitSource = permitResponse?.whatsappPermit && typeof permitResponse.whatsappPermit === "object" ? permitResponse.whatsappPermit : permitResponse?.permit && typeof permitResponse.permit === "object" ? permitResponse.permit : permitResponse;
  const { permitId: _permitId, ...permit } = permitSource && typeof permitSource === "object" ? permitSource : {};
  if (!isCurrentWhatsappPermit(permit, { caseId: approval.caseId, rev: approval.rev, digest: approval.digest, scope: configured.scope })) return { ok: false, message: "No current owner-issued WhatsApp permit matches this proposal." };
  const permitId = typeof permitResponse?.permitId === "string" ? permitResponse.permitId.trim() : typeof permit?.permitId === "string" ? permit.permitId.trim() : "";
  if (!PERMIT_ID.test(permitId)) return { ok: false, message: "No current Council permit reference is available." };
  const requestId = `whatsapp-approval:${chatId}:${messageId}:${approval.caseId}:${approval.rev}:${approval.digest}`;
  try {
    const result = await fetcher(`${configured.councilUrl}/api/whatsapp/decision`, token, workspaceRequest(configured, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ requestId, caseId: approval.caseId, rev: approval.rev, verdict: approval.verdict, scope: configured.scope, permitId }),
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
      if (decision && decision.caseId === approval.caseId && decision.rev === approval.rev && decision.verdict === approval.verdict && decision.scope === configured.scope) {
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
    if (decision && decision.caseId === approval.caseId && decision.rev === approval.rev && decision.verdict === approval.verdict && decision.scope === configured.scope) {
      return { ok: true, recovered: true, message: `Council ${approval.verdict} recorded for ${approval.caseId} rev ${approval.rev}.`, result: readback };
    }
  } catch {
    // A missing or unavailable readback is not evidence that the decision failed.
  }
  return { ok: false, message: "Council approval outcome is uncertain; no exact decision readback was available." };
}

export { configuredApproval };
