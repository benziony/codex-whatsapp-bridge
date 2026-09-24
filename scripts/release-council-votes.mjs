#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const label = "com.codex-whatsapp-bridge.client";
const plistName = `${label}.plist`;
const releasePrefix = "codex-whatsapp-bridge-";
const manifestName = ".codex-whatsapp-release.json";
const lockName = ".codex-whatsapp-vote-release.lock";

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

function checked(binary, args, options = {}) {
  const result = run(binary, args, options);
  if (result.status !== 0) throw new Error(`${path.basename(binary)} failed (${result.status}): ${String(result.stderr ?? "").trim()}`);
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseGitTree(text) {
  const files = [];
  for (const row of text.split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t(.+)$/.exec(row);
    if (!match) throw new Error(`Unsupported Git tree entry: ${row.slice(0, 120)}`);
    const [, mode, blob, relativePath] = match;
    if (mode === "120000") throw new Error(`Release source contains unsupported symlink: ${relativePath}`);
    if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      throw new Error(`Unsafe release path: ${relativePath}`);
    }
    files.push({ path: relativePath, blob, gitMode: mode, mode: mode === "100755" ? 0o555 : 0o444 });
  }
  return files;
}

function verifyRelease(directory, expected) {
  const manifestPath = path.join(directory, manifestName);
  if (!fs.existsSync(manifestPath)) throw new Error(`Release directory is missing ${manifestName}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.commit !== expected.commit || manifest.tree !== expected.tree) {
    throw new Error("Existing release manifest does not match the requested commit");
  }
  const expectedFiles = new Map(expected.files.map((item) => [item.path, item]));
  if (manifest.files?.length !== expectedFiles.size) throw new Error("Existing release manifest has a different file count");
  const actualFiles = new Set();
  const inspect = (current, relative = "") => {
    if ((fileSystemStat(current).mode & 0o777) !== 0o555) throw new Error(`Release directory mode mismatch: ${relative || "."}`);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const itemPath = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) inspect(target, itemPath);
      else if (entry.isFile()) actualFiles.add(itemPath);
      else throw new Error(`Release contains an unsupported filesystem entry: ${itemPath}`);
    }
  };
  const fileSystemStat = (target) => fs.statSync(target);
  inspect(directory);
  for (const actual of actualFiles) if (actual !== manifestName && !expectedFiles.has(actual)) throw new Error(`Release contains an untracked file: ${actual}`);
  for (const tracked of expectedFiles.keys()) if (!actualFiles.has(tracked)) throw new Error(`Release is missing tracked file: ${tracked}`);
  const manifestMode = fileSystemStat(manifestPath).mode & 0o777;
  if (manifestMode & 0o222) throw new Error("Release manifest is writable");
  for (const item of manifest.files) {
    const tracked = expectedFiles.get(item.path);
    if (!tracked || item.gitBlob !== tracked.blob || item.gitMode !== tracked.gitMode || item.sha256 !== tracked.sha256) {
      throw new Error(`Existing release manifest has an unexpected file: ${item.path}`);
    }
    const filePath = path.join(directory, item.path);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Release file is missing: ${item.path}`);
    if ((fileSystemStat(filePath).mode & 0o777) !== tracked.mode) throw new Error(`Release file mode mismatch: ${item.path}`);
    const bytes = fs.readFileSync(filePath);
    if (sha256(bytes) !== tracked.sha256) throw new Error(`Release file checksum mismatch: ${item.path}`);
    const hash = checked("git", ["hash-object", "--stdin"], { cwd: expected.source, encoding: "utf8", input: bytes }).stdout.trim();
    if (hash !== tracked.blob) throw new Error(`Release Git blob mismatch: ${item.path}`);
  }
  for (const file of expected.files) if (!manifest.files.some((item) => item.path === file.path)) throw new Error(`Existing release manifest omitted: ${file.path}`);
  return manifest;
}

export function prepareImmutableRelease({ source, commit, releaseRoot, fileSystem = fs }) {
  if (!path.isAbsolute(source) || !path.isAbsolute(releaseRoot)) throw new Error("Source and release root must be absolute paths");
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("Expected commit must be a full Git object ID");
  const resolved = checked("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: source, encoding: "utf8" }).stdout.trim();
  if (resolved !== commit) throw new Error("Git resolved a different source commit");
  const status = checked("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: source, encoding: "utf8" }).stdout;
  if (status.trim()) throw new Error("Source checkout must be clean before preparing a release");
  const tree = checked("git", ["rev-parse", `${commit}^{tree}`], { cwd: source, encoding: "utf8" }).stdout.trim();
  const files = parseGitTree(checked("git", ["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: source, encoding: "utf8" }).stdout);
  for (const required of ["scripts/codex-whatsapp-client.mjs", "scripts/codex-whatsapp-broker.mjs", "scripts/lib/council-approvals.mjs"]) {
    if (!files.some((item) => item.path === required)) throw new Error(`Commit is missing the required Council vote runtime file: ${required}`);
  }
  const release = path.join(releaseRoot, `${releasePrefix}${commit}`);
  const expected = { source, commit, tree, files: [] };
  if (fileSystem.existsSync(release)) {
    if (!fileSystem.lstatSync(release).isDirectory()) throw new Error("Commit-addressed release path is not a directory");
    const archive = checked("git", ["archive", "--format=tar", commit], { cwd: source, encoding: "buffer" }).stdout;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-whatsapp-release-"));
    try {
      checked("/usr/bin/tar", ["-xf", "-", "-C", temporary], { input: archive, encoding: "utf8" });
      expected.files = files.map((item) => ({ ...item, sha256: sha256(fileSystem.readFileSync(path.join(temporary, item.path))) }));
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    return { release, manifest: verifyRelease(release, expected), created: false };
  }
  fileSystem.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  const temporary = fileSystem.mkdtempSync(path.join(releaseRoot, `.staging-${commit.slice(0, 12)}-`));
  let published = false;
  try {
    const archive = checked("git", ["archive", "--format=tar", commit], { cwd: source, encoding: "buffer" }).stdout;
    checked("/usr/bin/tar", ["-xf", "-", "-C", temporary], { input: archive, encoding: "utf8" });
    const entries = [];
    for (const file of files) {
      const target = path.join(temporary, file.path);
      const bytes = fileSystem.readFileSync(target);
      const actualBlob = checked("git", ["hash-object", "--stdin"], { cwd: source, encoding: "utf8", input: bytes }).stdout.trim();
      if (actualBlob !== file.blob) throw new Error(`Source archive does not match Git tree: ${file.path}`);
      fileSystem.chmodSync(target, file.mode);
      entries.push({ path: file.path, gitBlob: file.blob, gitMode: file.gitMode, sha256: sha256(bytes) });
    }
    const manifest = { schemaVersion: 1, commit, tree, files: entries };
    fileSystem.writeFileSync(path.join(temporary, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
    fileSystem.chmodSync(path.join(temporary, manifestName), 0o444);
    const directories = new Set([temporary]);
    for (const file of files) {
      let parent = path.dirname(path.join(temporary, file.path));
      while (parent.startsWith(temporary)) {
        directories.add(parent);
        if (parent === temporary) break;
        parent = path.dirname(parent);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      if (directory !== temporary) fileSystem.chmodSync(directory, 0o555);
    }
    // macOS requires the staging directory to remain writable for rename.
    fileSystem.renameSync(temporary, release);
    published = true;
    fileSystem.chmodSync(release, 0o555);
    return { release, manifest, created: true };
  } catch (error) {
    const cleanup = published ? release : temporary;
    try {
      const restoreWritable = (directory) => {
        for (const entry of fileSystem.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) restoreWritable(target);
        }
        fileSystem.chmodSync(directory, 0o700);
      };
      restoreWritable(cleanup);
    } catch { /* preserve original failure */ }
    try { fileSystem.rmSync(cleanup, { recursive: true, force: true }); } catch { /* preserve original failure */ }
    throw error;
  }
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function plistValue(value) {
  if (typeof value === "string") return `<string>${xml(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (Number.isSafeInteger(value)) return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join("")}</array>`;
  if (value && typeof value === "object") return `<dict>${Object.entries(value).map(([key, item]) => `<key>${xml(key)}</key>${plistValue(item)}`).join("")}</dict>`;
  throw new Error("Unsupported launch agent plist value");
}

export function makeClientLaunchAgentPlist(current, release, nodeBinary) {
  if (!current || current.Label !== label || !Array.isArray(current.ProgramArguments) || current.ProgramArguments.length < 2) {
    throw new Error("Existing client LaunchAgent plist is invalid");
  }
  if (path.basename(current.ProgramArguments[1]) !== "codex-whatsapp-client.mjs") throw new Error("Existing client LaunchAgent does not run the expected client entrypoint");
  if (!path.isAbsolute(release) || !path.isAbsolute(nodeBinary)) throw new Error("Client release and Node paths must be absolute");
  const environment = current.EnvironmentVariables;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("Existing client LaunchAgent environment is missing");
  if (current.KeepAlive !== true && !Number.isSafeInteger(current.StartInterval)) throw new Error("Existing client LaunchAgent schedule is invalid");
  const next = structuredClone(current);
  next.ProgramArguments = [nodeBinary, path.join(release, "scripts", "codex-whatsapp-client.mjs"), "poll"];
  next.WorkingDirectory = release;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(next)}</plist>\n`;
}

function parseObject(text, name) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error(`${name} is not a JSON object`); }
}

function readPlist(target, execute = checked) {
  return parseObject(execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", target], { encoding: "utf8" }).stdout, "Client LaunchAgent plist");
}

function healthPayload(result, hostId) {
  if (result.status !== 0) throw new Error("WhatsApp client status command failed");
  const payload = parseObject(result.stdout, "WhatsApp client status");
  // `ok` also includes Codex hookTrust; the existing Mac can report false
  // there while its broker is healthy, so gate on the broker proof only.
  if (payload.hostId !== hostId || payload.broker?.ok !== true || payload.broker?.status !== "ok" || payload.broker?.transportRoute !== "local") {
    throw new Error("WhatsApp broker health payload did not match the expected local host");
  }
  return payload;
}

function writeAtomic(target, bytes, mode, fileSystem = fs) {
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, bytes, { mode, flag: "wx" });
    fileSystem.chmodSync(temporary, mode);
    const descriptor = fileSystem.openSync(temporary, "r+");
    try { fileSystem.fsyncSync(descriptor); } finally { fileSystem.closeSync(descriptor); }
    fileSystem.renameSync(temporary, target);
    const parentDescriptor = fileSystem.openSync(path.dirname(target), "r");
    try { fileSystem.fsyncSync(parentDescriptor); } finally { fileSystem.closeSync(parentDescriptor); }
  } catch (error) {
    try { fileSystem.rmSync(temporary, { force: true }); } catch { /* preserve original failure */ }
    throw error;
  }
}

function acquireActivationLock(releaseRoot, fileSystem = fs) {
  fileSystem.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(releaseRoot, lockName);
  let descriptor;
  const transactionId = randomUUID();
  try {
    descriptor = fileSystem.openSync(lockPath, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, transactionId, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    fileSystem.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    if (error.code === "EEXIST") throw new Error(`Another vote release activation holds ${lockPath}; inspect its PID before removing a stale lock`);
    throw error;
  }
  fileSystem.closeSync(descriptor);
  return {
    lockPath,
    transactionId,
    release: () => {
      if (!fileSystem.existsSync(lockPath)) return;
      const current = parseObject(fileSystem.readFileSync(lockPath, "utf8"), "Vote release lock");
      if (current.transactionId !== transactionId) throw new Error("Vote release lock identity changed; refusing to remove it");
      fileSystem.rmSync(lockPath);
    },
  };
}

function brokerHealth({ nodeBinary, brokerPath, hostId, environment, runner }) {
  const result = runner(nodeBinary, [brokerPath, "status"], {
    env: environment,
    input: JSON.stringify({ originHost: hostId }),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error("Council vote broker health command failed");
  const payload = parseObject(result.stdout, "Council vote broker health");
  if (payload.ok !== true || payload.status !== "ok") throw new Error("Council vote broker health payload is invalid");
  return payload;
}

export async function activateCouncilVoteRelease({ release, releaseRoot, launchAgentPath, uid, source, expectedManifest, expectedActive, runner = run, fileSystem = fs, home = os.homedir() }) {
  if (path.basename(launchAgentPath) !== plistName) throw new Error("Only the WhatsApp client LaunchAgent can be updated");
  if (![release, releaseRoot, launchAgentPath, expectedActive].every((target) => path.isAbsolute(target))) throw new Error("Release and activation paths must be absolute");
  if (!source || !expectedManifest?.commit || !Array.isArray(expectedManifest.files)) throw new Error("Activation requires the prepared Git manifest");
  verifyRelease(release, {
    source,
    commit: expectedManifest.commit,
    tree: expectedManifest.tree,
    files: expectedManifest.files.map((file) => ({ path: file.path, blob: file.gitBlob, gitMode: file.gitMode, mode: file.gitMode === "100755" ? 0o555 : 0o444, sha256: file.sha256 })),
  });
  const lock = acquireActivationLock(releaseRoot, fileSystem);
  let leaveLockForRecovery = false;
  try {
    return await activateUnderLock({ release, launchAgentPath, uid, expectedActive, expectedManifest, runner, fileSystem, home });
  } catch (error) {
    leaveLockForRecovery = error.requiresRecovery === true;
    throw error;
  } finally {
    if (!leaveLockForRecovery) lock.release();
  }
}

async function activateUnderLock({ release, launchAgentPath, uid, expectedActive, expectedManifest, runner, fileSystem, home }) {
  const originalPlist = fileSystem.readFileSync(launchAgentPath);
  const originalPlistMode = fileSystem.statSync(launchAgentPath).mode & 0o777;
  const current = readPlist(launchAgentPath);
  if (current.ProgramArguments?.[1] !== expectedActive) throw new Error("Active client source does not match the explicitly expected path");
  if (path.dirname(path.dirname(expectedActive)) !== current.WorkingDirectory) throw new Error("Client LaunchAgent working directory does not match the expected active release");
  const activeRoot = current.WorkingDirectory;
  const environment = { ...process.env, ...current.EnvironmentVariables, HOME: current.EnvironmentVariables?.HOME ?? home };
  const configPath = current.EnvironmentVariables?.CODEX_WHATSAPP_CONFIG ?? path.join(home, ".config", "codex-whatsapp-bridge", "config.json");
  if (!path.isAbsolute(configPath)) throw new Error("Configured Council runtime path must be absolute");
  environment.CODEX_WHATSAPP_CONFIG = configPath;
  const originalConfig = fileSystem.readFileSync(configPath);
  const originalConfigMode = fileSystem.statSync(configPath).mode & 0o777;
  const config = parseObject(originalConfig.toString("utf8"), "Bridge config");
  if (config.role !== "combined" || config.hostId !== "server-mac") throw new Error("Vote release activation requires the combined Server Mac runtime");
  if (config.gateway?.repositoryPath !== activeRoot || path.resolve(config.gateway?.brokerPath ?? "") !== path.join(activeRoot, "scripts", "codex-whatsapp-broker.mjs")) {
    throw new Error("Gateway broker paths do not match the exact active client release");
  }
  const nodeBinary = current.ProgramArguments[0];
  if (!path.isAbsolute(nodeBinary) || !fileSystem.existsSync(nodeBinary)) throw new Error("Existing client Node runtime is unavailable");
  const previousHealth = healthPayload(runner(nodeBinary, [expectedActive, "status"], { env: environment, encoding: "utf8", timeout: 30_000 }), config.hostId);
  const clientEntry = path.join(release, "scripts", "codex-whatsapp-client.mjs");
  const brokerPath = path.join(release, "scripts", "codex-whatsapp-broker.mjs");
  const nextConfig = structuredClone(config);
  nextConfig.gateway.repositoryPath = release;
  nextConfig.gateway.brokerPath = brokerPath;
  const serializedConfig = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const updatedPlist = makeClientLaunchAgentPlist(current, release, nodeBinary);
  const domain = `gui/${uid}`;
  const service = `${domain}/${label}`;
  const now = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const plistBackup = `${launchAgentPath}.backup-${now}`;
  const configBackup = `${configPath}.backup-${now}`;
  fileSystem.writeFileSync(plistBackup, originalPlist, { mode: 0o600, flag: "wx" });
  fileSystem.writeFileSync(configBackup, originalConfig, { mode: 0o600, flag: "wx" });
  const invoke = (args) => {
    const result = runner("/bin/launchctl", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`launchctl ${args[0]} failed`);
    return result;
  };
  invoke(["print", service]);
  try { invoke(["bootout", service]); }
  catch (error) { throw new Error(`Could not stop the existing client LaunchAgent; configuration was not changed: ${error.message}`); }
  try {
    writeAtomic(configPath, Buffer.from(serializedConfig), originalConfigMode, fileSystem);
    writeAtomic(launchAgentPath, Buffer.from(updatedPlist), originalPlistMode, fileSystem);
    invoke(["bootstrap", domain, launchAgentPath]);
    const candidate = healthPayload(runner(nodeBinary, [clientEntry, "status"], { env: environment, encoding: "utf8", timeout: 30_000 }), config.hostId);
    if (candidate.hookTrust?.ready !== previousHealth.hookTrust?.ready) throw new Error("Codex hook trust changed during client release");
    const activeConfig = parseObject(fileSystem.readFileSync(configPath, "utf8"), "Updated Bridge config");
    if (activeConfig.gateway?.repositoryPath !== release || activeConfig.gateway?.brokerPath !== brokerPath) throw new Error("Gateway broker config readback did not match release paths");
    brokerHealth({ nodeBinary, brokerPath, hostId: config.hostId, environment, runner });
    invoke(["print", service]);
    return { status: "active", release, commit: expectedManifest.commit, plistBackup, configBackup, gatewayPathsUpdated: true };
  } catch (error) {
    try { runner("/bin/launchctl", ["bootout", service], { encoding: "utf8" }); } catch { /* restore still attempted */ }
    try {
      writeAtomic(configPath, originalConfig, originalConfigMode, fileSystem);
      writeAtomic(launchAgentPath, originalPlist, originalPlistMode, fileSystem);
      invoke(["bootstrap", domain, launchAgentPath]);
      const restored = readPlist(launchAgentPath);
      healthPayload(runner(restored.ProgramArguments[0], [restored.ProgramArguments[1], "status"], { env: environment, encoding: "utf8", timeout: 30_000 }), config.hostId);
      invoke(["print", service]);
    } catch (rollbackError) {
      const recoveryError = new Error(`Vote release failed and rollback needs attention; config backup ${configBackup}, client plist backup ${plistBackup}; ${rollbackError.message}`, { cause: error });
      recoveryError.requiresRecovery = true;
      throw recoveryError;
    }
    throw new Error(`Vote release failed; previous config and client LaunchAgent restored from ${configBackup} and ${plistBackup}: ${error.message}`, { cause: error });
  }
}

function optionsFromArgs(args) {
  const result = {};
  for (const argument of args) {
    const match = /^--(source|commit|release-root|expected-active)=([^=].*)$/.exec(argument);
    if (!match) throw new Error(`Unexpected argument: ${argument}`);
    result[match[1]] = match[2];
  }
  if (!result.source || !result.commit) throw new Error("Usage: release-council-votes.mjs --source=/clean/git/checkout --commit=<full-object-id> [--release-root=/path] [--expected-active=/exact/current/client.mjs] [--apply]");
  return result;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const args = optionsFromArgs(process.argv.slice(2).filter((arg) => arg !== "--apply"));
  const releaseRoot = args["release-root"] ?? path.join(os.homedir(), ".hermes", "layered-releases");
  const prepared = prepareImmutableRelease({ source: path.resolve(args.source), commit: args.commit, releaseRoot: path.resolve(releaseRoot) });
  if (!apply) {
    console.log(JSON.stringify({ status: prepared.created ? "prepared" : "verified", commit: args.commit, release: prepared.release, manifestFiles: prepared.manifest.files.length, components: ["combined-client", "gateway-broker"], liveChanged: false }));
    return;
  }
  if (!args["expected-active"]) throw new Error("--apply requires --expected-active with the exact current client script path");
  const launchAgentPath = path.join(os.homedir(), "Library", "LaunchAgents", plistName);
  const activation = await activateCouncilVoteRelease({ release: prepared.release, releaseRoot: path.resolve(releaseRoot), launchAgentPath, uid: process.getuid(), source: path.resolve(args.source), expectedManifest: prepared.manifest, expectedActive: args["expected-active"] });
  console.log(JSON.stringify({ ...activation, manifestFiles: prepared.manifest.files.length, relayLaunchAgentChanged: false, updatesLaunchAgentChanged: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Client release failed: ${error.message}`);
    process.exitCode = 1;
  });
}
