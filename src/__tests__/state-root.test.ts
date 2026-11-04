// Each owner builds its paths under the state root it is given, and the files
// land where they did before the state root, with the same contents: the
// fixture was recorded from the code before the change. A root outside the
// home gets the same layout and nothing is written to the home; a host that
// gave no root refuses instead of guessing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NoStateRootError, createHost, parseArgs, setConfigValue, MIDNIGHT_DIR, PASSPHRASE_ENV } from '@kuiralabs/midnight-cli-core';
import { bindCachesToIndexer, getCachePath, getDustCachePath, getShieldedCachePath } from '@kuiralabs/midnight-cli-core/engine';
import { testHost } from '../../test-support/test-host.ts';
import { configDefinition } from '@kuiralabs/midnight-cli-core/commands';
import { cliCall } from './helpers/cli-call.ts';
import { passphraseForNewSecret, createWallet, walletSecretFrom } from '@kuiralabs/midnight-wallet';
import { accountArtifactsDir, accountRecordsDir } from '@kuiralabs/midnight-grant';
import { getComposePath } from '@kuiralabs/midnight-dev';
import before from './fixtures/state-layout-before-1g.json';

// The config handler, as the shell loads it.
const { default: configCommand } = await configDefinition.load();

const PASSPHRASE = 'fixture-passphrase-1g';
let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-state-root-')));
  process.env[PASSPHRASE_ENV] = PASSPHRASE;
});
afterEach(() => {
  delete process.env[PASSPHRASE_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The same steps the fixture was recorded with, through each owner, under the state root `root`. */
async function writeEveryOwnersFiles(root: string): Promise<void> {
  setConfigValue('network', 'preview', root);
  setConfigValue('node', 'ws://localhost:29944', root, 'undeployed');
  bindCachesToIndexer('undeployed', 'ws://localhost:28088/api/v4/graphql/ws', root);
  const host = testHost();
  await createWallet(root, 'alice', walletSecretFrom({ seed: Buffer.alloc(32, 2) }), await passphraseForNewSecret(host, root), await host.engines.any());
  fs.mkdirSync(accountRecordsDir('undeployed', 'alice', root), { recursive: true });
}

/** Every file and folder under `root`, relative to `base`, folders ending in /. */
function layout(root: string, base: string): string[] {
  return (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .map((e) => path.relative(base, path.join(e.parentPath, e.name)) + (e.isDirectory() ? '/' : ''))
    .sort();
}

describe('the state root the host gives', () => {
  it('lays out every owner\'s files as before the state root, with the same contents', async () => {
    const home = path.join(dir, 'home');
    const root = path.join(home, MIDNIGHT_DIR);
    await writeEveryOwnersFiles(root);
    const rel = (p: string) => path.relative(home, p);
    const wallet = JSON.parse(fs.readFileSync(path.join(root, 'wallets/alice.json'), 'utf8'));

    expect([`${MIDNIGHT_DIR}/`, ...layout(root, home)].sort()).toEqual(before.files);
    expect(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).toBe(before.config);
    expect(fs.readFileSync(path.join(root, 'cache/undeployed/indexer.host'), 'utf8')).toBe(before.marker);
    expect(Object.keys(wallet)).toEqual(before.walletKeys);
    // Every address the layout had, and stagenet's, which a new wallet has had since mn added stagenet.
    const { stagenet, ...recorded } = wallet.addresses;
    expect(recorded).toEqual(before.walletAddresses);
    expect(stagenet).toMatch(/^mn_addr_stagenet1/);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'keystore.json'), 'utf8')))).toEqual(before.keystoreKeys);
    expect({
      walletCache: rel(getCachePath('mn_addr_undeployed1abcdefghijklmnopqrst', 'undeployed', root)),
      dustCache: rel(getDustCachePath('undeployed', 'ab'.repeat(32), root)),
      shieldedCache: rel(getShieldedCachePath('undeployed', 'cd'.repeat(32), root)),
      compose: rel(getComposePath(root)),
      accountArtifacts: rel(accountArtifactsDir(root)),
    }).toEqual(before.paths);
  });

  it('keeps everything under a root outside the home, writing nothing to the home', async () => {
    const home = path.join(dir, 'home');
    const root = path.join(dir, 'elsewhere', 'state');
    fs.mkdirSync(home, { recursive: true });
    await writeEveryOwnersFiles(root);

    expect(layout(root, root)).toEqual(before.files.filter((f) => f !== `${MIDNIGHT_DIR}/`).map((f) => f.slice(MIDNIGHT_DIR.length + 1)));
    expect(fs.readdirSync(home)).toEqual([]);
    expect(getComposePath(root)).toBe(path.join(root, 'localnet', 'compose.yml'));
  });

  it('refuses when the host gave no root, before a command runs', async () => {
    const host = createHost();
    expect(() => host.paths()).toThrow(NoStateRootError);
    await expect((async () => cliCall(configCommand, parseArgs(['config', 'set', 'network', 'preview']), { host }))()).rejects.toThrow(NoStateRootError);
  });
});
