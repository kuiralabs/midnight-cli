import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_REPOSITORY_URL } from '../lib/pkg.ts';
import { buildManual } from '../commands/manual.ts';

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

  it('is no dependency of core or chain', () => {
    for (const dir of ['cli-core', 'chain']) expect(Object.keys(manifest(dir).dependencies ?? {}).filter(isSdk), dir).toStrictEqual([]);
  });
});
