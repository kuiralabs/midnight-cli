import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_REPOSITORY_URL } from '../lib/pkg.ts';
import { buildManual } from '../commands/manual.ts';
import { PUBLIC_PACKAGES } from '../../scripts/api-report.mjs';
import { shipsShrinkwrap } from '../../scripts/pack-release.mjs';

// The root package.json is the one place the repository's address is written.
// Every published package must carry the same address, because npm provenance
// checks it against the repository that publishes the package.

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const packageDirs = readdirSync('packages').filter((dir) => existsSync(join('packages', dir, 'package.json')));

describe('repository links', () => {
  it('derives the web address from the root repository url', () => {
    expect(root.repository.url).toBe(`git+${PKG_REPOSITORY_URL}.git`);
    expect(PKG_REPOSITORY_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  });

  it('points the root homepage and issues at the same repository', () => {
    expect(root.homepage).toBe(`${PKG_REPOSITORY_URL}#readme`);
    expect(root.bugs.url).toBe(`${PKG_REPOSITORY_URL}/issues`);
  });

  it.each(packageDirs)('packages/%s carries the root repository and issue links (run node scripts/sync-repository.mjs)', (dir) => {
    const manifest = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'));
    expect(manifest.repository).toEqual({ ...root.repository, directory: `packages/${dir}` });
    expect(manifest.bugs).toEqual(root.bugs);
  });

  it('shows the repository in the manual', () => {
    const manual = buildManual().replace(/\x1b\[[0-9;]*m/g, '');
    expect(manual).toContain(`Repository:        ${PKG_REPOSITORY_URL.replace(/^https:\/\//, '')}`);
  });
});

// One SDK set per engine package, and none at mn's root: with no SDK at the
// root, an import of it outside an engine fails to resolve instead of loading
// another copy beside the engine's.
describe('the SDK in the manifests', () => {
  const isSdk = (name: string) => /^@midnight(-ntwrk|ntwrk)\//.test(name);
  const manifest = (dir: string) => JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'));

  it('is no dependency of mn itself', () => {
    expect(Object.keys(root.dependencies ?? {}).filter(isSdk)).toStrictEqual([]);
    expect(Object.keys(root.optionalDependencies ?? {}).filter(isSdk)).toStrictEqual([]);
  });

  it('is pinned exactly by each engine package, its ledger and onchain runtime directly', () => {
    const engines = packageDirs.filter((dir) => dir.startsWith('engine-'));
    expect(engines.length).toBeGreaterThan(0);
    for (const dir of engines) {
      const sdk = Object.entries<string>(manifest(dir).dependencies).filter(([name]) => isSdk(name));
      for (const [name, range] of sdk) expect(range, `${dir} ${name}`).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
      expect(sdk.map(([name]) => name), dir).toEqual(expect.arrayContaining(['@midnightntwrk/ledger-v9', '@midnightntwrk/onchain-runtime-v4']));
    }
  });

  it('is no dependency of core, chain, wallet, contract, connect, dev or grant', () => {
    for (const dir of ['cli-core', 'chain', 'wallet', 'contract', 'connect', 'dev', 'grant']) expect(Object.keys(manifest(dir).dependencies ?? {}).filter(isSdk), dir).toStrictEqual([]);
  });
});

// What npm shows of each public package, and what an install of it holds:
// the same license, author and Node.js as mn, and only its build (with the
// shrinkwrap the release job writes, for a package that ships one).
describe("the public packages' manifests", () => {
  const manifest = (dir: string) => JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'));

  it('are every @kuiralabs workspace package mn depends on', () => {
    const workspaceNames = (root.workspaces as string[]).map((folder) => JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).name as string);
    const ours = workspaceNames.filter((name) => name.startsWith('@kuiralabs/'));
    expect(PUBLIC_PACKAGES.map((dir) => manifest(dir).name).sort()).toStrictEqual(ours.sort());
    for (const name of ours) expect(root.dependencies[name], name).toBeDefined();
  });

  it.each([...PUBLIC_PACKAGES])("%s: mn's license, its author's GitHub account, mn's Node.js, and only its build in files", (dir) => {
    const { name, license, author, engines, files } = manifest(dir);
    expect(license).toBe(root.license);
    expect(root.author).toContain(`https://github.com/${author}`);
    expect(engines).toStrictEqual({ node: root.engines.node });
    expect(files).toStrictEqual(shipsShrinkwrap(name) ? ['dist', 'npm-shrinkwrap.json'] : ['dist']);
  });
});

// The release job publishes the public packages before mn, each after the
// workspace packages it declares, so a package's exact pins resolve when it
// is published.
describe("the release job's publish order", () => {
  const workflow = readFileSync(join('.github', 'workflows', 'release-sidecar.yml'), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Publish the workspace packages mn depends on'));
  const order = /for dir in ([^;]+); do/.exec(step)![1]!.trim().split(/\s+/).map((dir) => dir.replace(/^packages\//, ''));

  it('publishes every public package, once', () => {
    expect([...order].sort()).toStrictEqual([...PUBLIC_PACKAGES].sort());
  });

  it('publishes each package after the workspace packages it depends on', () => {
    const dirOf = new Map(PUBLIC_PACKAGES.map((dir) => [JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8')).name as string, dir]));
    for (const [at, dir] of order.entries()) {
      const declared = Object.keys(JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8')).dependencies ?? {}).filter((name) => dirOf.has(name));
      for (const name of declared) expect(order.indexOf(dirOf.get(name)!), `${dir} needs ${name} published first`).toBeLessThan(at);
    }
  });

  it('publishes mn after them', () => {
    expect(workflow.indexOf('- name: Publish main package')).toBeGreaterThan(workflow.indexOf('- name: Publish the workspace packages mn depends on'));
  });
});
