#!/usr/bin/env node
// Spike EB: pack both engines, then pack mn variants that depend on them, all into a scratch dir.
//
//   node spike/pack.mjs <scratchDir>                      engines referenced by absolute file: tarball paths
//   node spike/pack.mjs <scratchDir> --registry <url>     engines referenced by version, served by
//                                                         spike/local-registry.mjs from <scratchDir>/registry
//
// Variants of mn's package.json (built from the repo's own, in scratch, never written back):
//   root-rc      today's root dependencies (the rc set, the account packages) plus both engines
//   no-root      no SDK and no account package at the root, only the two engines
//   *-sw         the same, shipping an npm-shrinkwrap.json generated with --install-strategy=shallow
//                (registry mode only: the lock is resolved against the registry)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spikeDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(spikeDir);
const [scratchArg, flag, registry] = process.argv.slice(2);
if (!scratchArg || (flag && (flag !== '--registry' || !registry))) { console.error('usage: node spike/pack.mjs <scratchDir> [--registry <url>]'); process.exit(2); }
const scratch = path.resolve(scratchArg);
const outDir = path.join(scratch, registry ? 'registry' : 'tarballs');
const cache = path.join(scratch, 'npm-cache');
mkdirSync(outDir, { recursive: true });

const npm = (args, cwd) => execFileSync('npm', [...args, '--cache', cache, '--loglevel=error', ...(registry ? ['--registry', registry] : [])], { cwd, encoding: 'utf8' });
const pack = (dir) => path.join(outDir, JSON.parse(npm(['pack', '--json', '--pack-destination', outDir], dir))[0].filename);

const engines = {};
for (const set of ['rc', 'beta']) {
  const dir = path.join(spikeDir, 'engines', set);
  copyFileSync(path.join(spikeDir, 'engines', 'probe-core.mjs'), path.join(dir, 'probe-core.mjs'));
  const tgz = pack(dir);
  engines[set] = registry ? JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version : `file:${tgz}`;
  console.log('engine', set, tgz);
}

const SDK = /^@midnight-ntwrk\/|^@midnightntwrk\/(?!dapp-connector-api)|^@kuiralabs\/midnight-account/;
const base = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const variants = registry ? ['root-rc', 'no-root', 'root-rc-sw', 'no-root-sw'] : ['root-rc', 'no-root'];
for (const variant of variants) {
  const dir = path.join(scratch, `mn-${variant}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'spike'), { recursive: true });
  const deps = { ...base.dependencies };
  if (variant.startsWith('no-root')) for (const k of Object.keys(deps)) if (SDK.test(k)) delete deps[k];
  deps['@kuiralabs/mn-engine-rc'] = engines.rc;
  deps['@kuiralabs/mn-engine-beta'] = engines.beta;
  const shrinkwrap = variant.endsWith('-sw');
  const pj = {
    name: base.name,
    version: `${base.version}-spike-${variant}`,
    type: 'module',
    license: base.license,
    bin: { 'mn-engine-probe': 'spike/mn-engine-probe.mjs' },
    files: ['spike/mn-engine-probe.mjs', ...(shrinkwrap ? ['npm-shrinkwrap.json'] : [])],
    engines: base.engines,
    dependencies: deps,
  };
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj, null, 2) + '\n');
  copyFileSync(path.join(spikeDir, 'mn-engine-probe.mjs'), path.join(dir, 'spike', 'mn-engine-probe.mjs'));
  if (shrinkwrap) {
    npm(['install', '--install-strategy=shallow', '--package-lock-only', '--no-audit', '--no-fund'], dir);
    npm(['shrinkwrap'], dir);
  }
  console.log('mn', variant, pack(dir));
}
