import fs from "node:fs";
import path from "node:path";

export function isBridgeHookCommand(command) {
  const parts = String(command ?? "").trim().split(/\s+/);
  return parts.length === 3
    && path.isAbsolute(parts[0])
    && path.isAbsolute(parts[1])
    && parts[1].endsWith("/scripts/codex-whatsapp-client.mjs")
    && parts[2] === "hook";
}

export function makeTreeOwnerWritable(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, (stat.mode & 0o777) | 0o700);
    for (const entry of fs.readdirSync(target)) {
      makeTreeOwnerWritable(path.join(target, entry));
    }
    return;
  }
  fs.chmodSync(target, (stat.mode & 0o777) | 0o600);
}

export function removeBridgeHooks(current) {
  const result = structuredClone(current ?? {});
  for (const event of Object.keys(result.hooks ?? {})) {
    for (const group of result.hooks[event] ?? []) {
      group.hooks = (group.hooks ?? []).filter(
        (hook) => !isBridgeHookCommand(hook.command),
      );
    }
    result.hooks[event] = result.hooks[event].filter((group) => group.hooks.length);
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  return result;
}
