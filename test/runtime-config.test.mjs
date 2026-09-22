import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bridgePaths, codexHomePath } from "../scripts/lib/runtime-config.mjs";

test("Codex home resolution prefers config, then environment, then the legacy default", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codex-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configured = path.join(root, "configured");
  const environment = path.join(root, "environment");
  const home = path.join(root, "home");
  fs.mkdirSync(configured);
  fs.mkdirSync(environment);

  assert.equal(codexHomePath({ codex: { home: configured } }, { env: { CODEX_HOME: environment }, home }), fs.realpathSync(configured));
  assert.equal(codexHomePath({}, { env: { CODEX_HOME: environment }, home }), fs.realpathSync(environment));
  assert.equal(codexHomePath({}, { env: {}, home }), path.join(home, ".codex"));
  assert.throws(() => codexHomePath({ codex: { home: "relative" } }, { env: {}, home }), /absolute path/);
});

test("Codex home and runtime state paths resolve through an existing symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codex-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const linked = path.join(root, ".codex");
  fs.mkdirSync(active);
  fs.symlinkSync(active, linked);
  const config = {
    _path: path.join(root, "bridge", "config.json"),
    codex: { home: linked },
    gateway: { repositoryPath: "/srv/bridge" },
  };

  const paths = bridgePaths(config, { env: {}, home: root });
  const canonical = fs.realpathSync(active);
  assert.equal(paths.codexHome, canonical);
  assert.equal(paths.codexHooks, path.join(canonical, "hooks.json"));
  assert.equal(paths.codexSessions, path.join(canonical, "sessions"));
  assert.equal(paths.codexDatabase, path.join(canonical, "state_5.sqlite"));
  assert.equal(paths.brokerScript, "/srv/bridge/scripts/codex-whatsapp-broker.mjs");
});
