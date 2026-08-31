#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bridgePaths,
  codexBinaryPath,
  isGatewayHost,
  readConfig,
} from "./lib/runtime-config.mjs";
import { bridgeHookTrustStatus, canonicalPath } from "./lib/codex-hooks.mjs";
import {
  CodexActiveWriterError,
  CodexAttentionRequiredError,
  CodexTaskBusyError,
  CodexThreadStartUncertainError,
  CodexTurnStartUncertainError,
  codexTaskTitle,
  runCodexAppServerTurn,
} from "./lib/codex-app-server.mjs";
import { parseJson, run } from "./lib/process.mjs";
import {
  attachmentFingerprint,
  validateAttachmentRecords,
  verifyMaterializedAttachment,
} from "./lib/attachments.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installedConfig = readConfig({ required: false });
const runtimeConfig = installedConfig ?? {
  schemaVersion: 1,
  role: "combined",
  hostId: "unconfigured",
  gateway: { repositoryPath: repositoryRoot, node: process.execPath },
  whatsapp: {},
  codex: { mirrorProgress: false },
  codexInbox: null,
};
const configuredPaths = bridgePaths(runtimeConfig);
const statePath = process.env.CODEX_WHATSAPP_CLIENT_STATE ?? configuredPaths.clientState;
const stateDirectory = path.dirname(statePath);
const lockPath = path.join(stateDirectory, "state.lock");
const deliveryLockPath = path.join(stateDirectory, "delivery.lock");
const deliveryLockStaleMs = 90 * 60 * 1_000;
const remoteHost = process.env.CODEX_WHATSAPP_GATEWAY_SSH_HOST ?? runtimeConfig.gateway?.sshHost ?? "";
const remoteLanHost = process.env.CODEX_WHATSAPP_GATEWAY_LAN_HOST ?? runtimeConfig.gateway?.lanHost ?? "";
const remoteHostKeyAlias = process.env.CODEX_WHATSAPP_GATEWAY_HOST_KEY_ALIAS ?? runtimeConfig.gateway?.hostKeyAlias ?? "";
const remoteNode = process.env.CODEX_WHATSAPP_GATEWAY_NODE ?? runtimeConfig.gateway?.node ?? "/opt/homebrew/opt/node@24/bin/node";
const remoteBroker = process.env.CODEX_WHATSAPP_GATEWAY_BROKER ?? configuredPaths.brokerScript;
const localBroker = path.join(repositoryRoot, "scripts", "codex-whatsapp-broker.mjs");
const hooksPath = path.join(os.homedir(), ".codex", "hooks.json");
const sessionsRoot = path.join(path.dirname(hooksPath), "sessions");
const codexDatabase = process.env.CODEX_WHATSAPP_CODEX_DB ?? path.join(path.dirname(hooksPath), "state_5.sqlite");
const hookCommand = `${process.execPath} ${path.join(repositoryRoot, "scripts", "codex-whatsapp-client.mjs")} hook`;
const maximumTranscriptTail = 2 * 1024 * 1024;
const maximumActivityMessageLength = 3_900;
const maximumFinalMessageLength = 48_000;
const executionRetentionMs = 48 * 60 * 60 * 1_000;
const activeWriterUncertaintyMs = 2 * 60 * 1_000;
const activeWriterRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const localAttachmentRoot = process.env.CODEX_WHATSAPP_CLIENT_ATTACHMENTS ?? configuredPaths.clientAttachments;
const serverAttachmentRoot = process.env.CODEX_WHATSAPP_BROKER_ATTACHMENTS ?? configuredPaths.brokerAttachments;
const remoteAttachmentRoot = process.env.CODEX_WHATSAPP_GATEWAY_ATTACHMENTS ?? runtimeConfig.gateway?.attachmentPath ?? configuredPaths.brokerAttachments;

function emptyState() {
  return { schemaVersion: 4, executions: {}, activeWriterDeliveries: {} };
}

export function normalizeState(parsed) {
  if (!parsed || parsed.schemaVersion !== 4 || typeof parsed.executions !== "object" || Array.isArray(parsed.executions)) return emptyState();
  const activeWriterDeliveries = typeof parsed.activeWriterDeliveries === "object" && !Array.isArray(parsed.activeWriterDeliveries)
    ? parsed.activeWriterDeliveries
    : {};
  return { ...emptyState(), ...parsed, activeWriterDeliveries };
}

function readState() {
  if (!fs.existsSync(statePath)) return emptyState();
  try { return normalizeState(JSON.parse(fs.readFileSync(statePath, "utf8"))); } catch { return emptyState(); }
}

function writeState(state) {
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDirectory, 0o700);
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
  fs.chmodSync(statePath, 0o600);
}

function withStateLock(callback) {
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(lockPath, { mode: 0o700 }); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (Date.now() - fs.statSync(lockPath).mtimeMs < 60_000) throw new Error("Codex WhatsApp client state is busy");
    fs.rmdirSync(lockPath);
    fs.mkdirSync(lockPath, { mode: 0o700 });
  }
  try {
    const state = readState();
    const result = callback(state);
    writeState(state);
    return result;
  } finally { fs.rmdirSync(lockPath); }
}

export function hostId() {
  return process.env.CODEX_WHATSAPP_HOST ?? runtimeConfig.hostId;
}

function readTail(target) {
  const descriptor = fs.openSync(target, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const start = Math.max(0, size - maximumTranscriptTail);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    const body = buffer.toString("utf8");
    return start === 0 ? body : body.slice(Math.max(0, body.indexOf("\n") + 1));
  } finally { fs.closeSync(descriptor); }
}

function assistantText(record) {
  const payload = record?.payload;
  if (record?.type !== "response_item" || payload?.type !== "message" || payload.role !== "assistant") return null;
  return (payload.content ?? []).map((part) => typeof part?.text === "string" ? part.text : "").join("");
}

function userPrompt(payload) {
  const value = payload?.prompt ?? payload?.user_prompt ?? payload?.userPrompt;
  return typeof value === "string" ? value : null;
}

function normalizedPrompt(value) {
  return String(value ?? "").trimEnd();
}

function promptDigest(value) {
  return createHash("sha256").update(normalizedPrompt(value)).digest("hex");
}

function recordTurnId(record) {
  return record?.payload?.internal_chat_message_metadata_passthrough?.turn_id ??
    record?.payload?.turn_id ?? null;
}

function assistantPhase(record) {
  const payload = record?.payload;
  return record?.type === "response_item" && payload?.type === "message" && payload.role === "assistant"
    ? payload.phase ?? null
    : null;
}

export function visibleTurnUpdates(transcriptText, turnId) {
  const updates = [];
  let activeTurn = null;
  for (const line of String(transcriptText).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJson(line);
    if (!parsed.ok) continue;
    const record = parsed.value;
    if (record?.type === "event_msg" && record.payload?.type === "task_started") {
      activeTurn = record.payload.turn_id ?? null;
      continue;
    }
    if (assistantPhase(record) !== "commentary") continue;
    const messageTurn = recordTurnId(record);
    if (messageTurn ? messageTurn !== turnId : activeTurn !== turnId) continue;
    const update = assistantText(record)?.trim();
    if (update && updates.at(-1) !== update) updates.push(update);
  }
  return updates;
}

export function transcriptWorkingDirectory(transcriptText) {
  for (const line of String(transcriptText).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJson(line);
    if (parsed.ok && parsed.value?.type === "session_meta") {
      const cwd = parsed.value.payload?.cwd;
      return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
    }
  }
  return null;
}

export function latestAssistantText(transcriptText) {
  let latest = null;
  for (const line of String(transcriptText).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJson(line);
    if (!parsed.ok) continue;
    const candidate = assistantText(parsed.value);
    if (candidate !== null) latest = candidate;
  }
  return latest;
}

export function isInternalSuggestionsEnvelope(value) {
  const parsed = parseJson(String(value).trim());
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return false;
  const suggestions = parsed.value.suggestions;
  return Array.isArray(suggestions) && suggestions.length > 0 && suggestions.every((suggestion) =>
    suggestion && typeof suggestion === "object" && !Array.isArray(suggestion) &&
    typeof suggestion.title === "string" && typeof suggestion.description === "string" &&
    typeof suggestion.prompt === "string" &&
    (Object.hasOwn(suggestion, "appId") || Object.hasOwn(suggestion, "pluginId"))
  );
}

export function isInternalExclusionEnvelope(value) {
  const parsed = parseJson(String(value).trim());
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return false;
  if (Object.keys(parsed.value).length !== 1 || !Array.isArray(parsed.value.exclude)) return false;
  return parsed.value.exclude.every((item) =>
    item && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).length === 2 &&
    /^suggestion-[0-9]+$/.test(item.id) &&
    typeof item.reason === "string" && item.reason.trim().length > 0
  );
}

export function isInternalSelectionEnvelope(value) {
  return isInternalSuggestionsEnvelope(value) || isInternalExclusionEnvelope(value);
}

export function persistedCodexSessionExists(sessionId, root = sessionsRoot) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(sessionId))) return false;
  const expectedSuffix = `-${String(sessionId).toLowerCase()}.jsonl`;
  try {
    for (const year of fs.readdirSync(root, { withFileTypes: true })) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const yearPath = path.join(root, year.name);
      for (const month of fs.readdirSync(yearPath, { withFileTypes: true })) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        const monthPath = path.join(yearPath, month.name);
        for (const day of fs.readdirSync(monthPath, { withFileTypes: true })) {
          if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
          const dayPath = path.join(monthPath, day.name);
          if (fs.readdirSync(dayPath).some((name) => name.toLowerCase().endsWith(expectedSuffix))) return true;
        }
      }
    }
  } catch { return false; }
  return false;
}

export function normalizeStopHookPayload(payload) {
  return {
    stopHookActive: payload.stop_hook_active ?? payload.stopHookActive,
    sessionId: payload.session_id ?? payload.sessionId,
    turnId: payload.turn_id ?? payload.turnId,
    transcript: payload.transcript_path ?? payload.transcriptPath,
    lastAssistantMessage: payload.last_assistant_message ?? payload.lastAssistantMessage,
  };
}

export function turnFromStopPayload(payload, transcriptReader = readTail, sessionFinder = persistedCodexSessionExists) {
  const normalized = normalizeStopHookPayload(payload);
  if (normalized.stopHookActive === true) return { status: "ignored-recursive" };
  if (![normalized.sessionId, normalized.turnId].every((value) => typeof value === "string" && value)) return { status: "invalid-payload" };
  let transcriptText = "";
  let persistedFinal = "";
  if (typeof normalized.transcript === "string" && normalized.transcript) {
    try {
      transcriptText = transcriptReader(normalized.transcript);
      persistedFinal = String(latestAssistantText(transcriptText) ?? "");
    } catch { /* last_assistant_message remains authoritative */ }
  }
  const finalText = typeof normalized.lastAssistantMessage === "string" && normalized.lastAssistantMessage.trim()
    ? normalized.lastAssistantMessage
    : persistedFinal;
  if (!finalText.trim()) return { status: "no-assistant-message" };
  if (isInternalSelectionEnvelope(finalText) && !sessionFinder(normalized.sessionId)) return { status: "ignored-internal" };
  return {
    status: "ready",
    sessionId: normalized.sessionId,
    turnId: normalized.turnId,
    finalText,
    updates: visibleTurnUpdates(transcriptText, normalized.turnId),
    transcriptCwd: transcriptWorkingDirectory(transcriptText),
  };
}

export function containsSensitiveProgressMaterial(value) {
  const body = String(value ?? "");
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(body) ||
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[oprsu]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}|whsec_[A-Za-z0-9]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|pypi-[A-Za-z0-9_-]{12,}|ya29\.[A-Za-z0-9_-]{20,}|4\/0A[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(body) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(body) ||
    /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret)\b\s*[:=]\s*\S+/i.test(body) ||
    /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i.test(body) ||
    /[?&](?:code|token|key|secret|password)=[^&\s]+/i.test(body) ||
    /\b(?:verification|device|authorization|one[- ]time)\s+code\b\s*(?::|is)?\s*[A-Z0-9][A-Z0-9-]{5,}/i.test(body);
}

function safeLabel(value, fallback) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized && !containsSensitiveProgressMaterial(normalized) ? normalized.slice(0, 160) : fallback;
}

function displayHost(originHost) {
  return safeLabel(originHost, "Codex");
}

function repositoryNameFromOrigin(value) {
  const match = String(value ?? "").trim().match(/(?:^|[/:])([^/:]+?)(?:\.git)?$/);
  return match ? safeLabel(match[1], null) : null;
}

export function projectLabelFromWorkingDirectory(cwd, git = spawnSync, { projectName = null, gitOriginUrl = null } = {}) {
  if (typeof cwd === "string" && path.isAbsolute(cwd)) {
    try {
      const remote = git("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
      const repository = remote?.status === 0 ? repositoryNameFromOrigin(remote.stdout) : null;
      if (repository) return repository;
      const result = git("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
      if (result?.status === 0 && String(result.stdout ?? "").trim()) {
        return safeLabel(path.basename(String(result.stdout).trim()), "No project");
      }
    } catch { /* saved metadata or the workspace folder can still provide a label */ }
  }
  if (projectName) return safeLabel(projectName, "No project");
  const storedRepository = repositoryNameFromOrigin(gitOriginUrl);
  if (storedRepository) return storedRepository;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return "No project";
  const parts = path.normalize(cwd).split(path.sep).filter(Boolean);
  const repositories = parts.lastIndexOf("repos");
  if (repositories >= 0 && parts[repositories + 1]) return safeLabel(parts[repositories + 1], "No project");
  const documents = parts.lastIndexOf("Documents");
  if (documents >= 0 && parts[documents + 1] === "Codex") return "Codex";
  return safeLabel(path.basename(cwd), "No project");
}

export function taskLabelFromMetadata(task, sessionId) {
  const fallback = `Codex task ${String(sessionId).slice(0, 8)}`;
  if (task?.name) return safeLabel(task.name, fallback);
  let source = String(task?.firstUserMessage ?? task?.initialTitle ?? "");
  const delegatedInput = source.match(/<input>([\s\S]*?)<\/input>/i)?.[1];
  if (delegatedInput) source = delegatedInput;
  const normalized = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || containsSensitiveProgressMaterial(normalized)) return fallback;
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79).trimEnd()}…`;
}

function activityBody(updates, budget) {
  const complete = updates.map((item) => {
    const update = String(item ?? "").trim();
    return containsSensitiveProgressMaterial(update)
      ? "A visible progress update was omitted because it may contain authentication or secret material. See Codex for the full log."
      : update;
  }).filter(Boolean);
  const joined = complete.join("\n\n");
  if (joined.length <= budget) return joined;
  const omissionReserve = 120;
  const contentBudget = Math.max(0, budget - omissionReserve);
  const selected = [];
  let used = 0;
  for (let index = complete.length - 1; index >= 0; index -= 1) {
    const update = complete[index];
    const cost = update.length + (selected.length ? 2 : 0);
    if (cost > contentBudget - used) break;
    selected.unshift(update);
    used += cost;
  }
  let truncated = false;
  if (!selected.length && complete.length && contentBudget > 1) {
    selected.push(`${complete.at(-1).slice(0, contentBudget - 1)}…`);
    truncated = true;
  }
  const omitted = Math.max(0, complete.length - selected.length);
  const note = `${omitted} earlier progress update${omitted === 1 ? "" : "s"} omitted${truncated ? "; the latest update was shortened" : ""}; the full log remains in Codex.`;
  const body = `${note}\n\n${selected.join("\n\n")}`.trim();
  return body.length <= budget ? body : body.slice(0, budget);
}

export function formatWhatsAppTurn({ finalText, updates = [], project, thread, originHost }) {
  const header = `*${safeLabel(project, "No project")} · ${safeLabel(thread, "Untitled task")}*\n_${displayHost(originHost)}_`;
  const finalPrefix = `${header}\n\n*Final*\n\n`;
  const requestedFinal = String(finalText ?? "");
  const finalBudget = Math.max(0, maximumFinalMessageLength - finalPrefix.length);
  const omission = "\n\n[Final response shortened; the full response remains in Codex.]";
  const boundedFinal = requestedFinal.length <= finalBudget
    ? requestedFinal
    : `${requestedFinal.slice(0, Math.max(0, finalBudget - omission.length))}${omission}`;
  const finalMessage = `${finalPrefix}${boundedFinal}`;
  if (!updates.length) return { finalMessage, activityMessage: null };
  const prefix = `${header}\n\n*Work log*\n\n`;
  const body = activityBody(updates, Math.max(0, maximumActivityMessageLength - prefix.length));
  return { activityMessage: body ? `${prefix}${body}` : null, finalMessage };
}

export function readCodexTaskMetadata(sessionId, { database = codexDatabase, execute = run } = {}) {
  if (!validCodexSessionId(sessionId) || !fs.existsSync(database)) return null;
  const query = `SELECT t.name, t.title AS initial_title, t.first_user_message, t.cwd, t.archived, t.git_origin_url, p.name AS project_name FROM threads t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = '${sessionId}' LIMIT 1;`;
  const result = execute("/usr/bin/sqlite3", ["-json", database, query], { timeoutMs: 2_000 });
  if (!result?.ok) return null;
  const parsed = parseJson(result.stdout || "[]");
  const task = parsed.ok && Array.isArray(parsed.value) ? parsed.value[0] : null;
  if (!task || typeof task.cwd !== "string") return null;
  return {
    name: typeof task.name === "string" && task.name ? task.name : null,
    initialTitle: typeof task.initial_title === "string" ? task.initial_title : "",
    firstUserMessage: typeof task.first_user_message === "string" ? task.first_user_message : "",
    cwd: task.cwd,
    archived: Number(task.archived) === 1,
    projectName: typeof task.project_name === "string" && task.project_name ? task.project_name : null,
    gitOriginUrl: typeof task.git_origin_url === "string" && task.git_origin_url ? task.git_origin_url : null,
  };
}

export function remoteBrokerCommands(command, { host = remoteHost, lanHost = remoteLanHost, hostKeyAlias = remoteHostKeyAlias, node = remoteNode, brokerPath = remoteBroker } = {}) {
  if (!host || !brokerPath) return [];
  const base = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  const brokerArgs = [node, brokerPath, command];
  const attempts = [{ route: "ssh", args: [...base, host, ...brokerArgs] }];
  if (lanHost && hostKeyAlias) {
    attempts.push({ route: "lan-pinned", args: [...base, "-o", `HostName=${lanHost}`, "-o", `HostKeyAlias=${hostKeyAlias}`, host, ...brokerArgs] });
  }
  return attempts;
}

export function isSshTransportFailure(result) {
  return !result?.ok && /ETIMEDOUT|(?:operation|connection) timed out|could not resolve hostname|no route to host|network is unreachable|connection refused|connection (?:reset|closed)|broken pipe/i.test(String(result?.stderr || result?.error || ""));
}

export function isBrokerTransportUncertain(route, result) {
  return Boolean(result?.signal || result?.error || isSshTransportFailure(result) || (route !== "local" && result?.status === 255));
}

export function classifyBrokerFailure(route, result) {
  const parsed = parseJson(result?.stdout ?? "");
  const brokerResponse = parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value : null;
  return { brokerResponse, transportUncertain: isBrokerTransportUncertain(route, result) || !brokerResponse };
}

export function recoverableBrokerOperationFailure(error, execution) {
  if (!error?.brokerTransportUncertain) return false;
  if (error.brokerCommand === "create") return execution?.stage === "completed";
  if (error.brokerCommand === "bind-task") return Boolean(execution?.sessionId);
  return false;
}

export function executionResetAfterDefiniteBusy(error, execution) {
  if (!(error instanceof CodexTaskBusyError) || !error.turnStartRejected || execution?.stage !== "turn-starting") return null;
  return { stage: "thread-ready", uncertainUntil: null, turnId: null };
}

export function remoteBrokerProbeCommand(host = remoteHost) {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=1", host, "true"];
}

export function selectRemoteBrokerCommand(command, probeResult, options) {
  const attempts = remoteBrokerCommands(command, options);
  if (probeResult?.ok) return attempts[0];
  return isSshTransportFailure(probeResult) ? attempts[1] : null;
}

function broker(command, payload, timeoutMs = 16 * 60_000) {
  const input = `${JSON.stringify(payload)}\n`;
  let route = "local", result;
  if (isGatewayHost(runtimeConfig)) result = run(process.execPath, [localBroker, command], { input, timeoutMs });
  else {
    const probe = run("/usr/bin/ssh", remoteBrokerProbeCommand(), { timeoutMs: 1_500 });
    const selected = selectRemoteBrokerCommand(command, probe);
    if (!selected) result = probe;
    else { route = selected.route; result = run("/usr/bin/ssh", selected.args, { input, timeoutMs }); }
  }
  if (!result.ok) {
    const error = new Error(result.stderr || result.error || "broker unavailable");
    error.brokerCommand = command;
    const classified = classifyBrokerFailure(route, result);
    error.brokerResponse = classified.brokerResponse;
    error.brokerTransportUncertain = classified.transportUncertain;
    throw error;
  }
  const parsed = parseJson(result.stdout);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    const error = new Error("broker returned invalid status");
    error.brokerCommand = command;
    error.brokerTransportUncertain = true;
    throw error;
  }
  return { ...parsed.value, transportRoute: route };
}

function recordStopHookStatus(status) {
  try { withStateLock((state) => { state.lastStopHook = { at: new Date().toISOString(), status }; }); } catch { /* diagnostics never block Codex */ }
}

async function stopHook(payload) {
  const turn = turnFromStopPayload(payload);
  if (turn.status !== "ready") { recordStopHookStatus(turn.status); return; }
  try {
    const originHost = hostId();
    let task = null;
    try { task = readCodexTaskMetadata(turn.sessionId); } catch { /* metadata never blocks delivery */ }
    const cwd = task?.cwd ?? turn.transcriptCwd;
    const formatted = formatWhatsAppTurn({
      finalText: turn.finalText,
      updates: runtimeConfig.codex?.mirrorProgress === true ? turn.updates : [],
      project: projectLabelFromWorkingDirectory(cwd, spawnSync, { projectName: task?.projectName, gitOriginUrl: task?.gitOriginUrl }),
      thread: taskLabelFromMetadata(task, turn.sessionId),
      originHost,
    });
    const result = broker("create", {
      originHost,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      finalText: formatted.finalMessage,
      ...(formatted.activityMessage ? { activityText: formatted.activityMessage } : {}),
    });
    recordStopHookStatus(result.notification?.status === "sent" ? "sent" : result.notification?.status ?? result.status);
  } catch { recordStopHookStatus("broker-error"); }
}

export function validCodexSessionId(sessionId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId ?? ""));
}

export function activeWriterQueueArgs(sessionId, prompt) {
  if (!validCodexSessionId(sessionId)) return null;
  return ["queue", "--thread", sessionId, "--message", String(prompt)];
}

export function activeWriterDeliveryDecision(pending, delivery, prompt, nowMs = Date.now()) {
  if (!pending) return "none";
  const pendingAttachmentFingerprint = pending.attachmentFingerprint ?? attachmentFingerprint([]);
  if (pending.requestId !== delivery?.requestId || pending.sessionId !== delivery?.sessionId || pending.promptDigest !== promptDigest(prompt) || pendingAttachmentFingerprint !== attachmentFingerprint(delivery?.attachments)) return "conflict";
  if (pending.admittedAt || pending.submittedAt) return "admitted";
  const uncertainUntil = Date.parse(pending.uncertainUntil ?? "");
  return Number.isFinite(uncertainUntil) && nowMs <= uncertainUntil ? "uncertain" : "attention";
}

export function applyQueuedSubmission(state, sessionId, payload, nowMs = Date.now()) {
  const prompt = userPrompt(payload);
  if (!validCodexSessionId(sessionId) || prompt === null) return false;
  const digest = promptDigest(prompt);
  const candidates = Object.values(state.activeWriterDeliveries ?? {})
    .filter((pending) => pending?.sessionId === sessionId && pending.promptDigest === digest && !pending.submittedAt)
    .filter((pending) => {
      const expiresAt = Date.parse(pending.expiresAt ?? "");
      return Number.isFinite(expiresAt) && nowMs <= expiresAt;
    })
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || String(left.requestId).localeCompare(String(right.requestId)));
  const pending = candidates[0];
  if (!pending) return false;
  pending.submittedAt = new Date(nowMs).toISOString();
  return true;
}

export function finishQueuedSubmission(state, sessionId) {
  const pending = Object.values(state.activeWriterDeliveries ?? {})
    .filter((item) => item?.sessionId === sessionId && item.submittedAt)
    .sort((left, right) => Date.parse(left.submittedAt) - Date.parse(right.submittedAt) || String(left.requestId).localeCompare(String(right.requestId)))[0];
  if (!pending) return null;
  delete state.activeWriterDeliveries[pending.requestId];
  return pending.requestId;
}

function acceptQueuedSubmission(sessionId, payload) {
  return withStateLock((state) => applyQueuedSubmission(state, sessionId, payload));
}

async function hook() {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
  const event = payload.hook_event_name ?? payload.hookEventName;
  const sessionId = payload.session_id ?? payload.sessionId;
  if (event === "UserPromptSubmit") {
    try { acceptQueuedSubmission(sessionId, payload); } catch { /* task submission never depends on bridge bookkeeping */ }
  } else if (event === "Stop") {
    await stopHook(payload);
    try {
      const requestId = withStateLock((state) => finishQueuedSubmission(state, sessionId));
      if (requestId) removeMaterializedAttachments(requestId);
    } catch { /* bounded attachment retention expires even if lifecycle cleanup fails */ }
  }
}

export function resumePrompt(delivery, materialized = [], { includeImages = false } = {}) {
  const body = String(delivery.responseText ?? "");
  if ((!body.trim() && !materialized.length) || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(body)) throw new Error("Claimed Codex response is invalid");
  const files = materialized.filter((attachment) => includeImages || attachment.kind === "file");
  if (!files.length) return body;
  const references = files.map((attachment) => `- ${attachment.displayName} (${attachment.mime}): ${attachment.path}`).join("\n");
  return `${body}${body ? "\n\n" : ""}WhatsApp attachments available as private local files:\n${references}`;
}

export function deliveryFromClaim(claimed) {
  if (claimed?.status !== "claimed" || !claimed.reply || !claimed.deliveryId || typeof claimed.reply.body !== "string") return null;
  let attachments;
  try { attachments = validateAttachmentRecords(claimed.reply.attachments ?? []); } catch { return null; }
  if (!claimed.reply.body.trim() && !attachments.length) return null;
  return { deliveryId: claimed.deliveryId, requestId: claimed.reply.id, kind: claimed.reply.kind ?? "quoted", sessionId: claimed.reply.sessionId ?? null, responseText: claimed.reply.body, attachments };
}

function attachmentDirectory(requestId, root = localAttachmentRoot) {
  const identity = createHash("sha256").update(String(requestId)).digest("hex");
  return path.join(root, identity);
}

function attachmentCopyAttempts(storageName, destination, {
  host = remoteHost,
  lanHost = remoteLanHost,
  hostKeyAlias = remoteHostKeyAlias,
  sourceRoot = remoteAttachmentRoot,
} = {}) {
  const base = ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  const source = `${host}:${path.posix.join(sourceRoot, storageName)}`;
  return [
    [...base, source, destination],
    [...base, "-o", `HostName=${lanHost}`, "-o", `HostKeyAlias=${hostKeyAlias}`, source, destination],
  ];
}

export function materializeDeliveryAttachments(delivery, {
  destinationRoot = localAttachmentRoot,
  sourceRoot = serverAttachmentRoot,
  gatewayHost = isGatewayHost(runtimeConfig),
  copyRemote = (args) => spawnSync("/usr/bin/scp", args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "ignore", "pipe"] }),
  remoteOptions = {},
} = {}) {
  const records = validateAttachmentRecords(delivery?.attachments ?? []);
  if (!records.length) return [];
  const directory = attachmentDirectory(delivery.requestId, destinationRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const results = [];
  try {
    for (const record of records) {
      const target = path.join(directory, record.storageName);
      if (fs.existsSync(target)) {
        verifyMaterializedAttachment(target, record);
      } else {
        const temporary = path.join(directory, `.${record.storageName}.${process.pid}.tmp`);
        try {
          if (gatewayHost) {
            const source = path.join(sourceRoot, record.storageName);
            verifyMaterializedAttachment(source, record);
            fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
          } else {
            let copied = false;
            for (const args of attachmentCopyAttempts(record.storageName, temporary, remoteOptions)) {
              const result = copyRemote(args);
              if (result?.status === 0 && !result.error) { copied = true; break; }
              try { fs.unlinkSync(temporary); } catch { /* next route starts clean */ }
            }
            if (!copied) throw new Error("The attachment could not be copied from the gateway host");
          }
          verifyMaterializedAttachment(temporary, record);
          fs.renameSync(temporary, target);
          fs.chmodSync(target, 0o600);
        } finally {
          try { fs.unlinkSync(temporary); } catch { /* absent after rename */ }
        }
      }
      results.push({ ...record, path: target });
    }
    return results;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function removeMaterializedAttachments(requestId, root = localAttachmentRoot) {
  fs.rmSync(attachmentDirectory(requestId, root), { recursive: true, force: true });
}

export function sweepMaterializedAttachments(root = localAttachmentRoot, nowMs = Date.now(), protectedRequestIds = []) {
  if (!fs.existsSync(root)) return 0;
  const protectedDirectories = new Set(protectedRequestIds.map((requestId) => path.basename(attachmentDirectory(requestId, root))));
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    if (protectedDirectories.has(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (nowMs - fs.statSync(target).mtimeMs < executionRetentionMs) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function resolveDeliveryContext({ delivery, originHost, inboxTarget = null, task = null, fallbackCwd = repositoryRoot }) {
  if (delivery?.kind === "new-task") {
    if (inboxTarget?.status !== "configured" || inboxTarget.target?.originHost !== originHost || !path.isAbsolute(inboxTarget.target?.cwd ?? "")) {
      throw new Error("Codex task inbox target is unavailable");
    }
    return { cwd: inboxTarget.target.cwd, task: null };
  }
  if (!validCodexSessionId(delivery?.sessionId)) throw new Error("The quoted Codex task identifier is invalid");
  if (task?.archived) throw new Error("The quoted Codex task is archived");
  return { cwd: typeof task?.cwd === "string" && path.isAbsolute(task.cwd) ? task.cwd : fallbackCwd, task };
}

function executionState(requestId) {
  return readState().executions[requestId] ?? null;
}

function rememberExecution(requestId, update) {
  return withStateLock((state) => {
    const prior = state.executions[requestId] ?? {};
    const value = {
      ...prior,
      ...update,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + executionRetentionMs).toISOString(),
    };
    state.executions[requestId] = value;
    return value;
  });
}

function clearExecution(requestId) {
  withStateLock((state) => { delete state.executions[requestId]; });
}

function activeWriterDeliveryState(requestId) {
  return readState().activeWriterDeliveries[requestId] ?? null;
}

function rememberActiveWriterStart(delivery, prompt) {
  const startedAt = new Date().toISOString();
  return withStateLock((state) => {
    const pending = {
      requestId: delivery.requestId,
      sessionId: delivery.sessionId,
      promptDigest: promptDigest(prompt),
      attachmentFingerprint: attachmentFingerprint(delivery.attachments),
      startedAt,
      uncertainUntil: new Date(Date.now() + activeWriterUncertaintyMs).toISOString(),
      expiresAt: new Date(Date.now() + activeWriterRetentionMs).toISOString(),
    };
    state.activeWriterDeliveries[delivery.requestId] = pending;
    return pending;
  });
}

function rememberActiveWriterAdmission(requestId) {
  return withStateLock((state) => {
    const pending = state.activeWriterDeliveries[requestId];
    if (!pending) throw new Error("Active-writer queue state is unavailable");
    pending.admittedAt = new Date().toISOString();
    return pending;
  });
}

function rememberActiveWriterBrokerCompletion(requestId) {
  withStateLock((state) => {
    const pending = state.activeWriterDeliveries[requestId];
    if (!pending) return;
    pending.brokerCompletedAt = new Date().toISOString();
  });
}

function clearActiveWriterDelivery(requestId) {
  withStateLock((state) => { delete state.activeWriterDeliveries[requestId]; });
}

export function queueThroughActiveWriter(delivery, prompt, options = {}) {
  const {
    readPending = activeWriterDeliveryState,
    rememberStart = rememberActiveWriterStart,
    enqueue = (args) => spawnSync(codexBinaryPath(), args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "ignore", "ignore"] }),
    rememberAdmission = rememberActiveWriterAdmission,
    clearPending = clearActiveWriterDelivery,
  } = options;
  const args = activeWriterQueueArgs(delivery.sessionId, prompt);
  if (!args) throw new CodexAttentionRequiredError("The quoted Codex task identifier is invalid.");
  const decision = activeWriterDeliveryDecision(readPending(delivery.requestId), delivery, prompt);
  if (decision === "admitted") return { ok: true };
  if (decision === "uncertain") throw new CodexTurnStartUncertainError("Codex may have accepted the native queued reply, so it will not be replayed.");
  if (decision !== "none") throw new CodexAttentionRequiredError("The native Codex queue attempt cannot be recovered safely.");
  try { rememberStart(delivery, prompt); }
  catch { throw new CodexTaskBusyError("Codex queue state is busy"); }
  const queued = enqueue(args);
  if (queued.status === 0 && !queued.error) {
    try { rememberAdmission(delivery.requestId); }
    catch { throw new CodexTurnStartUncertainError("Codex accepted the native queued reply before its admission record was durable."); }
    return { ok: true };
  }
  if (activeWriterDeliveryDecision(readPending(delivery.requestId), delivery, prompt) === "admitted") return { ok: true };
  if (queued.error || queued.status === null) throw new CodexTurnStartUncertainError("Codex native queue delivery is uncertain and will not be replayed.");
  try { clearPending(delivery.requestId); } catch { /* terminal failure cleanup is retried below */ }
  throw new CodexAttentionRequiredError("The Codex desktop queue rejected this reply.");
}

function completeActiveWriterDelivery(delivery, originHost) {
  acknowledgeDeliveryAdmission(delivery, originHost);
  let completed;
  try { completed = broker("complete", { originHost, deliveryId: delivery.deliveryId }); }
  catch { return; }
  if (completed.status === "completed") {
    try { rememberActiveWriterBrokerCompletion(delivery.requestId); } catch { /* bounded metadata expires without replaying the admitted message */ }
  }
}

function pidIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export function inspectDeliveryLock(lockFile = deliveryLockPath, { nowMs = Date.now(), isPidRunning = pidIsRunning } = {}) {
  try {
    const token = fs.readFileSync(lockFile, "utf8");
    const ageMs = nowMs - fs.statSync(lockFile).mtimeMs;
    const match = token.match(/^([1-9][0-9]*):([0-9]+)$/);
    if (!match) return { exists: true, active: ageMs < deliveryLockStaleMs, token, reason: "unrecognized" };
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) return { exists: true, active: ageMs < deliveryLockStaleMs, token, reason: "unrecognized" };
    return { exists: true, active: ageMs < deliveryLockStaleMs && isPidRunning(pid), token, pid, reason: "owner" };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, active: false, token: null, reason: "missing" };
    return { exists: true, active: true, token: null, reason: "unreadable" };
  }
}

export function deliveryWorkerRunning(options = {}) {
  return inspectDeliveryLock(options.lockFile ?? deliveryLockPath, options).active;
}

export function acquireDeliveryLock({ lockFile = deliveryLockPath, nowMs = Date.now(), isPidRunning = pidIsRunning } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${nowMs}`;
  try { fs.writeFileSync(lockFile, token, { flag: "wx", mode: 0o600 }); return token; }
  catch (error) {
    if (error.code !== "EEXIST") return false;
    const observed = inspectDeliveryLock(lockFile, { nowMs, isPidRunning });
    if (observed.active || !observed.token) return false;
    try {
      if (fs.readFileSync(lockFile, "utf8") !== observed.token) return false;
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, token, { flag: "wx", mode: 0o600 });
      return token;
    } catch { return false; }
  }
}

export function acknowledgeDeliveryAdmission(delivery, originHost, { brokerCall = broker } = {}) {
  try { return brokerCall("accept", { originHost, deliveryId: delivery.deliveryId }, 30_000).status === "accepted"; }
  catch { return false; }
}

function launchDeliveryWorker() {
  if (deliveryWorkerRunning()) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "deliver"], { cwd: repositoryRoot, detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

async function deliver() {
  const lockToken = acquireDeliveryLock();
  if (!lockToken) return;
  try {
  try { broker("retry-notification", { originHost: hostId() }); } catch { /* bounded retry later */ }
  try { broker("retry-receipt", { originHost: hostId() }, 30_000); } catch { /* accepted receipts retry later */ }
  let claimed;
  try { claimed = broker("claim", { originHost: hostId() }); } catch { return; }
  const delivery = deliveryFromClaim(claimed);
  if (!delivery) return;
  const originHost = hostId();
  let responseRouteStored = false;
  let materialized = [];
  let retainMaterialized = false;
  try {
    materialized = materializeDeliveryAttachments(delivery);
    const prompt = resumePrompt(delivery, materialized);
    const activeWriterPrompt = resumePrompt(delivery, materialized, { includeImages: true });
    if (delivery.kind === "quoted") {
      const activeWriterDecision = activeWriterDeliveryDecision(activeWriterDeliveryState(delivery.requestId), delivery, activeWriterPrompt);
      if (activeWriterDecision === "admitted") {
        retainMaterialized = true;
        completeActiveWriterDelivery(delivery, originHost);
        return;
      }
      if (activeWriterDecision === "uncertain") throw new CodexTurnStartUncertainError("Codex native queue delivery is still uncertain.");
      if (activeWriterDecision !== "none") throw new CodexAttentionRequiredError("The native Codex queue attempt cannot be recovered safely.");
    }
    let execution = executionState(delivery.requestId);
    if (delivery.kind === "new-task" && execution?.sessionId) {
      broker("bind-task", { originHost, replyId: delivery.requestId, deliveryId: delivery.deliveryId, sessionId: execution.sessionId });
    }
    let result = execution?.stage === "completed" ? execution : null;
    if (!result) {
      const task = delivery.sessionId ? readCodexTaskMetadata(delivery.sessionId) : null;
      const inboxTarget = delivery.kind === "new-task" ? broker("inbox-target", {}) : null;
      const { cwd } = resolveDeliveryContext({ delivery, originHost, inboxTarget, task });
      const title = execution?.title ?? (delivery.kind === "new-task" ? codexTaskTitle(prompt) : taskLabelFromMetadata(task, delivery.sessionId));
      try {
        result = await runCodexAppServerTurn({
          codexBinary: codexBinaryPath(),
          cwd,
          prompt,
          attachments: materialized.filter((attachment) => attachment.kind === "image"),
          requestId: delivery.requestId,
          sessionId: execution?.sessionId ?? delivery.sessionId,
          title,
          execution,
          onThreadCreating: (pending) => { execution = rememberExecution(delivery.requestId, { ...pending, stage: "thread-creating" }); },
          onThreadReady: (thread) => {
            const prior = executionState(delivery.requestId);
            execution = rememberExecution(delivery.requestId, { ...thread, stage: prior?.stage === "running" ? "running" : "thread-ready" });
            if (delivery.kind === "new-task") {
              const bound = broker("bind-task", { originHost, replyId: delivery.requestId, deliveryId: delivery.deliveryId, sessionId: thread.sessionId });
              if (bound.status !== "bound") throw new Error("The new Codex task could not be bound to its WhatsApp request");
            }
          },
          onTurnStarting: (turn) => { execution = rememberExecution(delivery.requestId, { ...turn, stage: "turn-starting" }); },
          onTurnStarted: (turn) => {
            execution = rememberExecution(delivery.requestId, { ...turn, stage: "running" });
            acknowledgeDeliveryAdmission(delivery, originHost);
          },
        });
      } catch (error) {
        if (delivery.kind === "quoted" && error instanceof CodexActiveWriterError) {
          queueThroughActiveWriter(delivery, activeWriterPrompt);
          retainMaterialized = true;
          completeActiveWriterDelivery(delivery, originHost);
          return;
        }
        throw error;
      }
      result = rememberExecution(delivery.requestId, { ...result, stage: "completed" });
    }
    if (!validCodexSessionId(result.sessionId) || !validCodexSessionId(result.turnId)) throw new Error("Codex returned invalid task identifiers");
    const formatted = formatWhatsAppTurn({
      finalText: result.finalText,
      updates: runtimeConfig.codex?.mirrorProgress === true ? result.updates : [],
      project: projectLabelFromWorkingDirectory(result.cwd),
      thread: result.title,
      originHost,
    });
    const routed = broker("create", {
      originHost,
      sessionId: result.sessionId,
      turnId: result.turnId,
      finalText: formatted.finalMessage,
      ...(formatted.activityMessage ? { activityText: formatted.activityMessage } : {}),
    });
    if (!routed.route) throw new Error("The Codex response route was not stored");
    responseRouteStored = true;
    const completed = broker("complete", { originHost, deliveryId: delivery.deliveryId });
    if (completed.status === "completed") {
      clearExecution(delivery.requestId);
      removeMaterializedAttachments(delivery.requestId);
    }
  } catch (error) {
    if (responseRouteStored) {
      console.error("[codex-whatsapp-client] response route is durable; inbound completion will retry after claim recovery");
      return;
    }
    const pendingExecution = executionState(delivery.requestId);
    if (recoverableBrokerOperationFailure(error, pendingExecution)) {
      try { broker("release", { originHost, deliveryId: delivery.deliveryId }); } catch { /* claim expiry provides recovery */ }
      return;
    }
    if (error instanceof CodexTaskBusyError || error instanceof CodexThreadStartUncertainError || error instanceof CodexTurnStartUncertainError) {
      const reset = executionResetAfterDefiniteBusy(error, executionState(delivery.requestId));
      if (reset) rememberExecution(delivery.requestId, reset);
      try { broker("release", { originHost, deliveryId: delivery.deliveryId }); } catch { /* claim expiry provides recovery */ }
      return;
    }
    const reason = error instanceof CodexAttentionRequiredError
      ? "This Codex task needs attention in Codex before it can continue."
      : `That Codex message could not be completed. Open Codex on ${displayHost(originHost)} and try again.`;
    console.error(`[codex-whatsapp-client] App Server delivery failed: ${error?.name ?? "Error"}`);
    try {
      const failed = broker("fail", { originHost, deliveryId: delivery.deliveryId, reason });
      if (failed.status === "failed") {
        clearExecution(delivery.requestId);
        clearActiveWriterDelivery(delivery.requestId);
        removeMaterializedAttachments(delivery.requestId);
      }
    } catch { /* stale claim is recovered after the bounded worker window */ }
  }
  } finally {
    if (!retainMaterialized && !responseRouteStored && !executionState(delivery?.requestId)?.stage) {
      try { removeMaterializedAttachments(delivery.requestId); } catch { /* only task-owned staged copies */ }
    }
    try { if (fs.readFileSync(deliveryLockPath, "utf8") === lockToken) fs.unlinkSync(deliveryLockPath); } catch { /* stale lock is recovered after the bounded worker window */ }
  }
}

async function poll() {
  withStateLock((state) => pruneClientState(state));
  sweepMaterializedAttachments(localAttachmentRoot, Date.now(), Object.keys(readState().activeWriterDeliveries));
  launchDeliveryWorker();
}

export function pruneClientState(state, nowMs = Date.now()) {
  for (const [requestId, execution] of Object.entries(state.executions ?? {})) {
    if (!Number.isFinite(Date.parse(execution?.expiresAt)) || Date.parse(execution.expiresAt) <= nowMs) delete state.executions[requestId];
  }
  for (const [requestId, pending] of Object.entries(state.activeWriterDeliveries ?? {})) {
    const safelyAdmitted = pending?.admittedAt || pending?.submittedAt || pending?.brokerCompletedAt;
    if (safelyAdmitted && Date.parse(pending.expiresAt ?? "") <= nowMs) delete state.activeWriterDeliveries[requestId];
  }
  return state;
}

async function status() {
  const state = readState();
  let remote;
  try { remote = broker("status", { originHost: hostId() }); } catch { remote = { ok: false, error: "broker-unavailable" }; }
  const hookTrust = await bridgeHookTrustStatus({ codexBinary: codexBinaryPath(), cwd: repositoryRoot, command: hookCommand, sourcePath: canonicalPath(hooksPath) });
  console.log(JSON.stringify({ ok: remote?.ok !== false && hookTrust.ready, hostId: hostId(), localPendingExecutions: Object.keys(state.executions).length, localActiveWriterDeliveries: Object.keys(state.activeWriterDeliveries).length, lastStopHook: state.lastStopHook ?? null, broker: remote, hookTrust }, null, 2));
}

export async function main(command = process.argv[2] ?? "status") {
  if (!installedConfig) throw new Error("Run npm run setup:apply before starting the bridge client");
  if (command === "hook") await hook();
  else if (command === "poll") await poll();
  else if (command === "deliver") await deliver();
  else if (command === "status") await status();
  else { console.error("Usage: codex-whatsapp-client.mjs <hook|poll|deliver|status>"); process.exitCode = 64; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
