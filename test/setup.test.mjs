import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { launchAgentPlist } from "../scripts/lib/launch-agent.mjs";

test("launch agents expose the configured Node directory to env-based tools", () => {
  const content = launchAgentPlist({
    label: "test",
    args: ["/opt/node/bin/node", "/tmp/client.mjs"],
    interval: 5,
    stdout: "/tmp/out.log",
    stderr: "/tmp/error.log",
    workingDirectory: "/tmp/bridge",
    home: "/Users/test",
    codexHome: "/Users/test/Codex & State",
    configPath: "/Users/test/.config/bridge.json",
    nodeBinary: "/opt/node/bin/node",
  });
  assert.match(content, /<key>PATH<\/key><string>\/opt\/node\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(content, /<key>CODEX_HOME<\/key><string>\/Users\/test\/Codex &amp; State<\/string>/);
});

test("split setup canonicalizes Codex home and rolls the broker with the repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-rollover-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const activeCodexHome = path.join(root, "active-codex-home");
  const linkedCodexHome = path.join(home, ".codex");
  const configPath = path.join(root, "config.json");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(activeCodexHome);
  fs.symlinkSync(activeCodexHome, linkedCodexHome);
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    role: "codex",
    hostId: "regular-mac",
    gateway: {
      sshHost: "server-mac",
      repositoryPath: "/srv/releases/old",
      brokerPath: "/srv/releases/stale/scripts/codex-whatsapp-broker.mjs",
      node: "/opt/node/bin/node",
      attachmentPath: "/srv/attachments",
    },
    whatsapp: {},
    codex: { home: linkedCodexHome, defaultCwd: root, mirrorProgress: false },
  })}\n`);
  const baseArgs = [
    path.resolve("scripts/setup.mjs"),
    "--non-interactive",
    "--role=codex",
    "--gateway-repository=/srv/releases/new",
  ];
  const options = {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, HOME: home, CODEX_WHATSAPP_CONFIG: configPath },
  };

  const rolled = spawnSync(process.execPath, baseArgs, options);
  assert.equal(rolled.status, 0, rolled.stderr);
  const rolledPlan = JSON.parse(rolled.stdout);
  const canonicalCodexHome = fs.realpathSync(activeCodexHome);
  assert.equal(rolledPlan.codexHome, canonicalCodexHome);
  assert.equal(rolledPlan.codexHooks, path.join(canonicalCodexHome, "hooks.json"));
  assert.equal(rolledPlan.gateway.brokerPath, "/srv/releases/new/scripts/codex-whatsapp-broker.mjs");

  const pinned = spawnSync(process.execPath, [...baseArgs, "--gateway-broker=/srv/releases/pinned/broker.mjs"], options);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(JSON.parse(pinned.stdout).gateway.brokerPath, "/srv/releases/pinned/broker.mjs");
});

test("failed setup restores the prior runtime configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const hermes = path.join(root, "hermes");
  const configPath = path.join(home, ".config", "codex-whatsapp-bridge", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const original = `${JSON.stringify({ schemaVersion: 1, role: "gateway", hostId: "old-gateway" })}\n`;
  fs.writeFileSync(configPath, original, { mode: 0o600 });
  fs.mkdirSync(path.join(hermes, ".venv", "bin"), { recursive: true });
  fs.mkdirSync(path.join(hermes, "scripts", "whatsapp-bridge"), { recursive: true });
  fs.writeFileSync(path.join(hermes, "scripts", "whatsapp-bridge", "bridge.js"), "console.log('bridge');\n");
  fs.symlinkSync("/usr/bin/python3", path.join(hermes, ".venv", "bin", "python"));
  assert.equal(spawnSync("/usr/bin/git", ["init", "-q"], { cwd: hermes }).status, 0);
  fs.writeFileSync(path.join(hermes, "README"), "test\n");
  assert.equal(spawnSync("/usr/bin/git", ["add", "README"], { cwd: hermes }).status, 0);
  assert.equal(spawnSync("/usr/bin/git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test"], { cwd: hermes }).status, 0);

  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/setup.mjs"),
      "--apply",
      "--non-interactive",
      "--role=gateway",
      "--host-id=gateway",
      "--chat-id=123-456@g.us",
      "--allowed-senders=15551234567@s.whatsapp.net",
      "--codex-host-id=codex",
      `--codex-cwd=${root}`,
      `--hermes-checkout=${hermes}`,
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, HOME: home, CODEX_WHATSAPP_CONFIG: configPath },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous files were restored/);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
  assert.equal(fs.existsSync(path.join(home, ".hermes", "plugins", "codex-whatsapp-bridge")), false);
});

test("setup refuses a role transition before touching installed state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-role-change-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  const original = `${JSON.stringify({ schemaVersion: 1, role: "gateway", hostId: "gateway" })}\n`;
  fs.writeFileSync(configPath, original, { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/setup.mjs"), "--non-interactive", "--role=codex"],
    { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, CODEX_WHATSAPP_CONFIG: configPath } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a reviewed migration/);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("split setup rejects shell-unsafe remote executable paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-space-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const unsafe of ["/tmp/bridge path", "/tmp/bridge;touch${IFS}/tmp/unexpected", "/tmp/$(touch_bad)", "/tmp/`touch_bad`", "/tmp/'quoted'", "/tmp/\"quoted\"", "/tmp/line\nbreak"]) {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/setup.mjs"),
        "--non-interactive",
        "--role=codex",
        "--host-id=codex",
        `--default-cwd=${root}`,
        "--gateway-ssh=gateway",
        `--gateway-repository=${unsafe}`,
        "--gateway-node=/opt/homebrew/bin/node",
        "--gateway-attachments=/tmp/attachments",
      ],
      { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, CODEX_WHATSAPP_CONFIG: path.join(root, "config.json") } },
    );
    assert.notEqual(result.status, 0, unsafe);
    assert.match(result.stderr, /shell-safe path characters/, unsafe);
  }
});

test("gateway dry-run accepts an external Hermes Python and redacts the dedicated chat", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-external-python-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const hermes = path.join(root, "hermes");
  const external = path.join(root, "venv", "bin", "python");
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.symlinkSync("/usr/bin/python3", external);
  fs.mkdirSync(path.join(hermes, "gateway", "platforms"), { recursive: true });
  fs.mkdirSync(path.join(hermes, "plugins", "platforms", "whatsapp"), { recursive: true });
  fs.mkdirSync(path.join(hermes, "scripts", "whatsapp-bridge"), { recursive: true });
  fs.writeFileSync(path.join(hermes, "gateway", "platforms", "base.py"), "dispatch_exclusive_inbound\n");
  fs.writeFileSync(path.join(hermes, "plugins", "platforms", "whatsapp", "adapter.py"), "async def add_reaction(): pass\n");
  // A previously patched runtime has the old interaction seams but not the
  // native-poll ledger capability marker, so setup must schedule the upgrade.
  const bridgePath = path.join(hermes, "scripts", "whatsapp-bridge", "bridge.js");
  fs.writeFileSync(bridgePath, "// /send-poll pollUpdateMessage\n");
  const chat = "123-456@g.us";
  const args = [
    path.resolve("scripts/setup.mjs"), "--non-interactive", "--role=gateway", "--host-id=gateway",
    `--chat-id=${chat}`, "--allowed-senders=15551234567@s.whatsapp.net", "--codex-host-id=codex",
    `--codex-cwd=${root}`, `--hermes-checkout=${hermes}`, `--hermes-python=${external}`,
  ];
  const result = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, HOME: home, CODEX_WHATSAPP_CONFIG: path.join(root, "config.json") } });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.gateway.hermesPython, external);
  assert.equal(plan.hermesCompatibility, `patch for ${"4f22543509d1b91dc45bcb369447126c5eb14fb7"}`);
  assert.equal(plan.dedicatedChatConfigured, true);
  assert.doesNotMatch(result.stdout, new RegExp(chat.replaceAll("-", "\\-")));
  fs.writeFileSync(bridgePath, "// /send-poll pollUpdateMessage native-polls-ledger-v1\n");
  const upgraded = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, HOME: home, CODEX_WHATSAPP_CONFIG: path.join(root, "config.json") } });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(JSON.parse(upgraded.stdout).hermesCompatibility, "native");
});
