// Creating a wallet: its secret (a new mnemonic, a given one, or a raw seed),
// the addresses derived from it on every network, and the sealed wallet file,
// which becomes the active wallet. `wallet generate` and `mn dev` both create
// wallets through here.

import * as path from 'path';
import { homedir } from 'os';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveAllAddresses, deriveAllShieldedAddresses } from './derive-address.ts';
import { writeSealedWallet, setActiveWallet, type WalletPublic } from './wallet-config.ts';
import { WALLETS_DIR_NAME, MIDNIGHT_DIR, isValidWalletName } from './constants.ts';

/** A wallet's secret: the seed, and the mnemonic it came from when there is one. */
export interface WalletSecret {
  seed: Buffer;
  mnemonic?: string;
}

export interface CreatedWallet {
  name: string;
  addresses: WalletPublic['addresses'];
  shieldedAddresses: NonNullable<WalletPublic['shieldedAddresses']>;
  seed: Buffer;
  mnemonic?: string;
  file: string;
  createdAt: string;
}

/** Where the wallet called `name` is kept. */
export function walletFilePath(name: string): string {
  if (!isValidWalletName(name)) {
    throw new Error(
      `Invalid wallet name: "${name}"\nWallet name must be a simple name (no path separators, .json suffix, or special characters).`
    );
  }
  return path.join(homedir(), MIDNIGHT_DIR, WALLETS_DIR_NAME, `${name}.json`);
}

/** The secret from a given seed, a given mnemonic (checked against the English wordlist), or else a new 24-word mnemonic. */
export function walletSecretFrom(given: { seed?: Buffer; mnemonic?: string } = {}): WalletSecret {
  if (given.seed !== undefined) return { seed: given.seed };
  if (given.mnemonic !== undefined) {
    if (!validateMnemonic(given.mnemonic, wordlist)) {
      throw new Error('Invalid BIP-39 mnemonic. Expected 12 or 24 words from the English wordlist.');
    }
    return { seed: Buffer.from(mnemonicToSeedSync(given.mnemonic)), mnemonic: given.mnemonic };
  }
  const mnemonic = generateMnemonic(wordlist, 256);
  return { seed: Buffer.from(mnemonicToSeedSync(mnemonic)), mnemonic };
}

/**
 * Writes the wallet `name` sealed under `passphrase` and makes it the active
 * wallet. An existing wallet of that name is replaced only with `overwrite`.
 */
export function createWallet(name: string, secret: WalletSecret, passphrase: string, { overwrite = false }: { overwrite?: boolean } = {}): CreatedWallet {
  const targetPath = walletFilePath(name);
  const addresses = deriveAllAddresses(secret.seed);
  const shieldedAddresses = deriveAllShieldedAddresses(secret.seed);
  const config: WalletPublic = { addresses, shieldedAddresses, createdAt: new Date().toISOString() };
  const seedHex = secret.seed.toString('hex');
  const secrets = secret.mnemonic ? { seed: seedHex, mnemonic: secret.mnemonic } : { seed: seedHex };

  const file = writeSealedWallet(targetPath, config, secrets, passphrase, { overwrite });
  setActiveWallet(name);

  const created: CreatedWallet = { name, addresses, shieldedAddresses, seed: secret.seed, file, createdAt: config.createdAt };
  if (secret.mnemonic) created.mnemonic = secret.mnemonic;
  return created;
}
