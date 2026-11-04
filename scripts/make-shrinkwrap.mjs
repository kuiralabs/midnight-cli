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
// Each SDK engine ships one too (`--package packages/engine-*`), so a program
// that installs an engine without mn gets the set the tests ran on; and so
// does grant (`--package packages/grant`), whose account chain is built on the
// rc set. It leaves out the workspace packages the package depends on (core
// and chain; for grant also wallet and contract): those are shared with the
// program that loads it, which installs them itself, so the process holds one
// copy of each.
//
// The release job writes them beside each package.json just before
// publishing (npm packs npm-shrinkwrap.json with the package, as each `files`
// list says); the workspace never keeps one, since npm ci would then install
// from it instead of package-lock.json.
//
//   node scripts/make-shrinkwrap.mjs [--package <dir>] [--registry <url>] [--out <file>]

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
 * The shrinkwrap of the package at `at` in the workspace (mn, at the root, by
 * default) from `lock` (package-lock.json) and `manifest` (its package.json);
 * `dist(name, version)` gives a workspace package's published tarball and
 * integrity. The dependencies in `leaveOut` are not in it: a consumer resolves
 * them itself, so one copy serves the consumer and the package alike.
 *
 * mn's tree is laid out as the lockfile lays it out: the lockfile is already
 * an install of mn. A workspace package's tree spans its own folder and the
 * root's, so it is laid out afresh, as Node resolves it: each dependency the
 * lockfile resolves goes as high as it can without hiding another version a
 * package above already resolves, else beside the package that needs it. An
 * engine's own SDK set then sits at its top while the shared packages it also
 * reaches keep their versions.
 */
export function shrinkwrapFrom(lock, manifest, dist, { at = '', leaveOut = [] } = {}) {
  const packages = lock.packages;
  // The workspace packages, by their folder: what mn's links point at.
  const workspaces = new Map(
    Object.entries(packages)
      .filter(([path, entry]) => path.startsWith('node_modules/') && entry.link === true)
      .map(([path, entry]) => [entry.resolved, path.slice('node_modules/'.length)]),
  );
  const depsOf = (entry) => [
    ...Object.keys(entry.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, true]),
    ...Object.keys(entry.peerDependencies ?? {}).map((name) => [name, entry.peerDependenciesMeta?.[name]?.optional === true]),
  ];

  // The layout: each place in the install (a node_modules path under the
  // package, '' for the package itself) and the lockfile path installed there.
  const layout = new Map([['', at]]);
  /** Where the lockfile itself puts a path in an install of mn. */
  const lockPlace = (path) => {
    for (const [dir, name] of workspaces) {
      if (path === dir) return `node_modules/${name}`;
      if (path.startsWith(dir + '/node_modules/')) return `node_modules/${name}${path.slice(dir.length)}`;
    }
    return path;
  };
  /** Where Node finds `name` from the package at `place`, or undefined. */
  const found = (place, name) => {
    for (let dir = place; ; dir = dir.lastIndexOf('/node_modules/') === -1 ? '' : dir.slice(0, dir.lastIndexOf('/node_modules/'))) {
      const candidate = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
      if (layout.has(candidate)) return candidate;
      if (dir === '') return undefined;
    }
  };
  const queue = [['', depsOf(manifest).filter(([name]) => !leaveOut.includes(name))]];
  while (queue.length > 0) {
    const [place, deps] = queue.shift();
    for (const [name, optional] of deps) {
      let path = resolveIn(packages, layout.get(place), name);
      if (path === undefined) {
        if (optional) continue;
        throw new Error(`package-lock.json resolves no ${name} for ${layout.get(place) || 'mn'}`);
      }
      if (packages[path].link === true) path = packages[path].resolved;
      if (at === '') {
        const to = lockPlace(path);
        if (!layout.has(to)) {
          layout.set(to, path);
          queue.push([to, depsOf(packages[path])]);
        }
        continue;
      }
      const there = found(place, name);
      if (there !== undefined && layout.get(there) === path) continue;
      // Nothing by that name above: at the top. Another version above: beside the package that needs this one.
      const to = there === undefined ? `node_modules/${name}` : place === '' ? `node_modules/${name}` : `${place}/node_modules/${name}`;
      if (layout.has(to)) throw new Error(`${path} and ${layout.get(to)} both land at ${to} in ${manifest.name}'s shrinkwrap`);
      layout.set(to, path);
      queue.push([to, depsOf(packages[path])]);
    }
  }

  const { name, version, license, bin, engines, dependencies, optionalDependencies } = manifest;
  const out = { '': { name, version, license, dependencies, optionalDependencies, bin, engines } };
  for (const [place, path] of [...layout].filter(([place]) => place !== '').sort(([a], [b]) => a.localeCompare(b))) {
    const entry = { ...packages[path] };
    delete entry.dev;
    delete entry.devOptional;
    if (workspaces.has(path)) {
      Object.assign(entry, dist(workspaces.get(path), entry.version));
      delete entry.name;
    }
    out[place] = entry;
  }
  return { name, version, lockfileVersion: 3, requires: true, packages: out };
}

/**
 * Writes the shrinkwrap of the package in `dir` (mn, the repository's root,
 * by default) to `out` (beside its package.json by default); returns its
 * packages. A workspace package's shrinkwrap leaves out the workspace
 * packages it depends on.
 */
export function makeShrinkwrap({ dir = '', dist = registryDist('https://registry.npmjs.org'), out = join(repo, dir, 'npm-shrinkwrap.json') } = {}) {
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf-8'));
  const manifest = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf-8'));
  const workspaceNames = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8')).workspaces ?? [])
    .map((folder) => JSON.parse(readFileSync(join(repo, folder, 'package.json'), 'utf-8')).name);
  const leaveOut = dir === '' ? [] : Object.keys(manifest.dependencies ?? {}).filter((name) => workspaceNames.includes(name));
  const shrinkwrap = shrinkwrapFrom(lock, manifest, dist, { at: dir, leaveOut });
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
  const dir = (flag('--package') ?? '').replace(/\/$/, '');
  const out = flag('--out') ?? join(repo, dir, 'npm-shrinkwrap.json');
  const packages = makeShrinkwrap({ dir, dist: registryDist(flag('--registry') ?? 'https://registry.npmjs.org'), out });
  for (const copy of copiesInShrinkwrap(packages, '@midnightntwrk/ledger-v9')) console.log(`ledger-v9 ${copy.version}  ${copy.path}`);
  console.log(`wrote ${out}`);
}

