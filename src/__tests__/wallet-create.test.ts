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
import { deriveAllAddresses } from '../lib/derive-address.ts';
import { PASSPHRASE_ENV, passphraseForNewSecret } from '../lib/passphrase.ts';
import { stateRootIn } from './helpers/state-root-in.ts';

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
  PASSPHRASE = await passphraseForNewSecret(stateRootIn(home));
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env[PASSPHRASE_ENV];
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createWallet', () => {
  it('writes a sealed wallet that unlocks to its new mnemonic, and makes it active', async () => {
    const created = createWallet('alice', walletSecretFrom(), PASSPHRASE);

    expect(created.file).toBe(walletFilePath('alice'));
    expect(created.mnemonic!.split(' ')).toHaveLength(24);
    expect(fs.readFileSync(created.file, 'utf8')).not.toContain(created.seed.toString('hex'));
    const unlocked = await unlockWallet(created.file);
    expect(unlocked.seed).toBe(created.seed.toString('hex'));
    expect(unlocked.mnemonic).toBe(created.mnemonic);
    expect(getActiveWalletName()).toBe('alice');
  });

  it('derives its addresses from a given mnemonic', () => {
    const created = createWallet('bob', walletSecretFrom({ mnemonic: MNEMONIC }), PASSPHRASE);
    expect(created.addresses).toEqual(deriveAllAddresses(Buffer.from(mnemonicToSeedSync(MNEMONIC))));
  });

  it('keeps a given seed and no mnemonic', async () => {
    const seed = Buffer.alloc(32, 2);
    const created = createWallet('carol', walletSecretFrom({ seed }), PASSPHRASE);
    const unlocked = await unlockWallet(created.file);
    expect(unlocked.seed).toBe(seed.toString('hex'));
    expect(unlocked.mnemonic).toBeUndefined();
  });

  it('replaces an existing wallet only when asked', async () => {
    const first = createWallet('alice', walletSecretFrom({ seed: Buffer.alloc(32, 1) }), PASSPHRASE);
    expect(() => createWallet('alice', walletSecretFrom({ seed: Buffer.alloc(32, 2) }), PASSPHRASE)).toThrow(`Wallet file already exists: ${first.file}`);
    expect((await unlockWallet(first.file)).seed).toBe(Buffer.alloc(32, 1).toString('hex'));

    createWallet('alice', walletSecretFrom({ seed: Buffer.alloc(32, 2) }), PASSPHRASE, { overwrite: true });
    expect((await unlockWallet(first.file)).seed).toBe(Buffer.alloc(32, 2).toString('hex'));
  });

  it('refuses a name that is not a simple name, and an invalid mnemonic', () => {
    expect(() => walletFilePath('../alice')).toThrow('Invalid wallet name: "../alice"');
    expect(() => walletSecretFrom({ mnemonic: 'not a real mnemonic' })).toThrow('Invalid BIP-39 mnemonic');
  });
});
