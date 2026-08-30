#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bridgePaths, codexBinaryPath, isCodexHost, isGatewayHost, readConfig } from "./lib/runtime-config.mjs";

function command(binary, args, options = {}) {
  return spawnSync(binary, args, { encoding: "utf8", timeout: options.timeout ?? 10_000, cwd: options.cwd });
}

function mode(target) {
  try { return fs.statSync(target).mode & 0o777; } catch { return null; }
}

async function main() {
  const checks = [];
  let config;
  try {
    config = readConfig();
    checks.push({ name: "config", ok: mode(config._path) === 0o600, detail: config._path });
  } catch (error) {
    console.log(JSON.stringify({ ok: false, checks: [{ name: "config", ok: false, detail: error.message }] }, null, 2));
    process.exitCode = 1;
    return;
  }
  const paths = bridgePaths(config);
  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version });
  if (isCodexHost(config)) {
    const binary = codexBinaryPath(config);
    checks.push({ name: "codex", ok: fs.existsSync(binary), detail: binary });
    const cwd = config.codex?.defaultCwd ?? "";
    checks.push({ name: "codex-default-cwd", ok: path.isAbsolute(cwd) && fs.existsSync(cwd), detail: cwd || "missing" });
    const client = command(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-whatsapp-client.mjs"), "status"], { timeout: 20_000 });
    checks.push({ name: "client", ok: client.status === 0, detail: client.status === 0 ? "ready" : "not ready" });
  }
  if (isGatewayHost(config)) {
    const hermes = config.gateway?.hermesCheckout;
    const seam = typeof hermes === "string" && fs.existsSync(path.join(hermes, "gateway", "platforms", "base.py"))
      && fs.readFileSync(path.join(hermes, "gateway", "platforms", "base.py"), "utf8").includes("dispatch_exclusive_inbound");
    checks.push({ name: "hermes-seam", ok: seam, detail: hermes ?? "missing" });
    const plugin = path.join(os.homedir(), ".hermes", "plugins", "codex-whatsapp-bridge", "plugin.yaml");
    checks.push({ name: "hermes-plugin", ok: fs.existsSync(plugin), detail: plugin });
    checks.push({ name: "broker-state-parent", ok: fs.existsSync(path.dirname(paths.brokerState)), detail: path.dirname(paths.brokerState) });
    try {
      const response = await fetch(`${config.whatsapp.bridgeUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      checks.push({ name: "whatsapp-bridge", ok: response.ok, detail: config.whatsapp.bridgeUrl });
    } catch {
      checks.push({ name: "whatsapp-bridge", ok: false, detail: config.whatsapp.bridgeUrl });
    }
  }
  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, role: config.role, hostId: config.hostId, checks }, null, 2));
  if (!ok) process.exitCode = 1;
}

await main();
