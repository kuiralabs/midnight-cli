// Where an account's records live: one directory per network and wallet under
// ~/.midnight/accounts/, never in the account build's own directory. The build
// writes them there (the owner's keys, the roster of grants, its private-state
// stores); mn only names the place.

import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DIR_MODE } from '@kuiralabs/midnight-cli-core/lib/constants';

/** The directory under ~/.midnight that holds each network's accounts. */
export const ACCOUNTS_DIR_NAME = 'accounts';

/**
 * The name an account is kept under for a wallet: the wallet's name, or for a
 * wallet given as a file, the file's name without `.json`. The active wallet
 * when none is given.
 */
export function accountWalletName(walletFlag: string | undefined, activeWallet: () => string): string {
  if (walletFlag === undefined) return activeWallet();
  return basename(walletFlag).replace(/\.json$/, '');
}

export function accountRecordsDir(network: string, walletName: string, root: string): string {
  return join(root, ACCOUNTS_DIR_NAME, network, walletName);
}

/** Creates the records directory, readable by its owner only: it will hold keys. */
export function ensureAccountRecordsDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}
