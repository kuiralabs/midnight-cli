// Each owner builds its paths under the state root the host gives,
// and the files land where they did before the state root, with the same contents: the
// fixture was recorded from the code before the change. A root outside the
// home gets the same layout and nothing is written to the home; with no root
// given, a library refuses instead of guessing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setHostPathsSource, stateRoot, NoStateRootError } from '../lib/state-root.ts';
import { setConfigValue } from '../lib/cli-config.ts';
import { bindCachesToIndexer } from '../lib/cache-indexer.ts';
import { passphraseForNewSecret, PASSPHRASE_ENV } from '../lib/passphrase.ts';
import { createWallet, walletSecretFrom } from '../lib/wallet-create.ts';
import { accountRecordsDir } from '../lib/grant/account-records.ts';
import { accountArtifactsDir } from '../lib/grant/account.ts';
import { getCachePath } from '../lib/wallet-cache.ts';
import { getDustCachePath } from '../lib/dust-direct-cache.ts';
import { getShieldedCachePath } from '../lib/shielded-direct-cache.ts';
import { getComposePath } from '../lib/localnet.ts';
import { MIDNIGHT_DIR } from '../lib/constants.ts';
import before from './fixtures/state-layout-before-1g.json';

const PASSPHRASE = 'fixture-passphrase-1g';
let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-state-root-')));
  process.env[PASSPHRASE_ENV] = PASSPHRASE;
});
afterEach(() => {
  delete process.env[PASSPHRASE_ENV];
  // Back to what the test harness gives, as the shell does.
  setHostPathsSource(() => ({ stateRoot: path.join(os.homedir(), MIDNIGHT_DIR), home: os.homedir() }));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The same steps the fixture was recorded with, through each owner. */
async function writeEveryOwnersFiles(): Promise<void> {
  setConfigValue('network', 'preview');
  setConfigValue('node', 'ws://localhost:29944', undefined, 'undeployed');
  bindCachesToIndexer('undeployed', 'ws://localhost:28088/api/v4/graphql/ws');
  createWallet('alice', walletSecretFrom({ seed: Buffer.alloc(32, 2) }), await passphraseForNewSecret());
  fs.mkdirSync(accountRecordsDir('undeployed', 'alice'), { recursive: true });
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
    setHostPathsSource(() => ({ stateRoot: path.join(home, MIDNIGHT_DIR), home }));
    await writeEveryOwnersFiles();
    const root = stateRoot();
    const rel = (p: string) => path.relative(home, p);
    const wallet = JSON.parse(fs.readFileSync(path.join(root, 'wallets/alice.json'), 'utf8'));

    expect([`${MIDNIGHT_DIR}/`, ...layout(root, home)].sort()).toEqual(before.files);
    expect(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).toBe(before.config);
    expect(fs.readFileSync(path.join(root, 'cache/undeployed/indexer.host'), 'utf8')).toBe(before.marker);
    expect(Object.keys(wallet)).toEqual(before.walletKeys);
    expect(wallet.addresses).toEqual(before.walletAddresses);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'keystore.json'), 'utf8')))).toEqual(before.keystoreKeys);
    expect({
      walletCache: rel(getCachePath('mn_addr_undeployed1abcdefghijklmnopqrst', 'undeployed')),
      dustCache: rel(getDustCachePath('undeployed', 'ab'.repeat(32))),
      shieldedCache: rel(getShieldedCachePath('undeployed', 'cd'.repeat(32))),
      compose: rel(getComposePath()),
      accountArtifacts: rel(accountArtifactsDir()),
    }).toEqual(before.paths);
  });

  it('keeps everything under a root outside the home, writing nothing to the home', async () => {
    const home = path.join(dir, 'home');
    const root = path.join(dir, 'elsewhere', 'state');
    fs.mkdirSync(home, { recursive: true });
    setHostPathsSource(() => ({ stateRoot: root, home }));
    await writeEveryOwnersFiles();

    expect(layout(root, root)).toEqual(before.files.filter((f) => f !== `${MIDNIGHT_DIR}/`).map((f) => f.slice(MIDNIGHT_DIR.length + 1)));
    expect(fs.readdirSync(home)).toEqual([]);
    expect(getComposePath()).toBe(path.join(root, 'localnet', 'compose.yml'));
  });

  it('refuses when the host gave no root, for each owner', () => {
    setHostPathsSource(null);
    expect(() => stateRoot()).toThrow(NoStateRootError);
    expect(() => setConfigValue('network', 'preview')).toThrow(NoStateRootError);
    expect(() => getCachePath('mn_addr_undeployed1abcdefghijklmnopqrst', 'undeployed')).toThrow(NoStateRootError);
    expect(() => getComposePath()).toThrow(NoStateRootError);
    expect(() => accountRecordsDir('undeployed', 'alice')).toThrow(NoStateRootError);
  });
});
