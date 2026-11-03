// Two hosts with different state roots in one process keep their state apart:
// each call's libraries are given its host's root, and nothing reads a
// process-wide one or the home directory. The config, the wallets, the open
// swap offers and the wallet caches each land under their own host's root.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost, type Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { parseArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { MIDNIGHT_DIR } from '@kuiralabs/midnight-cli-core/lib/constants';
import { loadCliConfig } from '@kuiralabs/midnight-cli-core/lib/cli-config';
import { sdkSetOf } from '@kuiralabs/midnight-cli-core/lib/engine';
import { openOffersFile, readOpenOffers, recordOpenOffer, type OpenOffer } from '@kuiralabs/midnight-cli-core/lib/open-offers';
import { cacheRootDir, getCachePath, networkCacheFolder } from '@kuiralabs/midnight-cli-core/lib/wallet-cache';
import configCommand from '@kuiralabs/midnight-cli-core/commands/config';
import { captureCommand } from '../lib/run-command.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { createWallet, walletSecretFrom } from '../lib/wallet-create.ts';
import { getActiveWalletName, listWallets } from '../lib/wallet-config.ts';
import { PASSPHRASE_ENV, passphraseForNewSecret } from '../lib/passphrase.ts';
import { clearChainCaches } from '../lib/chain-caches.ts';
import { loadInstalledEngine } from '../lib/installed-engines.ts';

const PASSPHRASE = 'correct horse battery staple';
const MAKER = 'mn_addr_undeployed1maker';
const OFFER: OpenOffer = {
  id: 'a1'.repeat(16),
  terms: { give: { token: '00'.repeat(31) + '01', amount: 10n }, want: { token: '00'.repeat(31) + '02', amount: 7n } },
  nullifiers: ['n1'],
  madeAt: new Date('2026-11-02T10:00:00.000Z'),
  expiresAt: new Date('2026-11-03T10:00:00.000Z'),
};

let base: string;
let originalHome: string | undefined;
let rootA: string;
let rootB: string;
let hostA: Host;
let hostB: Host;

/** A host whose state root is `<home>/.midnight`, a home of its own, and an engine of its own from the engines the CLI ships. */
function hostAt(home: string): Host {
  return createHost({ paths: { stateRoot: path.join(home, MIDNIGHT_DIR), home }, engineLoader: loadInstalledEngine });
}

/** A wallet created under `host`'s state root, sealed under the passphrase set there. */
async function walletIn(host: Host, name: string): Promise<void> {
  const root = host.paths().stateRoot;
  const passphrase = await passphraseForNewSecret(host, root, { env: { [PASSPHRASE_ENV]: PASSPHRASE } });
  await createWallet(root, name, walletSecretFrom({ seed: Buffer.alloc(32, name.length) }), passphrase, await host.engines.any());
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-host-paths-')));
  // The process's home is a third, empty folder: neither host's state may land there.
  originalHome = process.env.HOME;
  process.env.HOME = path.join(base, 'process-home');
  fs.mkdirSync(process.env.HOME);
  hostA = hostAt(path.join(base, 'a'));
  hostB = hostAt(path.join(base, 'b'));
  rootA = hostA.paths().stateRoot;
  rootB = hostB.paths().stateRoot;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('two hosts with different state roots', () => {
  it('each read and write their own config through the config command', async () => {
    await captureCommand(configCommand, parseArgs(['config', 'set', 'network', 'preview']), { host: hostA });
    await captureCommand(configCommand, parseArgs(['config', 'set', 'network', 'preprod']), { host: hostB });

    expect(await captureCommand(configCommand, parseArgs(['config', 'get', 'network']), { host: hostA })).toMatchObject({ value: 'preview' });
    expect(await captureCommand(configCommand, parseArgs(['config', 'get', 'network']), { host: hostB })).toMatchObject({ value: 'preprod' });
    expect(loadCliConfig(rootA).network).toBe('preview');
    expect(loadCliConfig(rootB).network).toBe('preprod');
    expect(fs.readdirSync(process.env.HOME!)).toEqual([]);
  });

  it('each create, list and activate their own wallets', async () => {
    await walletIn(hostA, 'alice');
    await walletIn(hostB, 'bob');

    expect((await listWallets(rootA, hostA.engines)).map((w) => w.name)).toEqual(['alice']);
    expect((await listWallets(rootB, hostB.engines)).map((w) => w.name)).toEqual(['bob']);
    expect(getActiveWalletName(rootA)).toBe('alice');
    expect(getActiveWalletName(rootB)).toBe('bob');
    // As the MCP server runs it.
    const { default: walletCommand } = await installedCommands.find('wallet')!.load();
    const listedA = await captureCommand(walletCommand, parseArgs(['wallet', 'list']), { host: hostA });
    const listedB = await captureCommand(walletCommand, parseArgs(['wallet', 'list']), { host: hostB });
    expect((listedA.wallets as { name: string }[]).map((w) => w.name)).toEqual(['alice']);
    expect((listedB.wallets as { name: string }[]).map((w) => w.name)).toEqual(['bob']);
    expect(fs.existsSync(path.join(rootA, 'wallets', 'alice.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootB, 'wallets', 'bob.json'))).toBe(true);
    expect(fs.readdirSync(process.env.HOME!)).toEqual([]);
  });

  it('each keep their own open swap offers', () => {
    recordOpenOffer(rootA, 'undeployed', MAKER, OFFER);

    expect(readOpenOffers(rootA, 'undeployed', MAKER)).toEqual([OFFER]);
    expect(readOpenOffers(rootB, 'undeployed', MAKER)).toEqual([]);
    expect(openOffersFile(rootA, 'undeployed', MAKER)).toBe(path.join(rootA, 'swap-offers', 'undeployed', `${MAKER}.json`));
    expect(fs.existsSync(path.join(rootB, 'swap-offers'))).toBe(false);
  });

  it('each keep their wallet caches in their own folder, named by their own config\'s SDK set', async () => {
    const address = 'mn_addr_undeployed1abcdefghijklmnopqrst';
    await captureCommand(configCommand, parseArgs(['config', 'set', 'sdk-set', 'beta', '--network', 'undeployed']), { host: hostA });

    expect(cacheRootDir(rootA)).toBe(path.join(rootA, 'cache'));
    expect(cacheRootDir(rootB)).toBe(path.join(rootB, 'cache'));
    expect(sdkSetOf('undeployed', rootA)).toBe('beta');
    expect(sdkSetOf('undeployed', rootB)).toBe('rc');
    expect(networkCacheFolder('undeployed', rootA)).toBe('undeployed.beta');
    expect(networkCacheFolder('undeployed', rootB)).toBe('undeployed');
    const cacheA = getCachePath(address, 'undeployed', rootA);
    const cacheB = getCachePath(address, 'undeployed', rootB);
    expect(cacheA).toBe(path.join(rootA, 'cache', 'undeployed.beta', 'mn_addr_undeployed1a.json'));
    expect(cacheB).toBe(path.join(rootB, 'cache', 'undeployed', 'mn_addr_undeployed1a.json'));

    // Clearing one host's caches leaves the other's.
    for (const file of [cacheA, cacheB]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
    }
    clearChainCaches('undeployed', rootB);
    expect(fs.existsSync(cacheA)).toBe(true);
    expect(fs.existsSync(cacheB)).toBe(false);
  });
});
