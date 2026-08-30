import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const bridgeHookSpecs = [
  {
    eventName: "userPromptSubmit",
    matcher: null,
    timeoutSec: 8,
    statusMessage: "Accepting a queued WhatsApp reply",
  },
  {
    eventName: "stop",
    matcher: null,
    timeoutSec: 16 * 60,
    statusMessage: "Sending the completed turn to WhatsApp",
  },
];

export function canonicalPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function sameDefinition(hook, spec, command, sourcePath) {
  return (
    hook?.handlerType === "command" &&
    hook.command === command &&
    canonicalPath(hook.sourcePath) === canonicalPath(sourcePath) &&
    hook.eventName === spec.eventName &&
    (hook.matcher ?? null) === spec.matcher &&
    hook.timeoutSec === spec.timeoutSec &&
    (hook.statusMessage ?? null) === spec.statusMessage
  );
}

export function evaluateBridgeHookTrust(response, { command, sourcePath }) {
  const data = Array.isArray(response?.data) ? response.data : [];
  const hooks = data.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []));
  const issues = [];
  let trustedCount = 0;

  for (const spec of bridgeHookSpecs) {
    const exact = hooks.filter((hook) => sameDefinition(hook, spec, command, sourcePath));
    const label = spec.eventName;
    if (exact.length === 0) {
      const related = hooks.some(
        (hook) =>
          hook?.handlerType === "command" &&
          hook.command === command &&
          canonicalPath(hook.sourcePath) === canonicalPath(sourcePath) &&
          hook.eventName === spec.eventName,
      );
      issues.push(`${label}:${related ? "definition-mismatch" : "missing"}`);
      continue;
    }
    if (exact.length > 1) {
      issues.push(`${label}:duplicate`);
      continue;
    }
    const [hook] = exact;
    if (hook.enabled !== true) {
      issues.push(`${label}:disabled`);
    } else if (hook.trustStatus !== "trusted" && hook.trustStatus !== "managed") {
      issues.push(`${label}:${hook.trustStatus ?? "unknown-trust"}`);
    } else {
      trustedCount += 1;
    }
  }

  if (data.some((entry) => (entry?.errors ?? []).length > 0)) {
    issues.push("discovery-errors");
  }

  return {
    ok: issues.length === 0,
    ready: issues.length === 0,
    expectedCount: bridgeHookSpecs.length,
    trustedCount,
    issues,
  };
}

export function listCodexHooks({ codexBinary, cwd, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBinary, ["app-server", "--stdio"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Codex hook status timed out")));
    }, timeoutMs);

    child.on("error", (error) => finish(() => reject(error)));
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1_000);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          child.stdin.write(
            `${JSON.stringify({
              method: "hooks/list",
              id: 2,
              params: { cwds: [path.resolve(cwd)] },
            })}\n`,
          );
        } else if (message.id === 2) {
          if (message.error) {
            finish(() => reject(new Error("Codex hook status was rejected")));
          } else {
            finish(() => resolve(message.result));
          }
        }
      }
    });
    child.on("close", () => {
      if (!finished) {
        finish(() => reject(new Error(stderr.trim() || "Codex hook status ended early")));
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "codex-whatsapp-bridge",
            title: "Codex WhatsApp Bridge",
            version: "1",
          },
        },
      })}\n`,
    );
  });
}

export async function bridgeHookTrustStatus({ codexBinary, cwd, command, sourcePath }) {
  try {
    const response = await listCodexHooks({ codexBinary, cwd });
    return evaluateBridgeHookTrust(response, { command, sourcePath });
  } catch {
    return {
      ok: false,
      ready: false,
      expectedCount: bridgeHookSpecs.length,
      trustedCount: 0,
      issues: ["query-failed"],
    };
  }
}
