// Each public package states its API through named entry points: its exports
// map has no pattern subpath (`./*`) a program could reach any module through,
// and its entry points are the agreed ones. A new entry point is a change to
// the API, agreed first and added here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PACKAGES } from '../../scripts/api-report.mjs';

const PACKAGES = join(import.meta.dirname, '..', '..', 'packages');

/** The agreed entry points of each public package, by folder under packages/. */
const ENTRY_POINTS: Record<string, string[]> = {
  'cli-core': ['.', './engine', './ui', './commands'],
  chain: ['.', './commands'],
  'engine-rc': ['.'],
  'engine-beta': ['.'],
  wallet: ['.', './commands'],
  contract: ['.', './commands'],
  connect: ['.', './commands'],
  dev: ['.', './commands'],
};

describe('the public entry points', () => {
  it('are agreed for every public package', () => {
    expect(Object.keys(ENTRY_POINTS).sort()).toStrictEqual([...PUBLIC_PACKAGES].sort());
  });

  it.each(Object.entries(ENTRY_POINTS))('%s: its exports map lists the agreed entry points and no pattern', (dir, agreed) => {
    const { exports } = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
    expect(Object.keys(exports).filter((key) => key.includes('*'))).toStrictEqual([]);
    expect(Object.keys(exports)).toStrictEqual(agreed);
  });
});
