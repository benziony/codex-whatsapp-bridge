#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readConfig } from "./lib/runtime-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = readConfig();
const statePath = path.join(path.dirname(config._path), "update-state.json");
const git = (args) => spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8", timeout: 20_000 });
const local = git(["rev-parse", "HEAD"]);
const remote = git(["ls-remote", "origin", "refs/heads/main"]);
if (local.status !== 0 || remote.status !== 0) process.exit(1);
const current = local.stdout.trim();
const available = remote.stdout.trim().split(/\s+/, 1)[0];
let prior = {};
try { prior = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* first run */ }
if (!available || current === available || prior.notifiedCommit === available) process.exit(0);
const response = await fetch(`${config.whatsapp.bridgeUrl}/send`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chatId: config.whatsapp.chatId,
    message: `Codex WhatsApp Bridge update available: ${available.slice(0, 12)}. Open Codex in the repository and ask it to review and install the update.`,
  }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) process.exit(1);
fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
fs.writeFileSync(statePath, `${JSON.stringify({ notifiedCommit: available, checkedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });

