import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const defaultConfigPath = path.join(
  os.homedir(),
  ".config",
  "codex-whatsapp-bridge",
  "config.json",
);

export function configPath() {
  return process.env.CODEX_WHATSAPP_CONFIG ?? defaultConfigPath;
}

export function readConfig({ required = true } = {}) {
  const target = configPath();
  if (!fs.existsSync(target)) {
    if (!required) return null;
    throw new Error(`Codex WhatsApp Bridge configuration is missing: ${target}`);
  }
  const value = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex WhatsApp Bridge configuration is invalid");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported Codex WhatsApp Bridge configuration version");
  }
  if (!new Set(["combined", "gateway", "codex"]).has(value.role)) {
    throw new Error("Bridge role must be combined, gateway, or codex");
  }
  if (typeof value.hostId !== "string" || !value.hostId.trim()) {
    throw new Error("Bridge hostId is required");
  }
  return { ...value, _path: target };
}

export function isGatewayHost(config = readConfig()) {
  return config.role === "combined" || config.role === "gateway";
}

export function isCodexHost(config = readConfig()) {
  return config.role === "combined" || config.role === "codex";
}

export function codexBinaryPath(config = readConfig({ required: false })) {
  const configured = config?.codex?.binary;
  if (typeof configured === "string" && path.isAbsolute(configured)) return configured;
  const managed = path.join(os.homedir(), ".local", "bin", "codex");
  if (fs.existsSync(managed)) return managed;
  return "/opt/homebrew/bin/codex";
}

export function bridgePaths(config = readConfig()) {
  const root = path.dirname(config._path ?? configPath());
  const gatewayRepo = config.gateway?.repositoryPath;
  return {
    root,
    clientState: config.codex?.statePath ?? path.join(root, "client", "state.json"),
    clientAttachments:
      config.codex?.attachmentPath ?? path.join(root, "client", "attachments"),
    brokerState: config.gateway?.statePath ?? path.join(root, "broker", "state.json"),
    brokerAttachments:
      config.gateway?.attachmentPath ?? path.join(root, "broker", "attachments"),
    brokerScript:
      config.gateway?.brokerPath ??
      (gatewayRepo
        ? path.join(gatewayRepo, "scripts", "codex-whatsapp-broker.mjs")
        : null),
  };
}

