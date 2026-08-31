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
    configPath: "/Users/test/.config/bridge.json",
    nodeBinary: "/opt/node/bin/node",
  });
  assert.match(content, /<key>PATH<\/key><string>\/opt\/node\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
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
  fs.writeFileSync(path.join(hermes, "gateway", "platforms", "base.py"), "dispatch_exclusive_inbound\n");
  fs.writeFileSync(path.join(hermes, "plugins", "platforms", "whatsapp", "adapter.py"), "async def add_reaction(): pass\n");
  const chat = "123-456@g.us";
  const result = spawnSync(process.execPath, [
    path.resolve("scripts/setup.mjs"), "--non-interactive", "--role=gateway", "--host-id=gateway",
    `--chat-id=${chat}`, "--allowed-senders=15551234567@s.whatsapp.net", "--codex-host-id=codex",
    `--codex-cwd=${root}`, `--hermes-checkout=${hermes}`, `--hermes-python=${external}`,
  ], { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, HOME: home, CODEX_WHATSAPP_CONFIG: path.join(root, "config.json") } });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.gateway.hermesPython, external);
  assert.equal(plan.dedicatedChatConfigured, true);
  assert.doesNotMatch(result.stdout, new RegExp(chat.replaceAll("-", "\\-")));
});
