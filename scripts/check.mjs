#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".controller-")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else files.push(target);
  }
}
walk(root);
const forbidden = [/\/Users\/(?:by|benzionyungreis)\//, /Benzions-MacBook-Pro/i, /com\.benziony/i];
const violations = [];
for (const target of files) {
  if (target === fileURLToPath(import.meta.url)) continue;
  if (!/\.(?:mjs|js|py|md|json|yaml|yml|plist|txt)$/.test(target)) continue;
  const body = fs.readFileSync(target, "utf8");
  if (forbidden.some((pattern) => pattern.test(body))) violations.push(path.relative(root, target));
}
for (const target of files.filter((file) => file.endsWith(".mjs"))) {
  const checked = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
  if (checked.status !== 0) violations.push(`${path.relative(root, target)}:syntax`);
}
for (const target of files.filter((file) => file.endsWith(".py"))) {
  const checked = spawnSync("/usr/bin/python3", ["-m", "py_compile", target], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (checked.status !== 0) violations.push(`${path.relative(root, target)}:syntax`);
}
if (violations.length) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, files: files.length }));
