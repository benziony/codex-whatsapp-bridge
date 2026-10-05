import crypto from "node:crypto";

export const ROUTINE_TIME_ZONE = "America/New_York";
export const ROUTINE_HOUR = 18;

export function normalizeTrailing(value) {
  return String(value ?? "").replace(/\s+$/u, "");
}

export function routineConfigFrom(runtimeConfig) {
  const raw = runtimeConfig?.codex?.routineNotifications;
  if (!raw || typeof raw !== "object" || raw.mode !== "daily") return { enabled: false };
  const timeZone = raw.timeZone ?? ROUTINE_TIME_ZONE;
  const hour = raw.hour ?? ROUTINE_HOUR;
  if (typeof timeZone !== "string" || !Number.isInteger(hour) || hour < 0 || hour > 23) return { enabled: false };
  try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { return { enabled: false }; }
  return { enabled: true, mode: "daily", timeZone, hour };
}

export function localDateString(nowMs, timeZone = ROUTINE_TIME_ZONE) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(nowMs));
}

export function localHour(nowMs, timeZone = ROUTINE_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(new Date(nowMs));
  const h0 = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
  return h0 === 24 ? 0 : h0;
}

export function isDigestDue(nowMs, { timeZone = ROUTINE_TIME_ZONE, hour = ROUTINE_HOUR } = {}) {
  return localHour(nowMs, timeZone) >= hour;
}

const HEALTHY_LINE = /^(?:no changes?|unchanged(?: checks?)?|nothing to do|nothing changed|all (?:checks? )?(?:passed|healthy|green|ok)|healthy|checks? (?:completed|finished) successfully(?:,? nothing changed)?|no action (?:needed|required)|no issues? found)[.!]?$/i;
const ASK = /(\?|please\s+(approve|confirm|review|decide)|approval\s+(needed|required)|input\s+(needed|required)|needs?\s+(your\s+)?(approval|attention|input))/i;
const FAILURE = /\b(blocked|failed|failure|error|exception)\b/i;
const WORK_COMPLETION = /\b(shipped|deployed|merged|published|fixed|resolved|implemented)\b/i;

export function fingerprintError(finalText, knownCodes = [], scope = "") {
  const body = String(finalText ?? "");
  const scoped = (s) => crypto.createHash("sha256").update(`${scope}::${s}`).digest("hex");
  for (const code of knownCodes) {
    if (code && body.includes(String(code))) {
      const line = body.split("\n").find((l) => l.includes(String(code))) ?? String(code);
      return scoped(`code:${code}|line:${line.trim()}`);
    }
  }
  const m = body.match(/\b([A-Z]+_[A-Z_0-9]+|E[A-Z0-9_]+)\b/);
  if (m) {
    const line = body.split("\n").find((l) => l.includes(m[1])) ?? m[1];
    return scoped(`code:${m[1]}|line:${line.trim()}`);
  }
  const errLine = body.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => /(blocked|failed|failure|error\b|exception)/i.test(l)) ?? body;
  return scoped(`text:${errLine}`);
}

export function sanitizeLabel(value, fallback = "routine check") {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(normalized)) return fallback;
  if (/\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|secret)\b\s*[:=]\s*\S+/i.test(normalized)) return fallback;
  if (/\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/i.test(normalized)) return fallback;
  if (/[?&](?:token|key|secret|password|code)=[^\s&]+/i.test(normalized)) return fallback;
  if (/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[oprsu]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/.test(normalized)) return fallback;
  if (/(?:\/Users\/|\/home\/|\/root\/|C:[\\/]Users[\\/])[^\s]*/.test(normalized)) return fallback;
  if (/https?:\/\/[^\s]*?(token|key|secret|password|auth)=[^\s]*/i.test(normalized)) return fallback;
  return normalized.slice(0, 120);
}

export function classifyRoutineTurn(input = {}) {
  const { threadSource, firstUserMessage, currentPrompt, promptReadable, finalText } = input;
  if (threadSource !== "automation") return { defer: false, reason: "non-automation" };
  if (!promptReadable || typeof currentPrompt !== "string") return { defer: false, reason: "missing-prompt" };
  if (normalizeTrailing(currentPrompt) !== normalizeTrailing(firstUserMessage ?? "")) return { defer: false, reason: "followup" };
  const body = String(finalText ?? "");
  if (ASK.test(body)) return { defer: false, reason: "explicit-ask" };
  if (WORK_COMPLETION.test(body)) return { defer: false, reason: "completion" };
  if (FAILURE.test(body)) return { defer: false, reason: "new-failure" };
  const lines = body.replace(/[*_`]/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length && lines.every((line) => HEALTHY_LINE.test(line))
    ? { defer: true, reason: "healthy" } : { defer: false, reason: "unknown" };
}

export function formatDigest({ date, items }) {
  const header = `*Routine checks · ${date}*\n_Informational daily digest. Reply to an individual update or send a fresh message for follow-ups._`;
  const lines = [];
  let remaining = 3900 - header.length - 2 - 100;
  let overflow = 0;
  for (const item of items) {
    const line = `- ${sanitizeLabel(item.label)} · ${sanitizeLabel(item.status)} · x${item.count}`;
    if (line.length + 1 <= remaining) { lines.push(line); remaining -= line.length + 1; }
    else overflow += item.count;
  }
  if (overflow) lines.push(`- Additional routine checks · x${overflow}`);
  return `${header}\n\n${lines.join("\n")}`;
}
