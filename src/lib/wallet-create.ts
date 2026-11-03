// Creating a wallet: its secret (a new mnemonic, a given one, or a raw seed),
// the addresses derived from it on every network, and the sealed wallet file,
// which becomes the active wallet. `wallet generate` and `mn dev` both create
// wallets through here.

import * as path from 'path';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Engine } from '@kuiralabs/midnight-cli-core/lib/engine';
import { writeSealedWallet, setActiveWallet, type WalletPublic } from './wallet-config.ts';
import { isValidWalletName } from '@kuiralabs/midnight-cli-core/lib/constants';
import { getWalletsDir } from './wallet-paths.ts';

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

/** Where the wallet called `name` is kept under the state root `root`. */
export function walletFilePath(root: string, name: string): string {
  if (!isValidWalletName(name)) {
    throw new Error(
      `Invalid wallet name: "${name}"\nWallet name must be a simple name (no path separators, .json suffix, or special characters).`
    );
  }
  return path.join(getWalletsDir(root), `${name}.json`);
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
 * Writes the wallet `name` sealed under `passphrase` under the state root
 * `root` and makes it the active wallet; `engine` derives its addresses. An
 * existing wallet of that name is replaced only with `overwrite`.
 */
export async function createWallet(root: string, name: string, secret: WalletSecret, passphrase: string, engine: Engine, { overwrite = false }: { overwrite?: boolean } = {}): Promise<CreatedWallet> {
  const targetPath = walletFilePath(root, name);
  const { keys } = engine;
  const addresses = keys.unshieldedAddresses(secret.seed);
  const shieldedAddresses = keys.shieldedAddresses(secret.seed);
  const config: WalletPublic = { addresses, shieldedAddresses, createdAt: new Date().toISOString() };
  const seedHex = secret.seed.toString('hex');
  const secrets = secret.mnemonic ? { seed: seedHex, mnemonic: secret.mnemonic } : { seed: seedHex };

  const file = writeSealedWallet(targetPath, config, secrets, passphrase, { overwrite });
  setActiveWallet(root, name);

  const created: CreatedWallet = { name, addresses, shieldedAddresses, seed: secret.seed, file, createdAt: config.createdAt };
  if (secret.mnemonic) created.mnemonic = secret.mnemonic;
  return created;
}
