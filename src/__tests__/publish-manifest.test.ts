// A workspace package is published without the development-only source
// condition: the tarball's package.json (which the registry's metadata is read
// from) names only built files. Packing happens on a copy of each manifest in
// a folder of its own, so the workspace's package.json files, which the other
// tests resolve through, are never rewritten while they run.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PACKAGES } from '../../scripts/api-report.mjs';
import { SOURCE_CONDITION, packPublished, publishedManifest } from '../../scripts/publish-manifest.mjs';

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
      const folder = join(work, 'package');
      mkdirSync(folder);
      copyFileSync(join(PACKAGES, dir, 'package.json'), join(folder, 'package.json'));
      const tarball = packPublished(folder, join(work, 'out'));
      const packed = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
      expect(packed).not.toContain(SOURCE_CONDITION);
      expect(JSON.parse(packed).exports).toStrictEqual(publishedManifest(JSON.parse(manifestOf(dir))).exports);
      expect(readFileSync(join(folder, 'package.json'), 'utf8')).toBe(manifestOf(dir));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
