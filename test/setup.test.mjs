import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
