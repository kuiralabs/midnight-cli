// The npm-shrinkwrap.json mn ships: the tree package-lock.json resolves for
// mn's own dependencies, the one the tests ran on, as an install of the
// published package lays it out. Each SDK engine there resolves its own SDK
// set once (the rc set at the top, the beta set nested under its engine).
// Left to resolve on its own, an install mixes the sets: the beta set's loose
// ranges reach newer betas built on the rc ledger, and an engine's ledger then
// refuses the objects another copy made.
//
// From the lockfile: every entry mn's production dependencies reach, by
// Node's resolution over the lockfile's paths. The workspace packages mn
// depends on are links there (node_modules/<name> -> packages/<dir>); in the
// shrinkwrap each is the published package, with its own nested entries moved
// under it, and its tarball and integrity from `dist`.
//
// The release job writes it beside package.json just before publishing (npm
// packs npm-shrinkwrap.json with the package); the workspace never keeps one,
// since npm ci would then install from it instead of package-lock.json.
//
//   node scripts/make-shrinkwrap.mjs [--registry <url>] [--out <file>]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

/** A published package's tarball and integrity, as `registry` serves them. */
export function registryDist(registry) {
  return (name, version) => {
    const dist = JSON.parse(execFileSync('npm', ['view', `${name}@${version}`, 'dist', '--json', '--registry', registry], { encoding: 'utf-8' }));
    return { resolved: dist.tarball, integrity: dist.integrity };
  };
}

/** The lockfile path a package named `name` resolves to from the package at `from`, or undefined. */
function resolveIn(packages, from, name) {
  for (let dir = from; ; dir = dir === '' ? null : parentOf(dir)) {
    if (dir === null) return undefined;
    const path = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[path] !== undefined) return path;
  }
}

/** The folder whose node_modules a package at `path` resolves from next: the package holding it, or the root. */
function parentOf(path) {
  const at = path.lastIndexOf('/node_modules/');
  if (at !== -1) return path.slice(0, at);
  return path.startsWith('node_modules/') || path.startsWith('packages/') ? '' : null;
}

/**
 * mn's shrinkwrap from `lock` (package-lock.json) and `manifest`
 * (package.json); `dist(name, version)` gives a workspace package's published
 * tarball and integrity.
 */
export function shrinkwrapFrom(lock, manifest, dist) {
  const packages = lock.packages;
  // The workspace packages, by their folder: what mn's links point at.
  const workspaces = new Map(
    Object.entries(packages)
      .filter(([path, entry]) => path.startsWith('node_modules/') && entry.link === true)
      .map(([path, entry]) => [entry.resolved, path.slice('node_modules/'.length)]),
  );
  // Where each lockfile path lands in an install of mn.
  const placed = (path) => {
    for (const [dir, name] of workspaces) {
      if (path === dir) return `node_modules/${name}`;
      if (path.startsWith(dir + '/node_modules/')) return `node_modules/${name}${path.slice(dir.length)}`;
    }
    return path;
  };

  const reached = new Set();
  const visit = (from, deps) => {
    for (const [name, optional] of deps) {
      let path = resolveIn(packages, from, name);
      if (path === undefined) {
        if (optional) continue;
        throw new Error(`package-lock.json resolves no ${name} for ${from || 'mn'}`);
      }
      if (packages[path].link === true) path = packages[path].resolved;
      if (reached.has(path)) continue;
      reached.add(path);
      visit(path, depsOf(packages[path]));
    }
  };
  const depsOf = (entry) => [
    ...Object.keys(entry.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, true]),
    ...Object.keys(entry.peerDependencies ?? {}).map((name) => [name, entry.peerDependenciesMeta?.[name]?.optional === true]),
  ];
  visit('', depsOf(manifest));

  const { name, version, license, bin, engines, dependencies, optionalDependencies } = manifest;
  const out = { '': { name, version, license, dependencies, optionalDependencies, bin, engines } };
  for (const path of [...reached].sort()) {
    const entry = { ...packages[path] };
    delete entry.dev;
    delete entry.devOptional;
    if (workspaces.has(path)) {
      Object.assign(entry, dist(workspaces.get(path), entry.version));
      delete entry.name;
    }
    out[placed(path)] = entry;
  }
  return { name, version, lockfileVersion: 3, requires: true, packages: out };
}

/** Writes mn's shrinkwrap to `out`; returns its packages. */
export function makeShrinkwrap({ dist = registryDist('https://registry.npmjs.org'), out = join(repo, 'npm-shrinkwrap.json') } = {}) {
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf-8'));
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8'));
  const shrinkwrap = shrinkwrapFrom(lock, manifest, dist);
  writeFileSync(out, JSON.stringify(shrinkwrap, null, 2) + '\n');
  return shrinkwrap.packages;
}

/** The copies of `name` an install of the shrinkwrap holds, by path, with their versions. */
export function copiesInShrinkwrap(packages, name) {
  return Object.entries(packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, entry]) => ({ path, version: entry.version }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = (name) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const out = flag('--out') ?? join(repo, 'npm-shrinkwrap.json');
  const packages = makeShrinkwrap({ dist: registryDist(flag('--registry') ?? 'https://registry.npmjs.org'), out });
  for (const copy of copiesInShrinkwrap(packages, '@midnightntwrk/ledger-v9')) console.log(`ledger-v9 ${copy.version}  ${copy.path}`);
  console.log(`wrote ${out}`);
}

