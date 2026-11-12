// `mn wallet seed` shows the seed only when the person answers yes. A no, and
// input that ends with no answer, are a cancelled call (CANCELLED, exit 7):
// both used to exit 0 as if the seed had been shown.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../test-support/run-cli.ts';

const SEED = 'ab'.repeat(32);
const PASSPHRASE = { MN_PASSPHRASE: 'wallet-seed-test-passphrase' };
let home: string;

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-wallet-seed-')));
  const made = await runCli(home, ['wallet', 'generate', 'alice', '--seed', SEED, '--json'], { env: PASSPHRASE });
  expect(made.status).toBe(0);
}, 60_000);
afterAll(async () => { rmSync(home, { recursive: true, force: true }); });

describe('mn wallet seed', () => {
  it('exits CANCELLED (7) when the input ends before an answer, showing nothing', async () => {
    const run = await runCli(home, ['wallet', 'seed', 'alice'], { env: PASSPHRASE, input: '' });
    expect(run.status).toBe(7);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toContain(SEED);
    expect(run.stderr).toContain('the seed was not shown');
  });

  it('exits CANCELLED (7) on a no, showing nothing', async () => {
    const run = await runCli(home, ['wallet', 'seed', 'alice'], { env: PASSPHRASE, input: 'n\n' });
    expect(run.status).toBe(7);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toContain(SEED);
  });

  it('shows the seed on a yes, exit 0', async () => {
    const run = await runCli(home, ['wallet', 'seed', 'alice'], { env: PASSPHRASE, input: 'y\n' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${SEED}\n`);
  });
});
