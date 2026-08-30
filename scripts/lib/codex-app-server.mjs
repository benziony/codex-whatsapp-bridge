import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";

const RPC_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_CAPTURED_TEXT = 48_000;
const AMBIGUITY_WINDOW_MS = 2 * 60 * 1_000;
const MAX_BUFFERED_TURNS = 64;
const MAX_BUFFERED_ITEMS = 256;
const THREAD_LIST_PAGE_LIMIT = 100;
const THREAD_LIST_MAX_PAGES = 3;
const ALL_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

export class CodexTaskBusyError extends Error {
  constructor(message = "Codex task is busy", { turnStartRejected = false } = {}) {
    super(message);
    this.name = "CodexTaskBusyError";
    this.turnStartRejected = turnStartRejected;
  }
}

export class CodexActiveWriterError extends Error {
  constructor(message = "The Codex task is owned by another live writer") {
    super(message);
    this.name = "CodexActiveWriterError";
  }
}

export class CodexAttentionRequiredError extends Error {
  constructor(message = "This Codex task needs attention in Codex before it can continue.") {
    super(message);
    this.name = "CodexAttentionRequiredError";
  }
}

export class CodexThreadStartUncertainError extends Error {
  constructor(message = "Codex may have created the task, so the request is being held while its identity is recovered.") {
    super(message);
    this.name = "CodexThreadStartUncertainError";
  }
}

export class CodexTurnStartUncertainError extends Error {
  constructor(message = "Codex may have accepted the turn, so the request is being held instead of replayed.") {
    super(message);
    this.name = "CodexTurnStartUncertainError";
  }
}

function boundedText(value) {
  const body = String(value ?? "");
  return body.length <= MAX_CAPTURED_TEXT ? body : `${body.slice(0, MAX_CAPTURED_TEXT - 1)}…`;
}

export function codexTaskTitle(prompt) {
  let value = String(prompt ?? "").trim();
  const voicePrefix = "Voice note transcription (may contain errors):";
  if (value.startsWith(voicePrefix)) value = value.slice(voicePrefix.length).trim();
  value = value.replace(/<[^>]+>/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!value) return "WhatsApp request";
  return value.length <= 72 ? value : `${value.slice(0, 71).trimEnd()}…`;
}

export function turnResult(turn) {
  if (!turn || typeof turn !== "object") throw new Error("Codex returned an invalid turn");
  if (turn.status === "inProgress") throw new CodexTaskBusyError();
  if (turn.status !== "completed") throw new Error("Codex did not complete the turn");
  const updates = [];
  let finalText = "";
  let fallback = "";
  for (const item of turn.items ?? []) {
    if (item?.type !== "agentMessage" || typeof item.text !== "string" || !item.text.trim()) continue;
    const body = boundedText(item.text);
    if (item.phase === "commentary") {
      if (updates.at(-1) !== body) updates.push(body);
    } else {
      fallback = body;
      if (item.phase === "final_answer") finalText = body;
    }
  }
  finalText ||= fallback;
  if (!finalText.trim()) throw new Error("Codex completed without a final response");
  return { sessionId: null, turnId: turn.id, finalText, updates };
}

export function findRequestTurn(thread, requestId, turnId = null) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  if (turnId) return turns.find((turn) => turn?.id === turnId) ?? null;
  return turns.find((turn) => (turn?.items ?? []).some((item) => item?.type === "userMessage" && item.clientId === requestId)) ?? null;
}

function uncertaintyDeadline(now = Date.now()) {
  return new Date(now + AMBIGUITY_WINDOW_MS).toISOString();
}

function uncertaintyExpired(value, now = Date.now()) {
  const parsed = Date.parse(value ?? "");
  return !Number.isFinite(parsed) || parsed <= now;
}

function threadCorrelation(requestId) {
  const value = `whatsapp:${requestId}`;
  if (value.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("The WhatsApp request identifier is invalid");
  return value;
}

function eventTurnKey(threadId, turnId) {
  return typeof threadId === "string" && typeof turnId === "string" ? `${threadId}\u0000${turnId}` : null;
}

function boundedItem(item) {
  if (!item || typeof item !== "object") return item;
  return typeof item.text === "string" ? { ...item, text: boundedText(item.text) } : item;
}

class AppServerConnection {
  constructor({ codexBinary, cwd, spawnTask = spawn, rpcTimeoutMs = RPC_TIMEOUT_MS }) {
    this.codexBinary = codexBinary;
    this.cwd = cwd;
    this.spawnTask = spawnTask;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.events = new EventEmitter();
    this.turnEvents = new Map();
    this.attentionRequired = false;
    this.closed = false;
    this.closeError = null;
  }

  async open() {
    this.child = this.spawnTask(this.codexBinary, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    this.child.on("error", (error) => this.#closeWithError(error));
    this.child.on("close", () => this.#closeWithError(new Error("Codex App Server stopped unexpectedly")));
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.#receive(message);
      }
    });
    try {
      await this.request("initialize", { clientInfo: { name: "codex-whatsapp-bridge", title: "Codex WhatsApp Bridge", version: "1" } });
      this.notify("initialized");
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #closeWithError(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.events.emit("closed", error);
  }

  #bufferTurnEvent(message) {
    const params = message?.params;
    const turnId = message.method === "turn/completed" ? params?.turn?.id : params?.turnId;
    const key = eventTurnKey(params?.threadId, turnId);
    if (!key) return;
    let buffered = this.turnEvents.get(key);
    if (!buffered) {
      buffered = { items: [], completed: null };
      this.turnEvents.set(key, buffered);
      while (this.turnEvents.size > MAX_BUFFERED_TURNS) this.turnEvents.delete(this.turnEvents.keys().next().value);
    }
    if (message.method === "item/completed" && params.item?.id && params.item?.type === "agentMessage" && buffered.items.length < MAX_BUFFERED_ITEMS) {
      buffered.items.push(boundedItem(params.item));
    }
    if (message.method === "turn/completed") {
      const items = (params.turn?.items ?? []).filter((item) => item?.type === "agentMessage").slice(-MAX_BUFFERED_ITEMS).map(boundedItem);
      buffered.completed = { ...params, turn: { ...params.turn, items } };
    }
  }

  #receive(message) {
    if (message?.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error("Codex App Server rejected the request");
        error.rpcError = message.error;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (message?.id !== undefined && typeof message.method === "string") {
      this.attentionRequired = true;
      const cancellable = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
      if (cancellable.has(message.method)) this.#write({ id: message.id, result: { decision: "cancel" } });
      else this.#write({ id: message.id, error: { code: -32001, message: "This request requires the Codex app." } });
      this.events.emit("attention-required");
      return;
    }
    if (typeof message?.method === "string") {
      if (message.method === "item/completed" || message.method === "turn/completed") this.#bufferTurnEvent(message);
      this.events.emit(message.method, message.params);
    }
  }

  #write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error("Codex App Server is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  request(method, params, timeoutMs = this.rpcTimeoutMs) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex App Server request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitForTurn(threadId, turnId, timeoutMs = TURN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const key = eventTurnKey(threadId, turnId);
      const streamedItems = [...(this.turnEvents.get(key)?.items ?? [])];
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.events.off("item/completed", itemCompleted);
        this.events.off("turn/completed", completed);
        this.events.off("attention-required", attentionRequired);
        this.events.off("closed", closed);
        this.turnEvents.delete(key);
      };
      const itemCompleted = (params) => {
        if (params?.threadId === threadId && params?.turnId === turnId && params.item?.id && params.item?.type === "agentMessage" && streamedItems.length < MAX_BUFFERED_ITEMS) streamedItems.push(boundedItem(params.item));
      };
      const completed = (params) => {
        if (params?.threadId !== threadId || params?.turn?.id !== turnId) return;
        cleanup();
        if (this.attentionRequired) reject(new CodexAttentionRequiredError());
        else {
          const items = [...(params.turn.items ?? [])];
          const known = new Set(items.map((item) => item?.id).filter(Boolean));
          for (const item of streamedItems) if (!known.has(item.id)) items.push(item);
          resolve({ ...params.turn, items });
        }
      };
      const attentionRequired = () => { cleanup(); reject(new CodexAttentionRequiredError()); };
      const closed = (error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Codex turn timed out")); }, timeoutMs);
      if (this.attentionRequired) return attentionRequired();
      this.events.on("item/completed", itemCompleted);
      this.events.on("turn/completed", completed);
      this.events.on("attention-required", attentionRequired);
      this.events.on("closed", closed);
      const alreadyCompleted = this.turnEvents.get(key)?.completed;
      if (alreadyCompleted) return completed(alreadyCompleted);
      if (this.closed) closed(this.closeError ?? new Error("Codex App Server stopped unexpectedly"));
    });
  }

  async findThreadBySource(threadSource, cwd) {
    let cursor = null;
    for (let page = 0; page < THREAD_LIST_MAX_PAGES; page += 1) {
      const listed = await this.request("thread/list", {
        archived: false,
        cwd,
        cursor,
        limit: THREAD_LIST_PAGE_LIMIT,
        sortKey: "created_at",
        sortDirection: "desc",
        sourceKinds: ALL_THREAD_SOURCE_KINDS,
        useStateDbOnly: true,
      });
      const match = (listed?.data ?? []).find((thread) => thread?.threadSource === threadSource && thread?.cwd === cwd);
      if (match) return match;
      cursor = listed?.nextCursor ?? null;
      if (!cursor) break;
    }
    return null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child?.kill(); } catch { /* process exit is best effort */ }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex App Server closed"));
    }
    this.pending.clear();
  }
}

function threadStatus(thread) {
  return thread?.status?.type ?? "notLoaded";
}

function isBusyRpcError(error) {
  return /activeTurnNotSteerable|already has an active|active turn/i.test(JSON.stringify(error?.rpcError ?? {}));
}

export function isActiveWriterRpcError(error, sessionId = null) {
  const message = String(error?.rpcError?.message ?? "");
  if (!/already has (?:an )?(?:active writer|live local writer)/i.test(message)) return false;
  return sessionId ? message.includes(String(sessionId)) : true;
}

export async function runCodexAppServerTurn({
  codexBinary,
  cwd,
  prompt,
  attachments = [],
  requestId,
  sessionId = null,
  title = codexTaskTitle(prompt),
  execution = null,
  onThreadCreating = () => {},
  onThreadReady = () => {},
  onTurnStarting = () => {},
  onTurnStarted = () => {},
  spawnTask = spawn,
  rpcTimeoutMs = RPC_TIMEOUT_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
}) {
  if (!codexBinary || !cwd || !requestId || typeof prompt !== "string" || (!prompt.trim() && !attachments.length)) throw new Error("Codex App Server turn input is invalid");
  if (!Array.isArray(attachments) || attachments.some((attachment) => attachment?.kind !== "image" || typeof attachment.path !== "string" || !path.isAbsolute(attachment.path))) {
    throw new Error("Codex App Server attachment input is invalid");
  }
  const turnInput = [
    ...(prompt.trim() ? [{ type: "text", text: prompt }] : []),
    ...attachments.map((attachment) => ({ type: "localImage", path: attachment.path })),
  ];
  const connection = await new AppServerConnection({ codexBinary, cwd, spawnTask, rpcTimeoutMs }).open();
  try {
    let thread;
    const recoverySessionId = execution?.sessionId ?? sessionId;
    if (execution?.stage && recoverySessionId) {
      let read;
      try {
        read = await connection.request("thread/read", { threadId: recoverySessionId, includeTurns: true });
      } catch (error) {
        if (execution.stage === "running" || execution.stage === "turn-starting" || execution.stage === "turn-start-uncertain") {
          if (!uncertaintyExpired(execution.uncertainUntil)) throw new CodexTurnStartUncertainError();
          throw new CodexAttentionRequiredError("Codex may have accepted this turn, but its result cannot be recovered safely. Open the task in Codex.");
        }
        throw error;
      }
      thread = read?.thread;
      if (!thread || thread.id !== recoverySessionId) throw new Error("The Codex task could not be recovered");
      const recovered = findRequestTurn(thread, requestId, execution.turnId ?? null);
      if (recovered) {
        const result = turnResult(recovered);
        return { ...result, sessionId: recoverySessionId, title: thread.name ?? title, cwd: thread.cwd ?? cwd, recovered: true };
      }
      if (threadStatus(thread) === "active") throw new CodexTaskBusyError();
      if (execution.stage === "running") {
        throw new CodexAttentionRequiredError("Codex accepted this turn previously, but its result cannot be recovered safely. Open the task in Codex.");
      }
      if (execution.stage === "turn-starting" || execution.stage === "turn-start-uncertain") {
        if (!uncertaintyExpired(execution.uncertainUntil)) throw new CodexTurnStartUncertainError();
        throw new CodexAttentionRequiredError("Codex may have accepted this turn, but its result cannot be recovered safely. Open the task in Codex.");
      }
    }

    if (!thread && !recoverySessionId && execution?.stage === "thread-creating") {
      const source = execution.threadSource;
      if (typeof source !== "string" || !source) throw new CodexAttentionRequiredError("The pending Codex task cannot be recovered safely.");
      let listed;
      try {
        listed = await connection.findThreadBySource(source, cwd);
      } catch (error) {
        if (!uncertaintyExpired(execution.uncertainUntil)) throw new CodexThreadStartUncertainError();
        throw new CodexAttentionRequiredError("Codex may have created this task, but its identity cannot be recovered safely. Open Codex before retrying.");
      }
      if (listed?.id) {
        let resumed;
        try { resumed = await connection.request("thread/resume", { threadId: listed.id }); }
        catch {
          if (!uncertaintyExpired(execution.uncertainUntil)) throw new CodexThreadStartUncertainError();
          throw new CodexAttentionRequiredError("Codex created this task, but it cannot be resumed safely. Open Codex before retrying.");
        }
        thread = resumed?.thread;
        if (!thread || thread.id !== listed.id) throw new Error("The created Codex task could not be resumed");
        try { await onThreadReady({ sessionId: thread.id, title: thread.name ?? title, cwd: thread.cwd ?? cwd, threadSource: source }); }
        catch {
          if (!uncertaintyExpired(execution.uncertainUntil)) throw new CodexThreadStartUncertainError();
          throw new CodexAttentionRequiredError("Codex created this task, but its broker binding cannot be recovered safely. Open Codex before retrying.");
        }
        await connection.request("thread/name/set", { threadId: thread.id, name: title });
      } else if (!uncertaintyExpired(execution.uncertainUntil)) {
        throw new CodexThreadStartUncertainError();
      } else {
        throw new CodexAttentionRequiredError("Codex may have created this task, but its identity cannot be recovered safely. Open Codex before retrying.");
      }
    }

    if (!thread) {
      if (sessionId) {
        let resumed;
        try {
          resumed = await connection.request("thread/resume", { threadId: sessionId });
        } catch (error) {
          if (isActiveWriterRpcError(error, sessionId)) throw new CodexActiveWriterError();
          throw error;
        }
        thread = resumed?.thread;
        if (!thread || thread.id !== sessionId) throw new Error("The Codex task is unavailable");
        if (threadStatus(thread) === "active") throw new CodexTaskBusyError();
      } else {
        const threadSource = threadCorrelation(requestId);
        const uncertainUntil = uncertaintyDeadline();
        await onThreadCreating({ threadSource, uncertainUntil, title, cwd });
        let started;
        try {
          started = await connection.request("thread/start", { cwd, serviceName: "codex-whatsapp-bridge", threadSource });
        } catch (error) {
          if (!error?.rpcError) throw new CodexThreadStartUncertainError();
          throw error;
        }
        thread = started?.thread;
        if (!thread?.id) throw new CodexThreadStartUncertainError("Codex returned no task identifier, so the correlated task must be recovered before continuing.");
        try { await onThreadReady({ sessionId: thread.id, title, cwd: thread.cwd ?? cwd, threadSource }); }
        catch { throw new CodexThreadStartUncertainError(); }
        await connection.request("thread/name/set", { threadId: thread.id, name: title });
      }
    }

    await onThreadReady({ sessionId: thread.id, title: thread.name ?? title, cwd: thread.cwd ?? cwd });
    const uncertainUntil = uncertaintyDeadline();
    await onTurnStarting({ sessionId: thread.id, title: thread.name ?? title, cwd: thread.cwd ?? cwd, uncertainUntil });
    let startedTurn;
    try {
      startedTurn = await connection.request("turn/start", {
        threadId: thread.id,
        input: turnInput,
        clientUserMessageId: requestId,
      });
    } catch (error) {
      if (isBusyRpcError(error)) throw new CodexTaskBusyError("Codex task is busy", { turnStartRejected: true });
      if (!error?.rpcError) throw new CodexTurnStartUncertainError();
      throw error;
    }
    const turnId = startedTurn?.turn?.id;
    if (!turnId) throw new CodexTurnStartUncertainError("Codex returned no turn identifier, so the accepted request must be recovered before continuing.");
    try { await onTurnStarted({ sessionId: thread.id, turnId, title: thread.name ?? title, cwd: thread.cwd ?? cwd }); }
    catch { throw new CodexTurnStartUncertainError(); }
    let completed;
    try { completed = await connection.waitForTurn(thread.id, turnId, turnTimeoutMs); }
    catch (error) {
      if (error instanceof CodexAttentionRequiredError) throw error;
      throw new CodexTurnStartUncertainError();
    }
    const result = turnResult(completed);
    return { ...result, sessionId: thread.id, title: thread.name ?? title, cwd: thread.cwd ?? cwd, recovered: false };
  } finally {
    connection.close();
  }
}
