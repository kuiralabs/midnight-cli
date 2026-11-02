// Each test file loads one SDK engine at most, as mn's processes do, and the
// files that load the beta engine are named for it (engine-beta*.test.ts), so
// CI runs the suite once per engine: `npm run test:rc` and `npm run test:beta`.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TESTS = new URL('.', import.meta.url).pathname;
const files = [
  ...readdirSync(TESTS).filter((f) => f.endsWith('.ts')).map((f) => join(TESTS, f)),
  ...readdirSync(join(TESTS, 'helpers')).filter((f) => f.endsWith('.ts')).map((f) => join(TESTS, 'helpers', f)),
];
const loads = (file: string, engine: 'rc' | 'beta') => readFileSync(file, 'utf-8').includes(`@kuiralabs/midnight-engine-${engine}`);

describe('the tests, per SDK engine', () => {
  it('load one engine per file', () => {
    expect(files.filter((f) => loads(f, 'rc') && loads(f, 'beta')).map((f) => f.slice(TESTS.length))).toEqual([]);
  });

  it('load the beta engine only from files named for it', () => {
    const beta = files.filter((f) => loads(f, 'beta') && f !== new URL(import.meta.url).pathname).map((f) => f.slice(TESTS.length));
    expect(beta.length).toBeGreaterThan(0);
    for (const file of beta) expect(file).toMatch(/^engine-beta[\w-]*\.test\.ts$/);
  });
});
