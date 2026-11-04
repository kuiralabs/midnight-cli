// Creating a wallet, as `wallet generate` and `mn dev` both do: the sealed
// file unlocks to the secret it was given, the new wallet becomes the active
// one, and an existing wallet is only replaced when asked. HOME is a
// temporary directory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mnemonicToSeedSync } from '@scure/bip39';
import { createWallet, walletFilePath, walletSecretFrom } from '../lib/wallet-create.ts';
import { getActiveWalletName, unlockWallet } from '../lib/wallet-config.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { PASSPHRASE_ENV, passphraseForNewSecret } from '../lib/passphrase.ts';
import { stateRootIn } from './helpers/state-root-in.ts';
import { testHost } from '../../test-support/test-host.ts';

// The host the tests' calls run in (test-host.ts): settings from the test's environment, nobody to ask, notices dropped, and an engine of its own from the engines the CLI ships.
const host = testHost();

const CHOSEN = 'correct horse battery staple';
// The passphrase as a caller gets it: the first secret in a new home sets it.
let PASSPHRASE: string;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-wallet-create-'));
  process.env.HOME = home;
  process.env[PASSPHRASE_ENV] = CHOSEN;
  PASSPHRASE = await passphraseForNewSecret(host, stateRootIn(home));
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env[PASSPHRASE_ENV];
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createWallet', () => {
  it('writes a sealed wallet that unlocks to its new mnemonic, and makes it active', async () => {
    const created = await createWallet(stateRootIn(home), 'alice', walletSecretFrom(), PASSPHRASE, await host.engines.any());

    expect(created.file).toBe(walletFilePath(stateRootIn(home), 'alice'));
    expect(created.mnemonic!.split(' ')).toHaveLength(24);
    expect(fs.readFileSync(created.file, 'utf8')).not.toContain(created.seed.toString('hex'));
    const unlocked = await unlockWallet(created.file, { root: stateRootIn(home) , host});
    expect(unlocked.seed).toBe(created.seed.toString('hex'));
    expect(unlocked.mnemonic).toBe(created.mnemonic);
    expect(getActiveWalletName(stateRootIn(home))).toBe('alice');
  });

  it('derives its addresses from a given mnemonic', async () => {
    const created = await createWallet(stateRootIn(home), 'bob', walletSecretFrom({ mnemonic: MNEMONIC }), PASSPHRASE, await host.engines.any());
    expect(created.addresses).toEqual(rcKeys.unshieldedAddresses(Buffer.from(mnemonicToSeedSync(MNEMONIC))));
  });

  it('keeps a given seed and no mnemonic', async () => {
    const seed = Buffer.alloc(32, 2);
    const created = await createWallet(stateRootIn(home), 'carol', walletSecretFrom({ seed }), PASSPHRASE, await host.engines.any());
    const unlocked = await unlockWallet(created.file, { root: stateRootIn(home) , host});
    expect(unlocked.seed).toBe(seed.toString('hex'));
    expect(unlocked.mnemonic).toBeUndefined();
  });

  it('replaces an existing wallet only when asked', async () => {
    const first = await createWallet(stateRootIn(home), 'alice', walletSecretFrom({ seed: Buffer.alloc(32, 1) }), PASSPHRASE, await host.engines.any());
    await expect(createWallet(stateRootIn(home), 'alice', walletSecretFrom({ seed: Buffer.alloc(32, 2) }), PASSPHRASE, await host.engines.any())).rejects.toThrow(`Wallet file already exists: ${first.file}`);
    expect((await unlockWallet(first.file, { root: stateRootIn(home) , host})).seed).toBe(Buffer.alloc(32, 1).toString('hex'));

    await createWallet(stateRootIn(home), 'alice', walletSecretFrom({ seed: Buffer.alloc(32, 2) }), PASSPHRASE, await host.engines.any(), { overwrite: true });
    expect((await unlockWallet(first.file, { root: stateRootIn(home) , host})).seed).toBe(Buffer.alloc(32, 2).toString('hex'));
  });

  it('refuses a name that is not a simple name, and an invalid mnemonic', () => {
    expect(() => walletFilePath(stateRootIn(home), '../alice')).toThrow('Invalid wallet name: "../alice"');
    expect(() => walletSecretFrom({ mnemonic: 'not a real mnemonic' })).toThrow('Invalid BIP-39 mnemonic');
  });
});
