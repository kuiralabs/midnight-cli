// `wallet remove` takes the wallet's caches with it: its sync caches (named
// by its addresses) and its Dust and shielded readers' caches on every
// network (named by keys from its seed, opened with mn's passphrase). With no
// passphrase to be had, the wallet and its sync caches still go, and it says
// which caches were left and how to clear them. Run as a user runs it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDustCachePath, getShieldedCachePath } from '@kuiralabs/midnight-cli-core/engine';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { runCli } from '../../test-support/run-cli.ts';

const PASSPHRASE = { MN_PASSPHRASE: 'correct horse battery staple' };
const BOB_SEED = '42'.repeat(32);
let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mn-wallet-remove-'));
  root = join(home, '.midnight');
  expect(runCli(home, ['wallet', 'generate', 'alice', '--json'], { env: PASSPHRASE }).status).toBe(0);
  expect(runCli(home, ['wallet', 'generate', 'bob', '--seed', BOB_SEED, '--json'], { env: PASSPHRASE }).status).toBe(0);
  expect(runCli(home, ['wallet', 'use', 'alice'], { env: PASSPHRASE }).status).toBe(0);
}, 120_000);
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Bob's reader caches on two networks, as files on disk. */
function bobsReaderCaches(): string[] {
  const seed = Buffer.from(BOB_SEED, 'hex');
  const files = (['undeployed', 'preview'] as const).flatMap((network) => [
    getDustCachePath(network, rcKeys.dustPublicKeyHex(seed), root),
    getShieldedCachePath(network, rcKeys.shieldedCoinPublicKeyHex(seed), root),
  ]);
  for (const file of files) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '{}'); }
  return files;
}

describe('wallet remove', () => {
  it('with the passphrase, removes the wallet and its Dust and shielded reader caches on every network', () => {
    const caches = bobsReaderCaches();
    const run = runCli(home, ['wallet', 'remove', 'bob', '--json'], { env: PASSPHRASE });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toStrictEqual({ wallet: 'bob', removed: true, readerCachesCleared: true });
    expect(existsSync(join(root, 'wallets', 'bob.json'))).toBe(false);
    expect(caches.filter(existsSync)).toEqual([]);
  }, 120_000);

  // Regression: removing a wallet never asked for its seed, so its reader caches stayed for ever.
  it('with no passphrase to be had, still removes the wallet, and says which caches were left and how to clear them', () => {
    const caches = bobsReaderCaches();
    const run = runCli(home, ['wallet', 'remove', 'bob', '--json']);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({ wallet: 'bob', removed: true, readerCachesCleared: false });
    expect(result.warnings).toEqual([expect.stringContaining('midnight cache clear --network <name>')]);
    expect(existsSync(join(root, 'wallets', 'bob.json'))).toBe(false);
    expect(caches.filter(existsSync)).toEqual(caches);

    // Without --json, the same on stderr.
    const again = runCli(home, ['wallet', 'generate', 'bob', '--seed', BOB_SEED, '--json'], { env: PASSPHRASE });
    expect(again.status, again.stdout).toBe(0);
    // Generating made bob the active wallet.
    expect(runCli(home, ['wallet', 'use', 'alice'], { env: PASSPHRASE }).status).toBe(0);
    const human = runCli(home, ['wallet', 'remove', 'bob']);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stderr).toContain('The Dust and shielded reader caches of wallet "bob" were left');
  }, 120_000);

  it('with a wrong passphrase removes nothing', () => {
    const run = runCli(home, ['wallet', 'remove', 'bob', '--json'], { env: { MN_PASSPHRASE: 'not the passphrase at all' } });
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'WRONG_PASSPHRASE' });
    expect(readFileSync(join(root, 'wallets', 'bob.json'), 'utf8')).toContain('sealed');
  }, 120_000);
});
