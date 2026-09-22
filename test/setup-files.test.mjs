import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTreeOwnerWritable, removeBridgeHooks } from "../scripts/lib/setup-files.mjs";

test("legacy hook cleanup removes only bridge commands", () => {
  const current = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "/node /release/scripts/codex-whatsapp-client.mjs hook" }] },
        { hooks: [{ type: "command", command: "/usr/local/bin/keep-me" }] },
        { hooks: [{ type: "command", command: "/usr/local/bin/check --subject codex-whatsapp-client.mjs" }] },
      ],
      Notification: [{ hooks: [{ type: "command", command: "/usr/local/bin/also-keep" }] }],
    },
  };
  const cleaned = removeBridgeHooks(current);
  assert.equal(cleaned.hooks.Stop.length, 2);
  assert.equal(cleaned.hooks.Stop[0].hooks[0].command, "/usr/local/bin/keep-me");
  assert.equal(cleaned.hooks.Stop[1].hooks[0].command, "/usr/local/bin/check --subject codex-whatsapp-client.mjs");
  assert.equal(cleaned.hooks.Notification[0].hooks[0].command, "/usr/local/bin/also-keep");
  assert.equal(current.hooks.Stop.length, 3);
});

test("read-only copied plugin trees can be made replaceable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-readonly-plugin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, "plugin", "nested");
  const file = path.join(nested, "plugin.py");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(file, "pass\n");
  fs.chmodSync(file, 0o444);
  fs.chmodSync(nested, 0o555);
  fs.chmodSync(path.dirname(nested), 0o555);

  makeTreeOwnerWritable(path.join(root, "plugin"));
  assert.doesNotThrow(() => fs.rmSync(path.join(root, "plugin"), { recursive: true }));
});
