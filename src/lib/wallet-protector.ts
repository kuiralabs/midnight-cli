// What `wallet protect` seals besides the wallets. Another domain that keeps
// secrets for a wallet (grant's accounts) provides a protector, and the
// caller passes it in the call context: wallet never imports that domain.

import type { CallContext } from './call-context.ts';
import { resolveWalletPath, unlockWallet } from './wallet-config.ts';

/** What protecting one item did: sealed now, already sealed, or why it could not be. */
export type ProtectedItem =
  | { subject: string; outcome: 'sealed-now'; sealedNote: string }
  | { subject: string; outcome: 'already-sealed' }
  | { subject: string; error: string };

export interface ProtectorResult {
  items: ProtectedItem[];
  /** What `--json` reports under the protector's name. */
  report: unknown;
}

export interface WalletProtector {
  /** Its key in `wallet protect --json`. */
  name: string;
  /**
   * Seals what it keeps under the state root `root` with `passphrase`. `coinKeyOf` gives the
   * shielded coin public key of a wallet, by name.
   */
  protect(root: string, passphrase: string, coinKeyOf: (wallet: string) => Promise<string>): Promise<ProtectorResult>;
}

/** The wallet command's call context: a command's, with the protectors `wallet protect` runs. */
export type WalletCommandContext = CallContext<WalletProtector>;

/** The shielded coin public key of the wallet `name`, unlocked with mn's passphrase. */
export async function coinKeyOfWallet(name: string): Promise<string> {
  // Loaded here, not up front: it brings in the ledger, which the other wallet subcommands don't need.
  const { shieldedCoinPublicKeyHexFromSeed } = await import('./shielded-direct-cache.ts');
  return shieldedCoinPublicKeyHexFromSeed(Buffer.from((await unlockWallet(resolveWalletPath(name))).seed, 'hex'));
}
