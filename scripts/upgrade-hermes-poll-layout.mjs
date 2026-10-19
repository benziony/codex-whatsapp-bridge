#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { upgradeHermesPollLayout } from './lib/hermes-poll-layout.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const options = new Map();
for (const arg of process.argv.slice(2)) {
  if (arg === '--apply') options.set('apply', true);
  else if (/^--(bridge|config)=\S+$/.test(arg)) {
    const [key, value] = arg.slice(2).split(/=(.*)/s, 2);
    if (options.has(key)) throw new Error(`Duplicate --${key}`);
    options.set(key, value);
  } else throw new Error(`Unknown argument: ${arg}`);
}

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular, non-symlink file');
  return stat;
}

function syntaxCheck(source) {
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: source, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('Upgraded bridge failed JavaScript syntax check');
}

function main() {
  const configPath = path.resolve(options.get('config') ?? process.env.CODEX_WHATSAPP_CONFIG ?? path.join(os.homedir(), '.config', 'codex-whatsapp-bridge', 'config.json'));
  let bridgePath = options.get('bridge');
  if (!bridgePath) {
    regularFile(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const checkout = config?.gateway?.hermesCheckout;
    if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) throw new Error('Config lacks an absolute gateway.hermesCheckout');
    bridgePath = path.join(checkout, 'scripts', 'whatsapp-bridge', 'bridge.js');
  }
  if (!path.isAbsolute(bridgePath)) throw new Error('--bridge must be absolute');
  const stat = regularFile(bridgePath);
  const original = fs.readFileSync(bridgePath);
  const originalSha256 = sha256(original);
  const upgraded = upgradeHermesPollLayout(original.toString('utf8'));
  syntaxCheck(upgraded.source);
  const candidate = Buffer.from(upgraded.source, 'utf8');
  const candidateSha256 = sha256(candidate);
  if (upgraded.status === 'already-patched' || !options.get('apply')) {
    console.log(JSON.stringify({ status: upgraded.status, bridge: bridgePath, originalSha256, candidateSha256, applied: false }));
    return;
  }
  // Keep the only recovery copy in private configuration backups, outside both
  // the source checkout and runtime session directories.
  const backupDir = path.join(path.dirname(configPath), 'backups');
  const hermesRoot = path.resolve(path.dirname(bridgePath), '..', '..');
  const backupRelative = path.relative(hermesRoot, backupDir);
  if (!backupRelative || (!backupRelative.startsWith(`..${path.sep}`) && backupRelative !== '..')) throw new Error('Unsafe backup directory');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(backupDir).isDirectory() || fs.lstatSync(backupDir).isSymbolicLink()) throw new Error('Unsafe backup directory');
  fs.chmodSync(backupDir, 0o700);
  const backupPath = path.join(backupDir, `hermes-bridge-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${originalSha256.slice(0, 16)}.js`);
  const latest = fs.readFileSync(bridgePath);
  if (sha256(latest) !== originalSha256 || regularFile(bridgePath).ino !== stat.ino) throw new Error('Bridge changed during preparation');
  fs.writeFileSync(backupPath, original, { flag: 'wx', mode: 0o600 });
  let temporary;
  try {
    temporary = path.join(path.dirname(bridgePath), `.bridge.js.compact-${process.pid}-${randomBytes(8).toString('hex')}`);
    fs.writeFileSync(temporary, candidate, { flag: 'wx', mode: stat.mode & 0o777 });
    fs.chmodSync(temporary, stat.mode & 0o777);
    if (sha256(fs.readFileSync(bridgePath)) !== originalSha256 || regularFile(bridgePath).ino !== stat.ino) throw new Error('Bridge changed before atomic replacement');
    fs.renameSync(temporary, bridgePath);
    temporary = undefined;
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
  }
  if (sha256(fs.readFileSync(bridgePath)) !== candidateSha256) throw new Error('Bridge readback hash mismatch');
  console.log(JSON.stringify({ status: 'applied', bridge: bridgePath, originalSha256, candidateSha256, backup: backupPath, applied: true, restart: 'not-performed' }));
}

try { main(); } catch (error) { console.error(`Poll layout upgrade refused: ${error.message}`); process.exitCode = 1; }
