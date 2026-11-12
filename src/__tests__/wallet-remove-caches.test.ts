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
import { PassThrough } from 'node:stream';
import { parseArgs, runCommand } from '@kuiralabs/midnight-cli-core';
import { createTerminalPrompter } from '@kuiralabs/midnight-cli-core/ui';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { runCli } from '../../test-support/run-cli.ts';
import { testHost } from '../../test-support/test-host.ts';
import { installedCommands } from '../lib/installed-commands.ts';

const PASSPHRASE = { MN_PASSPHRASE: 'correct horse battery staple' };
const BOB_SEED = '42'.repeat(32);
let home: string;
let root: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'mn-wallet-remove-'));
  root = join(home, '.midnight');
  expect((await runCli(home, ['wallet', 'generate', 'alice', '--json'], { env: PASSPHRASE })).status).toBe(0);
  expect((await runCli(home, ['wallet', 'generate', 'bob', '--seed', BOB_SEED, '--json'], { env: PASSPHRASE })).status).toBe(0);
  expect((await runCli(home, ['wallet', 'use', 'alice'], { env: PASSPHRASE })).status).toBe(0);
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
  it('with the passphrase, removes the wallet and its Dust and shielded reader caches on every network', async () => {
    const caches = bobsReaderCaches();
    const run = await runCli(home, ['wallet', 'remove', 'bob', '--yes', '--json'], { env: PASSPHRASE });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toStrictEqual({ wallet: 'bob', removed: true, readerCachesCleared: true, cachesKeptFor: [] });
    expect(existsSync(join(root, 'wallets', 'bob.json'))).toBe(false);
    expect(caches.filter(existsSync)).toEqual([]);
  }, 120_000);

  // Regression: removing a wallet never asked for its seed, so its reader caches stayed for ever.
  it('with no passphrase to be had, still removes the wallet, and says which caches were left and how to clear them', async () => {
    const caches = bobsReaderCaches();
    const run = await runCli(home, ['wallet', 'remove', 'bob', '--yes', '--json']);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({ wallet: 'bob', removed: true, readerCachesCleared: false });
    expect(result.warnings).toEqual([expect.stringContaining('midnight cache clear --network <name>')]);
    expect(existsSync(join(root, 'wallets', 'bob.json'))).toBe(false);
    expect(caches.filter(existsSync)).toEqual(caches);

    // Without --json, the same on stderr.
    const again = await runCli(home, ['wallet', 'generate', 'bob', '--seed', BOB_SEED, '--json'], { env: PASSPHRASE });
    expect(again.status, again.stdout).toBe(0);
    // Generating made bob the active wallet.
    expect((await runCli(home, ['wallet', 'use', 'alice'], { env: PASSPHRASE })).status).toBe(0);
    const human = await runCli(home, ['wallet', 'remove', 'bob', '--yes']);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stderr).toContain('The Dust and shielded reader caches of wallet "bob" were left');
  }, 120_000);

  // Regression: a funded wallet's sealed seed was deleted without a word off a terminal.
  it('without --yes, off a terminal or with --json, is refused and removes nothing', async () => {
    for (const argv of [['wallet', 'remove', 'bob'], ['wallet', 'remove', 'bob', '--json']]) {
      const run = await runCli(home, argv, { env: PASSPHRASE });
      expect(run.status, run.stdout + run.stderr).toBe(2);
      expect(run.stdout + run.stderr).toContain('Add --yes to remove it without asking');
      expect(existsSync(join(root, 'wallets', 'bob.json'))).toBe(true);
    }
  }, 120_000);

  // Regression: removing a copy cleared the caches the original still reads.
  it('removing a copy of a wallet keeps the caches the original still needs', async () => {
    expect((await runCli(home, ['wallet', 'generate', 'bob-copy', '--seed', BOB_SEED, '--json'], { env: PASSPHRASE })).status).toBe(0);
    expect((await runCli(home, ['wallet', 'use', 'alice'], { env: PASSPHRASE })).status).toBe(0);
    const caches = bobsReaderCaches();
    const run = await runCli(home, ['wallet', 'remove', 'bob-copy', '--yes', '--json'], { env: PASSPHRASE });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toStrictEqual({ wallet: 'bob-copy', removed: true, readerCachesCleared: false, cachesKeptFor: ['bob'] });
    expect(caches.filter(existsSync)).toEqual(caches);
    // Once the last wallet of that seed goes, its caches go too.
    const last = await runCli(home, ['wallet', 'remove', 'bob', '--yes', '--json'], { env: PASSPHRASE });
    expect(JSON.parse(last.stdout)).toMatchObject({ readerCachesCleared: true, cachesKeptFor: [] });
    expect(caches.filter(existsSync)).toEqual([]);
  }, 120_000);

  it('with a wrong passphrase removes nothing', async () => {
    const run = await runCli(home, ['wallet', 'remove', 'bob', '--yes', '--json'], { env: { MN_PASSPHRASE: 'not the passphrase at all' } });
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'WRONG_PASSPHRASE' });
    expect(readFileSync(join(root, 'wallets', 'bob.json'), 'utf8')).toContain('sealed');
  }, 120_000);

  // At a terminal it asks, naming the file and the wallet's address on the network.
  describe('at a terminal', () => {
    const originalHome = process.env.HOME;
    const originalPassphrase = process.env.MN_PASSPHRASE;
    beforeEach(async () => {
      process.env.HOME = home;
      process.env.MN_PASSPHRASE = PASSPHRASE.MN_PASSPHRASE;
    });
    afterEach(async () => {
      process.env.HOME = originalHome;
      if (originalPassphrase === undefined) delete process.env.MN_PASSPHRASE;
      else process.env.MN_PASSPHRASE = originalPassphrase;
    });

    /** `wallet remove bob` run in-process at a terminal that answers `answer`; what it wrote. */
    async function removeAnswering(answer: string): Promise<{ written: string; error?: unknown }> {
      const input = new PassThrough();
      const prompted = new PassThrough();
      let written = '';
      prompted.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); if (written.includes('(y/N)')) input.write(`${answer}\n`); });
      const host = testHost({ prompter: createTerminalPrompter({ input, output: prompted, isTTY: true }) });
      const output = { result: () => {}, stdout: (text: string) => { written += text; }, stderr: (text: string) => { written += text; } };
      try {
        await runCommand(installedCommands.find('wallet')!, parseArgs(['wallet', 'remove', 'bob']), { host, output });
        return { written };
      } catch (error) {
        return { written, error };
      }
    }

    it('removes the wallet on a yes, after naming its file and its address', async () => {
      const { written, error } = await removeAnswering('y');
      expect(error).toBeUndefined();
      expect(written).toContain('Remove wallet "bob"?');
      expect(written).toContain(join(root, 'wallets', 'bob.json'));
      expect(written).toContain(`midnight balance ${rcKeys.unshieldedAddresses(Buffer.from(BOB_SEED, 'hex')).undeployed}`);
      expect(existsSync(join(root, 'wallets', 'bob.json'))).toBe(false);
    }, 120_000);

    it('keeps the wallet on anything but a yes, as CANCELLED', async () => {
      const { error } = await removeAnswering('n');
      expect(error).toMatchObject({ code: 'CANCELLED' });
      expect(existsSync(join(root, 'wallets', 'bob.json'))).toBe(true);
    }, 120_000);
  });
});
