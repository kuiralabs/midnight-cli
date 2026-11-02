#!/usr/bin/env node
// Spike EB: load ONE engine by package name (never both) and report every SDK package the process
// actually resolved, from a resolve hook installed before the engine is imported.
//
//   mn-engine-probe <rc|beta> <bytesDir> [--dust <events.json>] [--foreign <probe-output.json>] [--out <file>]
import { registerHooks } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const resolved = new Set();
let hooks = 'module.registerHooks';
if (typeof registerHooks === 'function') {
  registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); resolved.add(r.url); return r; } });
} else hooks = 'unavailable in this runtime';

const [set, bytesDir, ...rest] = process.argv.slice(2);
if (!['rc', 'beta'].includes(set) || !bytesDir) {
  console.error('usage: mn-engine-probe <rc|beta> <bytesDir> [--dust <events.json>] [--foreign <probe-output.json>] [--out <file>]');
  process.exit(2);
}
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

const input = { params: {}, txs: {} };
for (const f of readdirSync(bytesDir)) {
  if (f.endsWith('-ledger-params.hex')) input.params[f.replace('-ledger-params.hex', '')] = readFileSync(path.join(bytesDir, f), 'utf8').trim();
  if (f.endsWith('-txs.json')) input.txs[f.replace('-txs.json', '')] = JSON.parse(readFileSync(path.join(bytesDir, f), 'utf8'));
}
if (opt('--dust')) input.dustEvents = JSON.parse(readFileSync(opt('--dust'), 'utf8'));
if (opt('--foreign')) {
  const other = JSON.parse(readFileSync(opt('--foreign'), 'utf8'));
  input.foreignDust = { fresh: other.result.dust.freshHex, half: other.result.dust.halfHex };
}

const engineName = `@kuiralabs/mn-engine-${set}`;
const { probe } = await import(engineName);
const result = await probe(input);

// Group every resolved file by the package that owns it.
const owners = new Map();
for (const url of resolved) {
  if (!url.startsWith('file:')) continue;
  let dir = path.dirname(fileURLToPath(url));
  while (dir !== path.dirname(dir)) {
    let pj; try { pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { dir = path.dirname(dir); continue; }
    if (pj.name && pj.version) { const k = `${pj.name}|${pj.version}|${dir}`; owners.set(k, (owners.get(k) ?? 0) + 1); break; }
    dir = path.dirname(dir);
  }
}
const loaded = {};
for (const k of owners.keys()) {
  const [name, version, dir] = k.split('|');
  if (!/midnight|kuiralabs/.test(name)) continue;
  (loaded[name] ??= []).push(`${version} @ ${dir}`);
}
const CRITICAL = ['@midnightntwrk/ledger-v9', '@midnightntwrk/onchain-runtime-v4', '@midnight-ntwrk/compact-runtime', '@midnight-ntwrk/compact-js'];
const verdict = {};
for (const n of CRITICAL) verdict[n] = (loaded[n] ?? []).length;
const otherEngineLoaded = Object.keys(loaded).includes(`@kuiralabs/mn-engine-${set === 'rc' ? 'beta' : 'rc'}`);
const sdkCopies = Object.fromEntries(Object.entries(loaded).filter(([, v]) => v.length > 1));
const report = { set, hooks, node: process.version, engine: loaded[engineName], verdict, oneEach: CRITICAL.every((n) => verdict[n] === 1), otherEngineLoaded, sdkPackagesLoadedTwice: sdkCopies, loaded, result };

const out = opt('--out');
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
const brief = { ...report, result: { ...result, dust: result.dust && { ...result.dust, halfHex: `${result.dust.halfHex.length / 2} bytes`, freshHex: `${result.dust.freshHex.length / 2} bytes` } } };
console.log(JSON.stringify(brief, null, 1));
