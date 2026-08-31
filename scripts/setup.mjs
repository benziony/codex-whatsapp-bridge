#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configPath, readConfig } from "./lib/runtime-config.mjs";

const apply = process.argv.includes("--apply");
const nonInteractive = process.argv.includes("--non-interactive");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const targetConfig = configPath();
const existing = readConfig({ required: false });
const valueFor = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
};
const exactChat = /^[0-9]{1,32}(?:-[0-9]{1,32})?@g\.us$/;
const exactUser = /^[0-9]{1,32}@(s\.whatsapp\.net|lid)$/;
const supportedHermesCommit = "4f22543509d1b91dc45bcb369447126c5eb14fb7";
const hermesPatch = path.join(root, "patches", "hermes-compat.patch");

function shellTransportSafePath(value, name) {
  if (!path.isAbsolute(value) || !/^\/[A-Za-z0-9._/@+-]+$/.test(value)) {
    throw new Error(`${name} must be an absolute path using only shell-safe path characters`);
  }
  return value;
}

async function answer(rl, name, question, fallback) {
  const supplied = valueFor(name);
  if (supplied !== undefined) return supplied;
  if (nonInteractive) return fallback;
  const response = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
  return response || fallback;
}

function command(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 30_000,
  });
}

function secureJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(target), 0o700);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function hermesCompatibilityReady(checkout) {
  const base = path.join(checkout, "gateway", "platforms", "base.py");
  const adapter = path.join(checkout, "plugins", "platforms", "whatsapp", "adapter.py");
  if (!fs.existsSync(base) || !fs.existsSync(adapter)) return false;
  return fs.readFileSync(base, "utf8").includes("dispatch_exclusive_inbound")
    && fs.readFileSync(adapter, "utf8").includes("async def add_reaction");
}

function ensureHermesCompatibility(checkout) {
  if (hermesCompatibilityReady(checkout)) return { status: "native", applied: false };
  if (!fs.existsSync(path.join(checkout, ".git"))) {
    throw new Error("Hermes checkout is not a Git checkout");
  }
  const dirty = command("/usr/bin/git", ["status", "--porcelain"], { cwd: checkout });
  if (dirty.status !== 0 || dirty.stdout.trim()) {
    throw new Error("Hermes needs the compatibility seam, but its checkout is not clean");
  }
  const revision = command("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: checkout });
  if (revision.status !== 0 || revision.stdout.trim() !== supportedHermesCommit) {
    throw new Error(`Hermes needs the compatibility seam and must be at supported commit ${supportedHermesCommit}`);
  }
  const checked = command("/usr/bin/git", ["apply", "--check", hermesPatch], { cwd: checkout });
  if (checked.status !== 0) throw new Error(checked.stderr || "Hermes compatibility patch does not apply cleanly");
  const applied = command("/usr/bin/git", ["apply", hermesPatch], { cwd: checkout });
  if (applied.status !== 0) {
    throw new Error(applied.stderr || "Hermes compatibility patch could not be verified");
  }
  if (!hermesCompatibilityReady(checkout)) {
    command("/usr/bin/git", ["apply", "--reverse", hermesPatch], { cwd: checkout });
    throw new Error("Hermes compatibility patch could not be verified");
  }
  return { status: "compatibility-patch", applied: true };
}

function mergeHooks(current, hookCommand) {
  const result = structuredClone(current ?? {});
  result.hooks ??= {};
  for (const [event, timeout, statusMessage] of [
    ["UserPromptSubmit", 8, "Accepting a queued WhatsApp reply"],
    ["Stop", 16 * 60, "Sending the completed turn to WhatsApp"],
  ]) {
    result.hooks[event] ??= [];
    for (const group of result.hooks[event]) {
      group.hooks = (group.hooks ?? []).filter(
        (hook) => !String(hook.command ?? "").includes("codex-whatsapp-client.mjs"),
      );
    }
    result.hooks[event] = result.hooks[event].filter((group) => group.hooks.length);
    result.hooks[event].push({
      hooks: [{ type: "command", command: hookCommand, timeout, statusMessage }],
    });
  }
  return result;
}

function plist({ label, args, interval, stdout, stderr }) {
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escape(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escape(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(home)}</string><key>CODEX_WHATSAPP_CONFIG</key><string>${escape(targetConfig)}</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>${interval}</integer>
<key>StandardOutPath</key><string>${escape(stdout)}</string>
<key>StandardErrorPath</key><string>${escape(stderr)}</string>
</dict></plist>\n`;
}

function installPlist(label, content, snapshot) {
  const target = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  snapshot(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  command("/bin/launchctl", ["bootout", `${domain}/${label}`]);
  const loaded = command("/bin/launchctl", ["bootstrap", domain, target]);
  if (loaded.status !== 0) throw new Error(loaded.stderr || `Could not load ${label}`);
  return target;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    shellTransportSafePath(root, "Bridge repository path");
    shellTransportSafePath(process.execPath, "Local Node binary");
    const role = await answer(rl, "role", "Role (combined, gateway, codex)", existing?.role ?? "combined");
    if (!new Set(["combined", "gateway", "codex"]).has(role)) throw new Error("Invalid role");
    if (existing?.role && existing.role !== role) {
      throw new Error(
        `Changing an installed role from ${existing.role} to ${role} requires a reviewed migration so stale hooks, plugins, and LaunchAgents cannot remain active`,
      );
    }
    const hostId = await answer(rl, "host-id", "Stable name for this Mac", existing?.hostId ?? os.hostname().split(".")[0]);
    const isGateway = role !== "codex";
    const isCodex = role !== "gateway";
    const chatId = isGateway
      ? await answer(rl, "chat-id", "Dedicated WhatsApp group JID", existing?.whatsapp?.chatId ?? "")
      : existing?.whatsapp?.chatId ?? "";
    if (isGateway && !exactChat.test(chatId)) throw new Error("chat-id must be an exact @g.us JID");
    const senderText = isGateway
      ? await answer(rl, "allowed-senders", "Allowed sender JIDs, comma separated", (existing?.whatsapp?.allowedSenders ?? []).join(","))
      : "";
    const allowedSenders = senderText.split(",").map((value) => value.trim()).filter(Boolean);
    if (isGateway && (!allowedSenders.length || allowedSenders.some((value) => !exactUser.test(value)))) {
      throw new Error("allowed-senders must contain exact @s.whatsapp.net or @lid JIDs");
    }
    const defaultCwd = isCodex
      ? path.resolve(await answer(rl, "default-cwd", "Working directory for new Codex tasks", existing?.codex?.defaultCwd ?? process.cwd()))
      : existing?.codex?.defaultCwd ?? "";
    const codexTargetHost = isGateway
      ? await answer(rl, "codex-host-id", "Host ID for new unquoted Codex tasks", existing?.codexInbox?.originHost ?? (isCodex ? hostId : ""))
      : hostId;
    const codexTargetCwd = isGateway
      ? await answer(rl, "codex-cwd", "New-task working directory on that Codex Mac", existing?.codexInbox?.cwd ?? defaultCwd)
      : defaultCwd;
    if (isGateway && (!codexTargetHost || !path.isAbsolute(codexTargetCwd))) {
      throw new Error("The gateway needs an exact Codex host ID and absolute new-task directory");
    }
    const progressAnswer = isCodex
      ? await answer(rl, "progress", "Mirror progress as well as finals? (yes/no)", existing?.codex?.mirrorProgress ? "yes" : "no")
      : "no";
    const hermesCheckout = isGateway
      ? path.resolve(await answer(rl, "hermes-checkout", "Hermes checkout", existing?.gateway?.hermesCheckout ?? path.join(home, ".hermes", "hermes-agent")))
      : existing?.gateway?.hermesCheckout ?? "";
    const hermesPythonOverride = isGateway
      ? await answer(rl, "hermes-python", "Hermes Python binary", existing?.gateway?.hermesPython ?? "")
      : existing?.gateway?.hermesPython ?? "";
    const gatewaySsh = role === "codex"
      ? await answer(rl, "gateway-ssh", "Gateway SSH host", existing?.gateway?.sshHost ?? "")
      : existing?.gateway?.sshHost ?? "";
    const gatewayRepo = role === "codex"
      ? await answer(rl, "gateway-repository", "Bridge repository path on gateway", existing?.gateway?.repositoryPath ?? root)
      : root;
    shellTransportSafePath(gatewayRepo, "gateway-repository");
    const gatewayNode = role === "codex"
      ? await answer(rl, "gateway-node", "Node binary path on gateway", existing?.gateway?.node ?? "/opt/homebrew/bin/node")
      : process.execPath;
    shellTransportSafePath(gatewayNode, "gateway-node");
    const gatewayAttachments = role === "codex"
      ? await answer(rl, "gateway-attachments", "Broker attachment directory on gateway", existing?.gateway?.attachmentPath ?? "")
      : existing?.gateway?.attachmentPath ?? path.join(path.dirname(targetConfig), "broker", "attachments");
    if (role === "codex") shellTransportSafePath(gatewayAttachments, "gateway-attachments");
    if (role === "codex" && !gatewaySsh.trim()) throw new Error("gateway-ssh is required for split topology");
    const hermesPythonCandidates = [
      path.join(hermesCheckout, ".venv", "bin", "python"),
      path.join(hermesCheckout, "venv", "bin", "python"),
    ];
    const hermesPython = hermesPythonOverride
      ? shellTransportSafePath(path.resolve(hermesPythonOverride), "hermes-python")
      : (hermesPythonCandidates.find(fs.existsSync) ?? "");
    let attachmentSourceRoots = existing?.whatsapp?.attachmentSourceRoots ?? [];
    if (isGateway && hermesPython) {
      const roots = command(hermesPython, [path.join(root, "scripts", "hermes-media-roots.py")], { cwd: hermesCheckout });
      if (roots.status === 0) attachmentSourceRoots = JSON.parse(roots.stdout);
    }
    const config = {
      schemaVersion: 1,
      role,
      hostId,
      gateway: {
        repositoryPath: gatewayRepo,
        hermesCheckout,
        ...(hermesPython ? { hermesPython } : {}),
        node: gatewayNode,
        ...(existing?.gateway?.statePath ? { statePath: existing.gateway.statePath } : {}),
        ...(existing?.gateway?.brokerPath ? { brokerPath: existing.gateway.brokerPath } : {}),
        ...(gatewaySsh ? { sshHost: gatewaySsh } : {}),
        ...(existing?.gateway?.lanHost ? { lanHost: existing.gateway.lanHost } : {}),
        ...(existing?.gateway?.hostKeyAlias ? { hostKeyAlias: existing.gateway.hostKeyAlias } : {}),
        ...(gatewayAttachments ? { attachmentPath: gatewayAttachments } : {}),
      },
      whatsapp: {
        chatId,
        allowedSenders,
        bridgeUrl: existing?.whatsapp?.bridgeUrl ?? "http://127.0.0.1:3000",
        attachmentSourceRoots,
      },
      codex: {
        binary: existing?.codex?.binary ?? "/opt/homebrew/bin/codex",
        defaultCwd,
        mirrorProgress: /^y(es)?$/i.test(progressAnswer),
        ...(existing?.codex?.statePath ? { statePath: existing.codex.statePath } : {}),
        ...(existing?.codex?.attachmentPath ? { attachmentPath: existing.codex.attachmentPath } : {}),
      },
      codexInbox: isGateway
        ? { originHost: codexTargetHost, cwd: codexTargetCwd }
        : null,
    };
    const plan = {
      mode: apply ? "apply" : "dry-run",
      configPath: targetConfig,
      role,
      hostId,
      dedicatedChatConfigured: Boolean(chatId),
      allowedSenderCount: allowedSenders.length,
      mirrorProgress: config.codex.mirrorProgress,
      gateway: {
        repositoryPath: gatewayRepo,
        node: gatewayNode,
        ...(hermesPython ? { hermesPython } : {}),
        ...(gatewaySsh ? { sshHost: gatewaySsh } : {}),
        ...(gatewayAttachments ? { attachmentPath: gatewayAttachments } : {}),
      },
      codexTarget: isGateway ? config.codexInbox : { hostId, cwd: defaultCwd },
      hermesPlugin: isGateway ? path.join(home, ".hermes", "plugins", "codex-whatsapp-bridge") : null,
      hermesCompatibility: isGateway
        ? (hermesCompatibilityReady(hermesCheckout) ? "native" : `patch for ${supportedHermesCommit}`)
        : null,
      codexHooks: isCodex ? path.join(home, ".codex", "hooks.json") : null,
      launchAgents: [isCodex ? "com.codex-whatsapp-bridge.client" : null, isGateway ? "com.codex-whatsapp-bridge.updates" : null].filter(Boolean),
    };
    console.log(JSON.stringify(plan, null, 2));
    if (!apply) return;

    const backup = path.join(path.dirname(targetConfig), "backups", new Date().toISOString().replaceAll(/[:.]/g, "-"));
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const snapshots = [];
    const touchedServices = [];
    let hermesPatchApplied = false;
    const snapshot = (target) => {
      if (snapshots.some((entry) => entry.target === target)) return;
      const existed = fs.existsSync(target);
      const saved = path.join(backup, `item-${snapshots.length}`);
      if (existed) fs.cpSync(target, saved, { recursive: true });
      snapshots.push({ target, existed, saved });
    };
    const rollback = () => {
      const domain = `gui/${process.getuid()}`;
      for (const label of touchedServices) command("/bin/launchctl", ["bootout", `${domain}/${label}`]);
      for (const entry of [...snapshots].reverse()) {
        fs.rmSync(entry.target, { recursive: true, force: true });
        if (entry.existed) {
          fs.mkdirSync(path.dirname(entry.target), { recursive: true });
          fs.cpSync(entry.saved, entry.target, { recursive: true });
        }
      }
      for (const label of touchedServices) {
        const target = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
        if (fs.existsSync(target)) command("/bin/launchctl", ["bootstrap", domain, target]);
      }
      if (hermesPatchApplied) {
        const checked = command("/usr/bin/git", ["apply", "--reverse", "--check", hermesPatch], { cwd: hermesCheckout });
        if (checked.status === 0) command("/usr/bin/git", ["apply", "--reverse", hermesPatch], { cwd: hermesCheckout });
      }
    };

    try {
      if (isGateway) {
        if (!hermesPython) throw new Error("Hermes Python environment was not found");
        const compatibility = ensureHermesCompatibility(hermesCheckout);
        hermesPatchApplied = compatibility.applied;
      }
      snapshot(targetConfig);
      secureJson(targetConfig, config);

      const logs = path.join(home, "Library", "Logs", "CodexWhatsAppBridge");
      fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
      if (isGateway) {
        const hermesConfig = path.join(home, ".hermes", "config.yaml");
        const pluginTarget = path.join(home, ".hermes", "plugins", "codex-whatsapp-bridge");
        snapshot(hermesConfig);
        snapshot(pluginTarget);
        fs.rmSync(pluginTarget, { recursive: true, force: true });
        fs.cpSync(path.join(root, "hermes-plugin"), pluginTarget, { recursive: true });
        const configured = command(hermesPython, [
          path.join(root, "scripts", "configure-hermes.py"),
          "--config", hermesConfig,
          "--chat-id", chatId,
          ...allowedSenders.flatMap((sender) => ["--allowed-sender", sender]),
        ], { cwd: hermesCheckout });
        if (configured.status !== 0) throw new Error(configured.stderr || "Could not configure Hermes");
      }
      if (isCodex) {
        const hooks = path.join(home, ".codex", "hooks.json");
        snapshot(hooks);
        const current = fs.existsSync(hooks) ? JSON.parse(fs.readFileSync(hooks, "utf8")) : {};
        secureJson(hooks, mergeHooks(current, `${process.execPath} ${path.join(root, "scripts", "codex-whatsapp-client.mjs")} hook`));
        touchedServices.push("com.codex-whatsapp-bridge.client");
        installPlist("com.codex-whatsapp-bridge.client", plist({
          label: "com.codex-whatsapp-bridge.client",
          args: [process.execPath, path.join(root, "scripts", "codex-whatsapp-client.mjs"), "poll"],
          interval: 5,
          stdout: path.join(logs, "client.log"),
          stderr: path.join(logs, "client.error.log"),
        }), snapshot);
      }
      if (isGateway) {
        touchedServices.push("com.codex-whatsapp-bridge.updates");
        installPlist("com.codex-whatsapp-bridge.updates", plist({
          label: "com.codex-whatsapp-bridge.updates",
          args: [process.execPath, path.join(root, "scripts", "update-check.mjs")],
          interval: 7 * 24 * 60 * 60,
          stdout: path.join(logs, "updates.log"),
          stderr: path.join(logs, "updates.error.log"),
        }), snapshot);
      }
    } catch (error) {
      rollback();
      throw new Error(`Setup failed and previous files were restored: ${error.message}`);
    }
    console.log(JSON.stringify({ ok: true, backup, next: "Restart Hermes and Codex, approve the two Codex hooks, then run npm run doctor." }, null, 2));
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
