#!/usr/bin/env node
// A workspace package as it is published: its package.json without the
// `midnight-cli-source` condition, which points each entry point at its
// TypeScript source for this repository's own runs (tsx, vitest, tsc) and
// means nothing to a consumer. Packing writes that manifest in place of the
// package's own, runs `npm pack`, and puts the original back, so the tarball
// (and the registry's metadata, read from it) names only the built files.
// The release job and scripts/pack-release.mjs publish what this packs.
//
//   node scripts/publish-manifest.mjs <package-dir> <destination-dir>
//     prints the tarball's path

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The development-only export condition: an entry point's TypeScript source. */
export const SOURCE_CONDITION = 'midnight-cli-source';

/** An exports map (or one entry's conditions) without the source condition, at any depth. */
function withoutSourceCondition(exports) {
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) return exports;
  return Object.fromEntries(Object.entries(exports).filter(([key]) => key !== SOURCE_CONDITION).map(([key, value]) => [key, withoutSourceCondition(value)]));
}

/** The manifest a package is published with: its own, the source condition taken out of `exports`. */
export function publishedManifest(manifest) {
  return manifest.exports === undefined ? manifest : { ...manifest, exports: withoutSourceCondition(manifest.exports) };
}

/**
 * Packs the package in `dir` into `destination` with its published manifest,
 * putting its own package.json back afterwards, byte for byte, whatever
 * happens; returns the tarball's path.
 */
export function packPublished(dir, destination) {
  mkdirSync(destination, { recursive: true });
  const path = join(dir, 'package.json');
  const original = readFileSync(path, 'utf-8');
  writeFileSync(path, JSON.stringify(publishedManifest(JSON.parse(original)), null, 2) + '\n');
  try {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }));
    return join(destination, packed.filename);
  } finally {
    writeFileSync(path, original);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, destination] = process.argv.slice(2);
  if (!dir || !destination) {
    console.error('usage: node scripts/publish-manifest.mjs <package-dir> <destination-dir>');
    process.exit(2);
  }
  console.log(packPublished(resolve(dir), resolve(destination)));
}
