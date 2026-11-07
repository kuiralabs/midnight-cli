// The secrets a wallet keeps a contract's private state with, derived from the
// wallet's seed. Each is an HMAC-SHA256 of the seed under its own fixed label,
// so none can be computed from anything the wallet publishes (its addresses,
// its coin public key), none reveals the seed, and each is the same every time
// for one seed.

import { createHmac } from 'node:crypto';

/** What a contract script keeps a wallet's contract private state with. */
export interface ContractKeys {
  /** The default secret a contract's initial private state is seeded with: 32 bytes, hex. */
  readonly privateStateSecret: string;
  /** The password the private-state store is encrypted with; meets midnight-js's password policy. */
  readonly storagePassword: string;
  /** The account the private-state store keeps this wallet's entries under, apart from other wallets'. */
  readonly storageAccountId: string;
}

const PRIVATE_STATE_SECRET_LABEL = 'midnight-wallet-cli/contract/private-state-secret/v1';
const STORAGE_PASSWORD_LABEL = 'midnight-wallet-cli/contract/private-state-storage-password/v1';
const STORAGE_ACCOUNT_LABEL = 'midnight-wallet-cli/contract/private-state-storage-account/v1';

function keyed(seed: Uint8Array, label: string): string {
  return createHmac('sha256', seed).update(label, 'utf8').digest('hex');
}

/**
 * The password as midnight-js accepts it: its policy wants 3 character
 * classes, no character more than 3 times in a row and no run like `abcd`.
 * The hex digest goes in groups of 3 between dashes, after `Mn-` (upper,
 * lower, special): no run of 4 can cross a dash, and no group repeats a
 * character more than 3 times.
 */
function storagePasswordOf(digestHex: string): string {
  return 'Mn-' + (digestHex.match(/.{1,3}/g) ?? []).join('-');
}

/** The contract keys of the wallet whose seed is `seed`. */
export function contractKeysFromSeed(seed: Uint8Array): ContractKeys {
  if (seed.length === 0) throw new Error('A wallet seed is needed to derive its contract keys');
  return {
    privateStateSecret: keyed(seed, PRIVATE_STATE_SECRET_LABEL),
    storagePassword: storagePasswordOf(keyed(seed, STORAGE_PASSWORD_LABEL)),
    storageAccountId: 'mn-' + keyed(seed, STORAGE_ACCOUNT_LABEL).slice(0, 32),
  };
}
