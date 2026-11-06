// A workspace package is published without the development-only source
// condition: the tarball's package.json (which the registry's metadata is read
// from) names only built files. Packing happens on a copy of each manifest in
// a folder of its own, so the workspace's package.json files, which the other
// tests resolve through, are never rewritten while they run.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PACKAGES } from '../../scripts/api-report.mjs';
import { SOURCE_CONDITION, isLocalTarball, localTarballsOf, packPublished, packedFilename, publishedManifest, withLocalTarballsAsVersions } from '../../scripts/publish-manifest.mjs';

const PACKAGES = join(import.meta.dirname, '..', '..', 'packages');
const manifestOf = (dir: string) => readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8');

describe('the published manifest', () => {
  it.each([...PUBLIC_PACKAGES])('%s: names no source file, and is otherwise the package\'s own', (dir) => {
    const manifest = JSON.parse(manifestOf(dir)) as { exports: Record<string, Record<string, string>> };
    expect(manifestOf(dir)).toContain(SOURCE_CONDITION);
    const published = publishedManifest(manifest);
    expect(JSON.stringify(published)).not.toContain(SOURCE_CONDITION);
    expect(Object.keys(published.exports)).toStrictEqual(Object.keys(manifest.exports));
    for (const [subpath, conditions] of Object.entries(manifest.exports)) {
      const { [SOURCE_CONDITION]: source, ...rest } = conditions;
      expect(source, subpath).toMatch(/^\.\/src\//);
      expect(published.exports[subpath], subpath).toStrictEqual(rest);
    }
    expect({ ...published, exports: undefined }).toStrictEqual({ ...manifest, exports: undefined });
  });

  it.each([...PUBLIC_PACKAGES])('%s: packs a tarball whose package.json has no source condition, and puts the manifest back as it was', (dir) => {
    const work = mkdtempSync(join(tmpdir(), 'mn-publish-manifest-'));
    try {
      // As deep as the package sits in the repository, so a dependency's tarball on disk sits where its path says.
      const folder = join(work, 'repo', 'packages', dir);
      mkdirSync(folder, { recursive: true });
      copyFileSync(join(PACKAGES, dir, 'package.json'), join(folder, 'package.json'));
      for (const tarball of localTarballsOf(join(PACKAGES, dir))) {
        const there = resolve(folder, relative(join(PACKAGES, dir), tarball));
        mkdirSync(dirname(there), { recursive: true });
        copyFileSync(tarball, there);
      }
      const tarball = packPublished(folder, join(work, 'out'));
      const packed = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
      expect(packed).not.toContain(SOURCE_CONDITION);
      expect(packed).not.toContain('file:');
      expect(JSON.parse(packed).exports).toStrictEqual(publishedManifest(JSON.parse(manifestOf(dir))).exports);
      expect(readFileSync(join(folder, 'package.json'), 'utf8')).toBe(manifestOf(dir));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the tarball's name in npm pack's output", () => {
  // As npm prints `npm pack --json` for one package: npm 11 an array of one
  // entry, npm 12 an object keyed by the package's name (the release job
  // installs the latest npm; npm 12 broke rc.14's first release run).
  const entry = { id: '@kuiralabs/midnight-cli-core@0.1.0-rc.3', name: '@kuiralabs/midnight-cli-core', version: '0.1.0-rc.3', filename: 'kuiralabs-midnight-cli-core-0.1.0-rc.3.tgz', files: [] };

  it('is read from npm 11 and from npm 12', () => {
    expect(packedFilename(JSON.stringify([entry]))).toBe(entry.filename);
    expect(packedFilename(JSON.stringify({ [entry.name]: entry }))).toBe(entry.filename);
  });

  it('is refused when the output names no single tarball', () => {
    expect(() => packedFilename('[]')).toThrow('no single tarball');
    expect(() => packedFilename(JSON.stringify({ a: entry, b: entry }))).toThrow('no single tarball');
  });
});

describe('a dependency installed from a tarball on disk', () => {
  it('is published as the version the tarball holds, every other spec as it is', () => {
    const read: string[] = [];
    const manifest = {
      name: '@x/engine',
      dependencies: { '@x/chain': 'file:../../../local/x-chain-0.4.0-rc.0.tgz', ws: '^8.19.0' },
      peerDependencies: { '@x/peer': 'file:peer.tgz' },
    };
    const published = withLocalTarballsAsVersions(manifest, '/repo/packages/engine', (path) => { read.push(path); return path.includes('chain') ? '0.4.0-rc.0' : '2.0.0'; });
    expect(published.dependencies).toStrictEqual({ '@x/chain': '0.4.0-rc.0', ws: '^8.19.0' });
    expect(published.peerDependencies).toStrictEqual({ '@x/peer': '2.0.0' });
    expect(read).toStrictEqual(['/local/x-chain-0.4.0-rc.0.tgz', '/repo/packages/engine/peer.tgz']);
    expect(manifest.dependencies['@x/chain']).toBe('file:../../../local/x-chain-0.4.0-rc.0.tgz');
  });

  it('is told apart from a folder link and a registry range', () => {
    expect(isLocalTarball('file:../x.tgz')).toBe(true);
    expect(isLocalTarball('file:../x')).toBe(false);
    expect(isLocalTarball('^1.0.0')).toBe(false);
    expect(isLocalTarball(undefined)).toBe(false);
  });
});
