import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  activateCouncilVoteRelease,
  makeClientLaunchAgentPlist,
  prepareImmutableRelease,
} from "../scripts/release-council-votes.mjs";

const label = "com.codex-whatsapp-bridge.client";
const lockName = ".codex-whatsapp-vote-release.lock";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "council-vote-release-test-"));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(source, "README.md"), "release fixture\n");
  fs.writeFileSync(path.join(source, "scripts", "codex-whatsapp-client.mjs"), "console.log('client fixture');\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "scripts", "codex-whatsapp-broker.mjs"), "console.log('broker fixture');\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "scripts", "lib", "council-approvals.mjs"), "export const voteFix = true;\n");
  git(source, "init", "-q");
  git(source, "add", ".");
  const commit = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: source });
  assert.equal(commit.status, 0, commit.stderr);
  return { root, source, commit: git(source, "rev-parse", "HEAD") };
}

function removeTree(root) {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) removeTree(target);
    else if (entry.isFile()) fs.chmodSync(target, 0o600);
  }
  fs.chmodSync(root, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
}

function oldPlist(home, configPath, activeRoot) {
  return {
    Label: label,
    ProgramArguments: [process.execPath, path.join(activeRoot, "scripts", "codex-whatsapp-client.mjs"), "poll"],
    WorkingDirectory: activeRoot,
    EnvironmentVariables: {
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_WHATSAPP_CONFIG: configPath,
      CODEX_WHATSAPP_CLIENT_STATE: path.join(home, ".config", "codex-whatsapp-bridge", "client-state.json"),
      PATH: "/opt/node/bin:/usr/bin:/bin",
    },
    RunAtLoad: true,
    StartInterval: 5,
    StandardOutPath: path.join(home, "logs", "client.log"),
    StandardErrorPath: path.join(home, "logs", "client.error.log"),
  };
}

function plistValue(value) {
  if (typeof value === "string") return `<string>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (Number.isSafeInteger(value)) return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join("")}</array>`;
  return `<dict>${Object.entries(value).map(([key, child]) => `<key>${key}</key>${plistValue(child)}`).join("")}</dict>`;
}

function plistJson(xml) {
  const target = path.join(os.tmpdir(), `vote-release-${process.pid}-${Math.random()}.plist`);
  fs.writeFileSync(target, xml);
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", target], { encoding: "utf8" });
  fs.rmSync(target, { force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function health({ status = 0, hookTrust = false, brokerOk = true } = {}) {
  return {
    status,
    stdout: JSON.stringify({
      ok: hookTrust && brokerOk,
      hostId: "server-mac",
      broker: { ok: brokerOk, status: brokerOk ? "ok" : "unavailable", transportRoute: "local" },
      hookTrust: { ready: hookTrust },
    }),
    stderr: "",
  };
}

function setupHost(fixtureState) {
  const home = path.join(fixtureState.root, "host");
  const activeRoot = path.join(home, ".hermes", "layered-releases", "codex-whatsapp-bridge-old");
  const launchAgentPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const configPath = path.join(home, ".config", "codex-whatsapp-bridge", "config.json");
  fs.mkdirSync(path.dirname(launchAgentPath), { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.join(activeRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(activeRoot, "scripts", "codex-whatsapp-client.mjs"), "old client\n");
  const config = {
    schemaVersion: 1,
    role: "combined",
    hostId: "server-mac",
    gateway: { repositoryPath: activeRoot, brokerPath: path.join(activeRoot, "scripts", "codex-whatsapp-broker.mjs"), statePath: path.join(home, "private-state", "broker.json") },
    codex: { statePath: path.join(home, "private-state", "client.json") },
    whatsapp: { bridgeUrl: "http://127.0.0.1:4242", keepSecret: "fixture-secret-marker" },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  const plist = oldPlist(home, configPath, activeRoot);
  const plistXml = `<?xml version="1.0"?><plist version="1.0">${plistValue(plist)}</plist>`;
  fs.writeFileSync(launchAgentPath, plistXml, { mode: 0o600 });
  fs.chmodSync(launchAgentPath, 0o600);
  return { home, activeRoot, launchAgentPath, configPath, config, plist, plistXml };
}

function releaseHostRunner(release, { failCandidate = false, failRollback = false } = {}) {
  const calls = [];
  let bootstraps = 0;
  const runner = (binary, args, options = {}) => {
    calls.push({ binary, args, options });
    if (binary === "/bin/launchctl") {
      if (args[0] === "bootstrap") bootstraps += 1;
      if (failRollback && args[0] === "bootstrap" && bootstraps === 2) return { status: 1, stdout: "", stderr: "synthetic rollback failure" };
      return { status: 0, stdout: "loaded", stderr: "" };
    }
    if (binary === process.execPath && args[0] === path.join(release, "scripts", "codex-whatsapp-client.mjs")) {
      return failCandidate ? health({ brokerOk: false }) : health({});
    }
    if (binary === process.execPath && args[0] === path.join(release, "scripts", "codex-whatsapp-broker.mjs")) {
      return { status: 0, stdout: JSON.stringify({ ok: true, status: "ok" }), stderr: "" };
    }
    if (binary === process.execPath && args[0].endsWith("codex-whatsapp-client.mjs")) return health({});
    return { status: 1, stdout: "", stderr: "unexpected command" };
  };
  return { runner, calls };
}

async function prepared(fixtureState) {
  const value = prepareImmutableRelease({ source: fixtureState.source, commit: fixtureState.commit, releaseRoot: path.join(fixtureState.root, "releases") });
  return value;
}

test("prepares the exact commit as an immutable client and broker release", () => {
  const state = fixture();
  const releaseRoot = path.join(state.root, "releases");
  const result = prepareImmutableRelease({ source: state.source, commit: state.commit, releaseRoot });
  assert.equal(result.created, true);
  assert.equal(path.basename(result.release), `codex-whatsapp-bridge-${state.commit}`);
  assert.equal(result.manifest.commit, state.commit);
  assert.equal(result.manifest.files.length, 4);
  assert.ok(result.manifest.files.some((file) => file.path === "scripts/lib/council-approvals.mjs"));
  assert.equal(fs.statSync(result.release).mode & 0o222, 0);
  assert.equal(fs.statSync(path.join(result.release, "scripts", "codex-whatsapp-broker.mjs")).mode & 0o222, 0);
  const verified = prepareImmutableRelease({ source: state.source, commit: state.commit, releaseRoot });
  assert.equal(verified.created, false);
  const tampered = path.join(result.release, "README.md");
  fs.chmodSync(tampered, 0o644);
  fs.writeFileSync(tampered, "tampered\n");
  fs.chmodSync(tampered, 0o444);
  assert.throws(() => prepareImmutableRelease({ source: state.source, commit: state.commit, releaseRoot }), /checksum mismatch/);
  removeTree(state.root);
});

test("requires an explicit full commit and clean source", () => {
  const state = fixture();
  const releaseRoot = path.join(state.root, "releases");
  assert.throws(() => prepareImmutableRelease({ source: state.source, commit: state.commit.slice(0, 12), releaseRoot }), /full Git object ID/);
  fs.writeFileSync(path.join(state.source, "extra.txt"), "dirty\n");
  assert.throws(() => prepareImmutableRelease({ source: state.source, commit: state.commit, releaseRoot }), /must be clean/);
  removeTree(state.root);
});

test("client plist update preserves its environment, schedule, and state locations", () => {
  const state = fixture();
  const host = setupHost(state);
  const changed = plistJson(makeClientLaunchAgentPlist(host.plist, "/new/release", "/opt/node/bin/node"));
  assert.deepEqual(changed.ProgramArguments, ["/opt/node/bin/node", "/new/release/scripts/codex-whatsapp-client.mjs", "poll"]);
  assert.equal(changed.WorkingDirectory, "/new/release");
  assert.deepEqual(changed.EnvironmentVariables, host.plist.EnvironmentVariables);
  for (const key of ["Label", "RunAtLoad", "StartInterval", "StandardOutPath", "StandardErrorPath"]) assert.deepEqual(changed[key], host.plist[key]);
  assert.throws(() => makeClientLaunchAgentPlist({ ...host.plist, ProgramArguments: ["node", "/old/gateway.js"] }, "/new/release", "/opt/node/bin/node"), /expected client entrypoint/);
  removeTree(state.root);
});

test("atomically updates both gateway paths and client LaunchAgent after broker health passes", async () => {
  const state = fixture();
  const release = await prepared(state);
  const host = setupHost(state);
  const { runner, calls } = releaseHostRunner(release.release);
  const result = await activateCouncilVoteRelease({
    release: release.release,
    releaseRoot: path.join(state.root, "releases"),
    launchAgentPath: host.launchAgentPath,
    uid: 501,
    source: state.source,
    expectedManifest: release.manifest,
    expectedActive: path.join(host.activeRoot, "scripts", "codex-whatsapp-client.mjs"),
    runner,
    home: host.home,
  });
  assert.equal(result.status, "active");
  const activeConfig = JSON.parse(fs.readFileSync(host.configPath, "utf8"));
  assert.equal(activeConfig.gateway.repositoryPath, release.release);
  assert.equal(activeConfig.gateway.brokerPath, path.join(release.release, "scripts", "codex-whatsapp-broker.mjs"));
  assert.equal(activeConfig.gateway.statePath, host.config.gateway.statePath);
  assert.equal(activeConfig.codex.statePath, host.config.codex.statePath);
  assert.equal(activeConfig.whatsapp.keepSecret, "fixture-secret-marker");
  const activePlist = plistJson(fs.readFileSync(host.launchAgentPath, "utf8"));
  assert.equal(activePlist.ProgramArguments[1], path.join(release.release, "scripts", "codex-whatsapp-client.mjs"));
  assert.equal(activePlist.WorkingDirectory, release.release);
  assert.deepEqual(activePlist.EnvironmentVariables, host.plist.EnvironmentVariables);
  assert.ok(calls.some((call) => call.args[0] === "print"));
  assert.ok(calls.some((call) => call.binary === process.execPath && call.args[0] === path.join(release.release, "scripts", "codex-whatsapp-broker.mjs")));
  assert.equal(fs.existsSync(result.configBackup), true);
  assert.equal(fs.existsSync(result.plistBackup), true);
  assert.equal(fs.existsSync(path.join(state.root, "releases", lockName)), false);
  removeTree(state.root);
});

test("false top-level hookTrust does not mask healthy broker; failed broker health restores config and plist", async () => {
  const state = fixture();
  const release = await prepared(state);
  const host = setupHost(state);
  const beforeConfig = fs.readFileSync(host.configPath);
  const beforePlist = fs.readFileSync(host.launchAgentPath);
  const { runner, calls } = releaseHostRunner(release.release, { failCandidate: true });
  await assert.rejects(activateCouncilVoteRelease({
    release: release.release,
    releaseRoot: path.join(state.root, "releases"),
    launchAgentPath: host.launchAgentPath,
    uid: 501,
    source: state.source,
    expectedManifest: release.manifest,
    expectedActive: path.join(host.activeRoot, "scripts", "codex-whatsapp-client.mjs"),
    runner,
    home: host.home,
  }), /previous config and client LaunchAgent restored/);
  assert.deepEqual(fs.readFileSync(host.configPath), beforeConfig);
  assert.deepEqual(fs.readFileSync(host.launchAgentPath), beforePlist);
  assert.equal(calls.filter((call) => call.binary === "/bin/launchctl" && call.args[0] === "bootstrap").length, 2);
  removeTree(state.root);
});

test("activation lock and expected active path both fail before any live pointer changes", async () => {
  const state = fixture();
  const release = await prepared(state);
  const host = setupHost(state);
  const releaseRoot = path.join(state.root, "releases");
  const lockPath = path.join(releaseRoot, lockName);
  const { runner, calls } = releaseHostRunner(release.release);
  const args = {
    release: release.release,
    releaseRoot,
    launchAgentPath: host.launchAgentPath,
    uid: 501,
    source: state.source,
    expectedManifest: release.manifest,
    expectedActive: path.join(host.activeRoot, "scripts", "codex-whatsapp-client.mjs"),
    runner,
    home: host.home,
  };
  const beforeConfig = fs.readFileSync(host.configPath);
  const beforePlist = fs.readFileSync(host.launchAgentPath);
  await assert.rejects(activateCouncilVoteRelease({ ...args, expectedActive: "/wrong/entrypoint.mjs" }), /does not match/);
  fs.writeFileSync(lockPath, "{\"pid\":1}\n", { mode: 0o600 });
  await assert.rejects(activateCouncilVoteRelease(args), /holds .*inspect its PID/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readFileSync(host.configPath), beforeConfig);
  assert.deepEqual(fs.readFileSync(host.launchAgentPath), beforePlist);
  fs.rmSync(lockPath, { force: true });
  removeTree(state.root);
});

test("leaves the activation lock in place when rollback itself needs attention", async () => {
  const state = fixture();
  const release = await prepared(state);
  const host = setupHost(state);
  const releaseRoot = path.join(state.root, "releases");
  const lockPath = path.join(releaseRoot, lockName);
  const { runner } = releaseHostRunner(release.release, { failCandidate: true, failRollback: true });
  await assert.rejects(activateCouncilVoteRelease({
    release: release.release,
    releaseRoot,
    launchAgentPath: host.launchAgentPath,
    uid: 501,
    source: state.source,
    expectedManifest: release.manifest,
    expectedActive: path.join(host.activeRoot, "scripts", "codex-whatsapp-client.mjs"),
    runner,
    home: host.home,
  }), /rollback needs attention/);
  assert.equal(fs.existsSync(lockPath), true);
  removeTree(state.root);
});
