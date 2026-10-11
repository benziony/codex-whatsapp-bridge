import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const plutil = "/usr/bin/plutil";

export function validateLaunchAgentPlist(target, expectedLabel) {
  const checked = spawnSync(plutil, ["-convert", "json", "-o", "-", target], { encoding: "utf8", timeout: 10_000 });
  if (checked.error || checked.status !== 0) {
    const detail = checked.error?.message || checked.stderr?.trim() || `plutil exited ${checked.status}`;
    throw new Error(`Invalid LaunchAgent plist: ${detail}`);
  }
  let value;
  try {
    value = JSON.parse(checked.stdout);
  } catch {
    throw new Error("Invalid LaunchAgent plist: parsed output is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid LaunchAgent plist: top-level value must be a dictionary");
  }
  if (value.Label !== expectedLabel) {
    throw new Error(`Invalid LaunchAgent plist: Label must be ${expectedLabel}`);
  }
  if (!Array.isArray(value.ProgramArguments) || value.ProgramArguments.length === 0
      || value.ProgramArguments.some((argument) => typeof argument !== "string" || !argument.trim())) {
    throw new Error("Invalid LaunchAgent plist: ProgramArguments must be a nonempty array of strings");
  }
  const executable = value.ProgramArguments[0];
  if (!path.isAbsolute(executable)) {
    throw new Error("Invalid LaunchAgent plist: ProgramArguments[0] must be an absolute executable path");
  }
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw new Error("Invalid LaunchAgent plist: ProgramArguments[0] must name an executable file");
  }
  if (typeof value.WorkingDirectory !== "string" || !path.isAbsolute(value.WorkingDirectory)
      || typeof value.StandardOutPath !== "string" || !path.isAbsolute(value.StandardOutPath)
      || typeof value.StandardErrorPath !== "string" || !path.isAbsolute(value.StandardErrorPath)) {
    throw new Error("Invalid LaunchAgent plist: working and log paths must be absolute");
  }
  const environment = value.EnvironmentVariables;
  if (value.RunAtLoad !== true || !environment || typeof environment !== "object" || Array.isArray(environment)
      || ["HOME", "PATH", "CODEX_WHATSAPP_CONFIG"].some((key) => typeof environment[key] !== "string" || !environment[key])) {
    throw new Error("Invalid LaunchAgent plist: required RunAtLoad and EnvironmentVariables are missing");
  }
  const hasInterval = Number.isInteger(value.StartInterval) && value.StartInterval > 0;
  const hasKeepAlive = value.KeepAlive === true;
  if (hasInterval === hasKeepAlive) {
    throw new Error("Invalid LaunchAgent plist: exactly one of positive StartInterval or KeepAlive is required");
  }
  return true;
}

export function installLaunchAgent({ label, content, target, domain, snapshot, touchedServices, command }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    validateLaunchAgentPlist(temporary, label);
    snapshot(target);
    fs.renameSync(temporary, target);
    touchedServices.push(label);
    command("/bin/launchctl", ["bootout", `${domain}/${label}`]);
    const loaded = command("/bin/launchctl", ["bootstrap", domain, target]);
    if (loaded.status !== 0) throw new Error(loaded.stderr || `Could not load ${label}`);
    return target;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

export function launchAgentPlist({ label, args, interval, keepAlive = false, stdout, stderr, workingDirectory, home, codexHome = "", configPath, nodeBinary }) {
  const launchPath = `${path.dirname(nodeBinary)}:${systemPath}`;
  const codexHomeEnvironment = codexHome ? `<key>CODEX_HOME</key><string>${escapeXml(codexHome)}</string>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escapeXml(home)}</string>${codexHomeEnvironment}<key>PATH</key><string>${escapeXml(launchPath)}</string><key>CODEX_WHATSAPP_CONFIG</key><string>${escapeXml(configPath)}</string></dict>
<key>RunAtLoad</key><true/>${keepAlive ? "<key>KeepAlive</key><true/>" : `<key>StartInterval</key><integer>${interval}</integer>`}
<key>StandardOutPath</key><string>${escapeXml(stdout)}</string>
<key>StandardErrorPath</key><string>${escapeXml(stderr)}</string>
</dict></plist>\n`;
}
