import { spawnSync } from "node:child_process";

export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 20_000,
    env: options.env ?? process.env,
    cwd: options.cwd,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
  });

  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error?.message ?? null,
    ok: result.status === 0 && !result.error,
  };
}

export function firstLine(value) {
  return String(value ?? "").split(/\r?\n/, 1)[0] ?? "";
}

export function parseJson(value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

export function redactText(value) {
  return String(value ?? "")
    .replaceAll(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
      "[REDACTED]",
    )
    .replaceAll(/(authorization:\s*bearer\s+)\S+/gi, "$1[REDACTED]");
}
