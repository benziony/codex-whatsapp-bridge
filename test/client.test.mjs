import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acknowledgeDeliveryAdmission,
  acquireDeliveryLock,
  activeWriterDeliveryDecision,
  activeWriterQueueArgs,
  applyQueuedSubmission,
  containsSensitiveProgressMaterial,
  classifyBrokerFailure,
  deliveryFromClaim,
  deliveryWorkerRunning,
  executionResetAfterDefiniteBusy,
  finishQueuedSubmission,
  isInternalExclusionEnvelope,
  isInternalSuggestionsEnvelope,
  isBrokerTransportUncertain,
  isSshTransportFailure,
  inspectDeliveryLock,
  latestAssistantText,
  materializeDeliveryAttachments,
  formatWhatsAppTurn,
  normalizeState,
  normalizeStopHookPayload,
  persistedCodexSessionExists,
  pruneClientState,
  projectLabelFromWorkingDirectory,
  queueThroughActiveWriter,
  readCodexTaskMetadata,
  remoteBrokerCommands,
  recoverableBrokerOperationFailure,
  resolveDeliveryContext,
  resumePrompt,
  removeMaterializedAttachments,
  selectRemoteBrokerCommand,
  sweepMaterializedAttachments,
  taskLabelFromMetadata,
  turnFromStopPayload,
  validCodexSessionId,
  visibleTurnUpdates,
} from "../scripts/codex-whatsapp-client.mjs";
import {
  CodexAttentionRequiredError,
  CodexTaskBusyError,
  CodexTurnStartUncertainError,
} from "../scripts/lib/codex-app-server.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";

test("a dead delivery-lock owner is recovered immediately while live and ambiguous locks are preserved", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delivery-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, "delivery.lock");
  const nowMs = Date.UTC(2026, 7, 30);

  fs.writeFileSync(lockFile, `999999:${nowMs}`);
  assert.deepEqual(inspectDeliveryLock(lockFile, { nowMs, isPidRunning: () => false }), { exists: true, active: false, token: `999999:${nowMs}`, pid: 999999, reason: "owner" });
  const replacement = acquireDeliveryLock({ lockFile, nowMs: nowMs + 1, isPidRunning: () => false });
  assert.equal(replacement, `${process.pid}:${nowMs + 1}`);

  fs.writeFileSync(lockFile, `123:${nowMs}`, { flag: "w" });
  assert.equal(deliveryWorkerRunning({ lockFile, nowMs, isPidRunning: () => true }), true);
  assert.equal(acquireDeliveryLock({ lockFile, nowMs: nowMs + 1, isPidRunning: () => true }), false);
  const liveLockMtime = fs.statSync(lockFile).mtimeMs;
  assert.equal(deliveryWorkerRunning({ lockFile, nowMs: liveLockMtime + 90 * 60 * 1_000 + 1, isPidRunning: () => true }), false);

  fs.writeFileSync(lockFile, "not-a-lock", { flag: "w" });
  assert.equal(deliveryWorkerRunning({ lockFile, nowMs }), true);
  assert.equal(acquireDeliveryLock({ lockFile, nowMs }), false);
});

test("Codex task admission calls the broker once with the exact claimed delivery", () => {
  const calls = [];
  const accepted = acknowledgeDeliveryAdmission(
    { deliveryId: "delivery-1" },
    "regular-mac",
    { brokerCall(command, payload, timeoutMs) { calls.push({ command, payload, timeoutMs }); return { status: "accepted" }; } },
  );
  assert.equal(accepted, true);
  assert.deepEqual(calls, [{ command: "accept", payload: { originHost: "regular-mac", deliveryId: "delivery-1" }, timeoutMs: 30_000 }]);
});

test("Stop payload prefers the exact final assistant message", () => {
  const result = turnFromStopPayload({ session_id: sessionId, turn_id: "turn-1", transcript_path: "/unused", last_assistant_message: " Final **markdown**\nline two.\n" }, () => { throw new Error("transcript race"); });
  assert.deepEqual(result, { status: "ready", sessionId, turnId: "turn-1", finalText: " Final **markdown**\nline two.\n", updates: [], transcriptCwd: null });
});

test("only visible commentary from the completed turn becomes the WhatsApp work log", () => {
  const records = [
    { type: "session_meta", payload: { cwd: "/repo/project" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ text: "Visible one" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Visible one" } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ text: "hidden" }] } },
    { type: "response_item", payload: { type: "function_call_output", output: "tool output" } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ text: "Visible two" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "Final" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ text: "Wrong turn" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-2" } } },
  ];
  const transcript = records.map(JSON.stringify).join("\n");
  assert.deepEqual(visibleTurnUpdates(transcript, "turn-1"), ["Visible one", "Visible two"]);
  const result = turnFromStopPayload({ session_id: sessionId, turn_id: "turn-1", transcript_path: "/transcript", last_assistant_message: "Final" }, () => transcript);
  assert.deepEqual(result.updates, ["Visible one", "Visible two"]);
  assert.equal(result.transcriptCwd, "/repo/project");
});

test("WhatsApp messages repeat bounded project, task, and host context", () => {
  const formatted = formatWhatsAppTurn({
    finalText: "Done.",
    updates: ["Checked the current behavior.", "Validated the fix."],
    project: "SolarManager",
    thread: "Repair focused deals",
    originHost: "regular-mac",
  });
  assert.equal(formatted.activityMessage, "*SolarManager · Repair focused deals*\n_regular-mac_\n\n*Work log*\n\nChecked the current behavior.\n\nValidated the fix.");
  assert.equal(formatted.finalMessage, "*SolarManager · Repair focused deals*\n_regular-mac_\n\n*Final*\n\nDone.");
  assert.ok(formatted.activityMessage.length <= 3_900);
});

test("an oversized visible update is bounded without leaking tool output", () => {
  const formatted = formatWhatsAppTurn({
    finalText: "Done.",
    updates: ["Useful visible update ".repeat(400)],
    project: "Project",
    thread: "Task",
    originHost: "server-mac",
  });
  assert.ok(formatted.activityMessage.length <= 3_900);
  assert.match(formatted.activityMessage, /latest update was shortened/);
  assert.doesNotMatch(formatted.activityMessage, /tool output/i);
});

test("an oversized final response stays within the broker envelope", () => {
  const formatted = formatWhatsAppTurn({ finalText: "x".repeat(60_000), project: "Project", thread: "Task", originHost: "regular-mac" });
  assert.ok(formatted.finalMessage.length <= 48_000);
  assert.match(formatted.finalMessage, /full response remains in Codex/);
});

test("authentication material is omitted from visible progress and labels", () => {
  const secret = "Authorization: Bearer secret-session-value";
  assert.equal(containsSensitiveProgressMaterial(secret), true);
  const formatted = formatWhatsAppTurn({
    finalText: "Done.",
    updates: ["Safe update.", secret],
    project: "Project",
    thread: "Device code: ABCD-EFGH",
    originHost: "regular-mac",
  });
  assert.doesNotMatch(formatted.activityMessage, /secret-session-value|ABCD-EFGH/);
  assert.match(formatted.activityMessage, /omitted because it may contain authentication or secret material/);
  assert.match(formatted.activityMessage, /Untitled task/);
  for (const credential of [
    ["sk", "proj-1234567890abcdefghijklmnop"].join("-"),
    ["ghp", "1234567890abcdefghijklmnop"].join("_"),
    ["xoxb", "1234567890-abcdefghijklmnop"].join("-"),
    ["4/0AT", "sMZqAAAn7GUjukDtIFwv3SB-WrS9MFPlWmw18zNEbFv4uD_Pt9hM9nGkajHbpcf1G-5g"].join(""),
    ["ya29", "a0AfH6SMB1234567890abcdefghijklmnop"].join("."),
    `The token is ${["sk", "proj-1234567890abcdefghijklmnop"].join("-")}`,
    ["sk", "live", "1234567890abcdefghijklmnop"].join("_"),
    ["rk", "live", "1234567890abcdefghijklmnop"].join("_"),
    ["whsec", "1234567890abcdefghijklmnop"].join("_"),
    ["glpat", "1234567890abcdefghijklmnop"].join("-"),
    ["npm", "1234567890abcdefghijklmnop"].join("_"),
    ["pypi", "1234567890abcdefghijklmnop"].join("-"),
  ]) assert.equal(containsSensitiveProgressMaterial(credential), true, credential);
});

test("project label prefers the Git root and falls back to the workspace folder", () => {
  const success = () => ({ status: 0, stdout: "/worktrees/codex-whatsapp-bridge\n" });
  const failure = () => ({ status: 1, stdout: "" });
  assert.equal(projectLabelFromWorkingDirectory("/tmp/worktree", success), "codex-whatsapp-bridge");
  assert.equal(projectLabelFromWorkingDirectory("/tmp/worktree", success, { gitOriginUrl: "https://github.com/example/HomeLife.git" }), "codex-whatsapp-bridge");
  assert.equal(projectLabelFromWorkingDirectory("/tmp/Plain Workspace", failure), "Plain Workspace");
  assert.equal(projectLabelFromWorkingDirectory("/Users/operator/dev/repos/Hermes-agent", failure), "Hermes-agent");
  assert.equal(projectLabelFromWorkingDirectory("/Users/operator/Documents/Codex/2026/task", failure), "Codex");
  assert.equal(projectLabelFromWorkingDirectory("/tmp/custom-worktree-name", failure, { gitOriginUrl: "https://github.com/example/SolarManager.git" }), "SolarManager");
  assert.equal(projectLabelFromWorkingDirectory("/tmp/anything", failure, { projectName: "Trivalry" }), "Trivalry");
  assert.equal(projectLabelFromWorkingDirectory(null, failure), "No project");
});

test("task labels use an exact saved name or a bounded initial-request fallback", () => {
  assert.equal(taskLabelFromMetadata({ name: "Diagnose Hermes WhatsApp alerts" }, sessionId), "Diagnose Hermes WhatsApp alerts");
  assert.equal(taskLabelFromMetadata({ firstUserMessage: "A long initial request ".repeat(10) }, sessionId).endsWith("…"), true);
  assert.equal(taskLabelFromMetadata({ initialTitle: "<realtime_delegation><input>Focused deals</input></realtime_delegation>" }, sessionId), "Focused deals");
});

test("task metadata is read exactly and read-only from the host-local Codex database", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-task-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, "state.sqlite");
  fs.writeFileSync(database, "fixture");
  const calls = [];
  const task = readCodexTaskMetadata(sessionId, {
    database,
    execute(command, args, options) {
      calls.push({ command, args, options });
      return { ok: true, stdout: JSON.stringify([{ name: "Existing task", initial_title: "original", first_user_message: "original", cwd: "/Users/operator/Documents/Codex", archived: 0, git_origin_url: null, project_name: "Codex" }]) };
    },
  });
  assert.deepEqual(task, { name: "Existing task", initialTitle: "original", firstUserMessage: "original", cwd: "/Users/operator/Documents/Codex", archived: false, projectName: "Codex", gitOriginUrl: null });
  assert.equal(calls[0].command, "/usr/bin/sqlite3");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-json", database]);
  assert.match(calls[0].args[2], new RegExp(sessionId));
  assert.equal(readCodexTaskMetadata("invalid", { database, execute: () => { throw new Error("must not execute"); } }), null);
});

test("Stop payload uses only the latest assistant transcript message as fallback", () => {
  const transcript = [
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "user" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "new final" }] } },
  ].map(JSON.stringify).join("\n");
  assert.equal(latestAssistantText(transcript), "new final");
  assert.equal(turnFromStopPayload({ sessionId, turnId: "turn-2", transcriptPath: "/transcript" }, () => transcript).finalText, "new final");
});

test("recursive, incomplete, and empty Stop payloads are ignored", () => {
  assert.equal(turnFromStopPayload({ stop_hook_active: true }).status, "ignored-recursive");
  assert.equal(turnFromStopPayload({ session_id: sessionId }).status, "invalid-payload");
  assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", last_assistant_message: "" }).status, "no-assistant-message");
  assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", transcript_path: "/missing", last_assistant_message: "visible" }, () => { throw new Error("missing"); }).status, "ready");
});

test("hidden Codex suggestion envelopes are not mirrored to WhatsApp", () => {
  const suggestions = JSON.stringify({ suggestions: [{ title: "Fix issue", description: "Internal card", prompt: "Do work", appId: "github", pluginId: null }] });
  const transcript = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: suggestions }] } });
  assert.equal(isInternalSuggestionsEnvelope(suggestions), true);
  assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", last_assistant_message: suggestions }, undefined, () => false).status, "ignored-internal");
  assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", transcript_path: "/transcript", last_assistant_message: suggestions }, () => transcript, () => false).status, "ignored-internal");
  assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", last_assistant_message: suggestions }, undefined, () => true).status, "ready");
  assert.equal(isInternalSuggestionsEnvelope('{"suggestions":[{"title":"ordinary user JSON"}]}'), false);
});

test("hidden Codex exclusion envelopes are not mirrored while ordinary JSON is preserved", () => {
  const empty = '{"exclude":[]}';
  const populated = '{"exclude":[{"id":"suggestion-2","reason":"Sensitive personal content"}]}';
  for (const envelope of [empty, populated]) {
    assert.equal(isInternalExclusionEnvelope(envelope), true);
    assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", last_assistant_message: envelope }, undefined, () => false).status, "ignored-internal");
    assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", last_assistant_message: envelope }, undefined, () => true).status, "ready");
  }
  for (const ordinary of [
    '{"exclude":[{"id":"customer-2","reason":"requested filter"}]}',
    '{"exclude":[{"id":"suggestion-2","reason":"requested filter","keep":true}]}',
    '{"exclude":[],"result":"requested output"}',
  ]) {
    assert.equal(isInternalExclusionEnvelope(ordinary), false);
    assert.equal(turnFromStopPayload({ session_id: sessionId, turn_id: "turn", last_assistant_message: ordinary }, undefined, () => false).status, "ready");
  }
});

test("persisted task discovery is bounded to dated Codex rollout filenames", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-filter-"));
  try {
    const day = path.join(root, "2026", "08", "27");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `rollout-2026-08-27T00-00-00-${sessionId}.jsonl`), "");
    assert.equal(persistedCodexSessionExists(sessionId, root), true);
    assert.equal(persistedCodexSessionExists("not-a-session", root), false);
    fs.mkdirSync(path.join(root, "unbounded", "tree"), { recursive: true });
    fs.writeFileSync(path.join(root, "unbounded", "tree", `fake-${sessionId}.jsonl`), "");
    assert.equal(persistedCodexSessionExists("22222222-2222-4222-8222-222222222222", root), false);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("Stop payload normalizes snake and camel case", () => {
  assert.deepEqual(normalizeStopHookPayload({ stopHookActive: false, sessionId, turnId: "t", transcriptPath: "p", lastAssistantMessage: "m" }), { stopHookActive: false, sessionId, turnId: "t", transcript: "p", lastAssistantMessage: "m" });
});

test("claimed replies resume with the exact body and no wrapper", () => {
  const delivery = deliveryFromClaim({ status: "claimed", deliveryId: "delivery-1", reply: { id: "reply-1", sessionId, body: " freeform response\nsecond line\n" } });
  assert.deepEqual(delivery, { deliveryId: "delivery-1", requestId: "reply-1", kind: "quoted", sessionId, responseText: " freeform response\nsecond line\n", attachments: [] });
  assert.equal(resumePrompt(delivery), " freeform response\nsecond line\n");
  assert.throws(() => resumePrompt({ responseText: "\u0000bad" }), /invalid/);
});

test("Server Mac quoted replies use their local task context without consulting the Regular Mac inbox target", () => {
  const delivery = { kind: "quoted", sessionId, responseText: "continue" };
  assert.deepEqual(resolveDeliveryContext({
    delivery,
    originHost: "server-mac",
    inboxTarget: { status: "configured", target: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" } },
    task: { cwd: "/Users/operator/dev/SolarManager", archived: false },
  }), { cwd: "/Users/operator/dev/SolarManager", task: { cwd: "/Users/operator/dev/SolarManager", archived: false } });
  assert.equal(resolveDeliveryContext({ delivery, originHost: "server-mac", task: null, fallbackCwd: "/codex-whatsapp-bridge" }).cwd, "/codex-whatsapp-bridge");
});

test("only new-task deliveries require the configured same-host inbox target", () => {
  const delivery = { kind: "new-task", sessionId: null, responseText: "new work" };
  assert.equal(resolveDeliveryContext({
    delivery,
    originHost: "regular-mac",
    inboxTarget: { status: "configured", target: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" } },
  }).cwd, "/Users/operator/Documents/Codex");
  assert.throws(() => resolveDeliveryContext({
    delivery,
    originHost: "server-mac",
    inboxTarget: { status: "configured", target: { originHost: "regular-mac", cwd: "/Users/operator/Documents/Codex" } },
  }), /unavailable/);
});

test("Codex task identifiers are validated before exact-task routing", () => {
  assert.equal(validCodexSessionId(sessionId), true);
  assert.equal(validCodexSessionId("not-a-session"), false);
  assert.deepEqual(activeWriterQueueArgs(sessionId, "exact body"), ["queue", "--thread", sessionId, "--message", "exact body"]);
  assert.equal(activeWriterQueueArgs("not-a-session", "body"), null);
});

test("claimed attachments materialize by digest and become native images or explicit file references", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-client-attachments-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "broker");
  const destinationRoot = path.join(root, "client");
  fs.mkdirSync(sourceRoot);
  const imageBytes = Buffer.from("image bytes");
  const fileBytes = Buffer.from("document bytes");
  const imageName = "11111111-1111-4111-8111-111111111111.jpg";
  const fileName = "22222222-2222-4222-8222-222222222222.pdf";
  fs.writeFileSync(path.join(sourceRoot, imageName), imageBytes);
  fs.writeFileSync(path.join(sourceRoot, fileName), fileBytes);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const attachments = [
    { storageName: imageName, displayName: "photo.jpg", mime: "image/jpeg", kind: "image", size: imageBytes.length, sha256: sha(imageBytes) },
    { storageName: fileName, displayName: "document.pdf", mime: "application/pdf", kind: "file", size: fileBytes.length, sha256: sha(fileBytes) },
  ];
  const delivery = deliveryFromClaim({ status: "claimed", deliveryId: "delivery-files", reply: { id: "reply-files", kind: "new-task", body: "Inspect these", attachments } });
  const materialized = materializeDeliveryAttachments(delivery, { destinationRoot, sourceRoot, gatewayHost: true });
  assert.equal(materialized.length, 2);
  assert.equal(materialized.every((item) => fs.existsSync(item.path)), true);
  assert.equal(resumePrompt(delivery, materialized), `Inspect these\n\nWhatsApp attachments available as private local files:\n- document.pdf (application/pdf): ${materialized[1].path}`);
  const activeWriterPrompt = resumePrompt(delivery, materialized, { includeImages: true });
  assert.equal(activeWriterPrompt, `Inspect these\n\nWhatsApp attachments available as private local files:\n- photo.jpg (image/jpeg): ${materialized[0].path}\n- document.pdf (application/pdf): ${materialized[1].path}`);
  assert.deepEqual(activeWriterQueueArgs(sessionId, activeWriterPrompt), ["queue", "--thread", sessionId, "--message", activeWriterPrompt]);
  removeMaterializedAttachments(delivery.requestId, destinationRoot);
  assert.equal(fs.existsSync(path.dirname(materialized[0].path)), false);
});

test("client state preserves App Server recovery while adding metadata-only active-writer state", () => {
  assert.deepEqual(normalizeState({ schemaVersion: 3, activeWriterDeliveries: { x: {} } }), { schemaVersion: 4, executions: {}, activeWriterDeliveries: {} });
  assert.deepEqual(normalizeState({ schemaVersion: 4, executions: { x: { stage: "running" } }, lastStopHook: { status: "sent" } }), { schemaVersion: 4, executions: { x: { stage: "running" } }, activeWriterDeliveries: {}, lastStopHook: { status: "sent" } });
  assert.deepEqual(normalizeState({ schemaVersion: 4, executions: {}, activeWriterDeliveries: { y: { requestId: "y" } } }), { schemaVersion: 4, executions: {}, activeWriterDeliveries: { y: { requestId: "y" } } });
});

test("active-writer recovery never replays an uncertain native queue attempt", () => {
  const delivery = { requestId: "reply-1", sessionId };
  const prompt = "same exact reply\n";
  const digest = createHash("sha256").update(prompt.trimEnd()).digest("hex");
  const pending = { requestId: delivery.requestId, sessionId, promptDigest: digest, startedAt: "2026-08-30T12:00:00.000Z", uncertainUntil: "2026-08-30T12:02:00.000Z", expiresAt: "2026-09-29T12:00:00.000Z" };
  assert.equal(activeWriterDeliveryDecision(null, delivery, prompt, Date.parse("2026-08-30T12:01:00.000Z")), "none");
  assert.equal(activeWriterDeliveryDecision(pending, delivery, prompt, Date.parse("2026-08-30T12:01:00.000Z")), "uncertain");
  assert.equal(activeWriterDeliveryDecision(pending, delivery, prompt, Date.parse("2026-08-30T12:03:00.000Z")), "attention");
  assert.equal(activeWriterDeliveryDecision({ ...pending, admittedAt: "2026-08-30T12:00:01.000Z" }, delivery, prompt), "admitted");
  assert.equal(activeWriterDeliveryDecision({ ...pending, requestId: "different" }, delivery, prompt), "conflict");
});

test("queued submission proof consumes matching admissions in FIFO order without storing bodies", () => {
  const prompt = "repeatable reply";
  const digest = createHash("sha256").update(prompt).digest("hex");
  const state = { schemaVersion: 4, executions: {}, activeWriterDeliveries: {
    first: { requestId: "first", sessionId, promptDigest: digest, startedAt: "2026-08-30T12:00:00.000Z", expiresAt: "2026-09-29T12:00:00.000Z", admittedAt: "2026-08-30T12:00:01.000Z", brokerCompletedAt: "2026-08-30T12:00:02.000Z" },
    second: { requestId: "second", sessionId, promptDigest: digest, startedAt: "2026-08-30T12:00:03.000Z", expiresAt: "2026-09-29T12:00:03.000Z", admittedAt: "2026-08-30T12:00:04.000Z" },
  } };
  assert.equal(applyQueuedSubmission(state, sessionId, { prompt }, Date.parse("2026-08-30T12:01:00.000Z")), true);
  assert.equal(state.activeWriterDeliveries.first.submittedAt, "2026-08-30T12:01:00.000Z");
  assert.equal(state.activeWriterDeliveries.second.submittedAt, undefined);
  assert.equal(applyQueuedSubmission(state, sessionId, { user_prompt: prompt }, Date.parse("2026-08-30T12:01:01.000Z")), true);
  assert.equal(state.activeWriterDeliveries.second.submittedAt, "2026-08-30T12:01:01.000Z");
  assert.equal(JSON.stringify(state).includes(prompt), false);
  assert.equal(applyQueuedSubmission(state, sessionId, { prompt: "different" }, Date.parse("2026-08-30T12:01:02.000Z")), false);
  assert.equal(finishQueuedSubmission(state, sessionId), "first");
  assert.equal(state.activeWriterDeliveries.first, undefined);
  assert.equal(finishQueuedSubmission(state, sessionId), "second");
  assert.equal(finishQueuedSubmission(state, sessionId), null);
});

test("active-writer attachments survive generic sweeps until their queued turn stops", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-active-writer-attachments-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requestId = "reply-with-image";
  const oldDirectory = path.join(root, createHash("sha256").update(requestId).digest("hex"));
  const expiredDirectory = path.join(root, createHash("sha256").update("expired").digest("hex"));
  fs.mkdirSync(oldDirectory);
  fs.mkdirSync(expiredDirectory);
  const old = new Date("2026-08-27T12:00:00.000Z");
  fs.utimesSync(oldDirectory, old, old);
  fs.utimesSync(expiredDirectory, old, old);
  assert.equal(sweepMaterializedAttachments(root, Date.parse("2026-08-30T12:00:00.000Z"), [requestId]), 1);
  assert.equal(fs.existsSync(oldDirectory), true);
  assert.equal(fs.existsSync(expiredDirectory), false);
  assert.equal(sweepMaterializedAttachments(root, Date.parse("2026-08-30T12:00:00.000Z")), 1);
  assert.equal(fs.existsSync(oldDirectory), false);
});

test("native active-writer queue persists intent before one exact admission", () => {
  const delivery = { requestId: "reply-queue", sessionId };
  const calls = [];
  const result = queueThroughActiveWriter(delivery, "exact queued reply", {
    readPending: () => null,
    rememberStart: (...args) => calls.push(["start", ...args]),
    enqueue: (args) => { calls.push(["queue", args]); return { status: 0, error: null }; },
    rememberAdmission: (requestId) => calls.push(["admit", requestId]),
    clearPending: (requestId) => calls.push(["clear", requestId]),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    ["start", delivery, "exact queued reply"],
    ["queue", ["queue", "--thread", sessionId, "--message", "exact queued reply"]],
    ["admit", delivery.requestId],
  ]);
});

test("native active-writer queue never replays an uncertain attempt and clears only a rejection", () => {
  const delivery = { requestId: "reply-queue", sessionId };
  let cleared = false;
  assert.throws(
    () => queueThroughActiveWriter(delivery, "uncertain reply", {
      readPending: () => null,
      rememberStart: () => {},
      enqueue: () => ({ status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }),
      clearPending: () => { cleared = true; },
    }),
    CodexTurnStartUncertainError,
  );
  assert.equal(cleared, false);
  assert.throws(
    () => queueThroughActiveWriter(delivery, "rejected reply", {
      readPending: () => null,
      rememberStart: () => {},
      enqueue: () => ({ status: 2, error: null }),
      clearPending: () => { cleared = true; },
    }),
    CodexAttentionRequiredError,
  );
  assert.equal(cleared, true);
});

test("client state prunes expired admitted queue metadata without dropping unresolved uncertainty", () => {
  const state = { schemaVersion: 4, executions: {
    expired: { expiresAt: "2026-08-30T11:00:00.000Z" },
    current: { expiresAt: "2026-08-30T13:00:00.000Z" },
  }, activeWriterDeliveries: {
    admitted: { admittedAt: "2026-07-30T12:00:00.000Z", expiresAt: "2026-08-29T12:00:00.000Z" },
    submitted: { submittedAt: "2026-07-30T12:00:00.000Z", expiresAt: "2026-08-29T12:00:00.000Z" },
    uncertain: { uncertainUntil: "2026-07-30T12:02:00.000Z", expiresAt: "2026-08-29T12:00:00.000Z" },
  } };
  assert.equal(pruneClientState(state, Date.parse("2026-08-30T12:00:00.000Z")), state);
  assert.deepEqual(Object.keys(state.executions), ["current"]);
  assert.deepEqual(Object.keys(state.activeWriterDeliveries), ["uncertain"]);
});

test("remote broker fallback is pinned and only used for transport failures", () => {
  const commands = remoteBrokerCommands("claim", { host: "server-mac", lanHost: "server.local", hostKeyAlias: "100.64.0.1", node: "/node", brokerPath: "/broker" });
  assert.equal(commands[0].route, "ssh");
  assert.equal(commands[1].route, "lan-pinned");
  assert.deepEqual(selectRemoteBrokerCommand("claim", { ok: true }, { host: "server-mac", lanHost: "server.local", hostKeyAlias: "100.64.0.1", node: "/node", brokerPath: "/broker" }), commands[0]);
  assert.deepEqual(selectRemoteBrokerCommand("claim", { ok: false, stderr: "Connection timed out" }, { host: "server-mac", lanHost: "server.local", hostKeyAlias: "100.64.0.1", node: "/node", brokerPath: "/broker" }), commands[1]);
  assert.equal(selectRemoteBrokerCommand("claim", { ok: false, stderr: "Permission denied" }), null);
  assert.equal(isSshTransportFailure({ ok: false, stderr: "No route to host" }), true);
  assert.equal(isBrokerTransportUncertain("tailnet", { ok: false, status: 255, stderr: "Connection to server-mac closed" }), true);
  assert.equal(isBrokerTransportUncertain("local", { ok: false, status: 1, stderr: "invalid input" }), false);
});

test("a transport-uncertain idempotent route write retains completed execution for retry", () => {
  const error = Object.assign(new Error("Connection closed"), { brokerCommand: "create", brokerTransportUncertain: true });
  assert.equal(recoverableBrokerOperationFailure(error, { stage: "completed", sessionId, turnId: "turn" }), true);
  assert.equal(recoverableBrokerOperationFailure(error, { stage: "running", sessionId }), false);
  assert.equal(recoverableBrokerOperationFailure(Object.assign(new Error("rejected"), { brokerCommand: "create" }), { stage: "completed" }), false);
});

test("an intact broker rejection is terminal while a missing response remains uncertain", () => {
  assert.deepEqual(classifyBrokerFailure("local", { ok: false, status: 1, stdout: '{"ok":false,"status":"error","error":"invalid state"}', stderr: "" }), {
    brokerResponse: { ok: false, status: "error", error: "invalid state" },
    transportUncertain: false,
  });
  assert.deepEqual(classifyBrokerFailure("tailnet", { ok: false, status: 1, stdout: "", stderr: "remote process exited" }), {
    brokerResponse: null,
    transportUncertain: true,
  });
});

test("a definitive turn-start busy rejection resets ambiguity before FIFO retry", () => {
  const busy = new CodexTaskBusyError("busy", { turnStartRejected: true });
  assert.deepEqual(executionResetAfterDefiniteBusy(busy, { stage: "turn-starting", uncertainUntil: "future", turnId: null }), { stage: "thread-ready", uncertainUntil: null, turnId: null });
  assert.equal(executionResetAfterDefiniteBusy(new CodexTaskBusyError(), { stage: "turn-starting" }), null);
  assert.equal(executionResetAfterDefiniteBusy(busy, { stage: "running" }), null);
});
