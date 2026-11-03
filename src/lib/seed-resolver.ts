// One shared wallet-seed resolver for the commands that operate on a seed
// (`address`, `balance`, `dust export`). They used to each parse `--seed` /
// `MN_SEED` / `--wallet` separately, which is how `balance` drifted and never
// learned `MN_SEED`. Centralizing it keeps the precedence identical everywhere.

import { getFlag, type ParsedArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';
import type { Settings } from '@kuiralabs/midnight-cli-core/lib/settings';
import { resolveWalletPath, unlockWallet, type UnlockHost, type WalletConfig } from './wallet-config.ts';

export interface ResolvedSeed {
  /** The wallet seed: 32-byte raw, or 64-byte BIP-39 (mnemonic-derived). */
  seed: Buffer;
  /** The wallet file the seed came from, or null when supplied via `--seed` / `MN_SEED`. */
  walletPath: string | null;
  /** The loaded wallet config, or null for a `--seed` / `MN_SEED` source (no file). */
  config: WalletConfig | null;
}

export interface ResolveSeedOptions {
  /**
   * Disable the active-wallet fallback and error clearly when no source is given.
   * Used by `address` (a seed-derivation tool with no notion of a "current" wallet).
   */
  requireExplicit?: boolean;
  /** Command name for the `requireExplicit` error (e.g. `address needs a seed source`). */
  label?: string;
}

/**
 * Parse a hex seed. Accepts the two seed sizes that actually occur:
 *   - 64 hex chars — a 32-byte raw seed
 *   - 128 hex chars — a 64-byte BIP-39 seed (mnemonicToSeedSync output), so a
 *     wallet derived elsewhere from a mnemonic can be cross-checked here
 * HD derivation (SLIP-10) technically takes 128–512 bits, but gating to the
 * two real sizes means a typo can't silently derive a different wallet.
 */
export function parseSeedHex(input: string, label: string): Buffer {
  // Trim first — a seed from a file / command substitution (MN_SEED=$(cat seed.hex))
  // carries a trailing newline that would fail the length check.
  const hex = input.trim().replace(/^0x/, '');
  if ((hex.length !== 64 && hex.length !== 128) || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new UsageError(
      `${label} must be 64 or 128 hex characters (a 32-byte seed, or a 64-byte BIP-39 seed)`
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * The wallet a library function acts for: a wallet by name or path (absent:
 * the active one), unlocked through the host's passphrase and prompter; or a
 * seed the program holds (32 bytes raw, or 64 from a BIP-39 mnemonic).
 */
export type WalletSource = { wallet?: string } | { seed: Uint8Array };

/** What a wallet is opened through: unlocked through the host, under its state root. */
export type SeedHost = UnlockHost & Pick<Host, 'paths'>;

/**
 * The seed of the wallet `source` names, with its wallet file and config
 * (both null for a seed the program holds). A wallet is one under the host's
 * state root, unlocked through its passphrase and prompter.
 */
export function seedOf(host: SeedHost, source: WalletSource): Promise<ResolvedSeed> {
  return seedUnder(host.paths().stateRoot, host, source);
}

/**
 * Where a command's arguments say its seed comes from, with uniform precedence:
 *   `--seed <hex>` → `MN_SEED` (env, kept off the process list) → `--wallet <name>` → active wallet.
 * MN_SEED is the one in `settings`.
 */
export function walletSourceOf(args: ParsedArgs, settings: Pick<Settings, 'seed'>, opts: ResolveSeedOptions = {}): WalletSource {
  const seedFlag = getFlag(args, 'seed');
  const seedSource = seedFlag ?? settings.seed;
  if (seedSource) return { seed: parseSeedHex(seedSource, seedFlag ? '--seed' : 'MN_SEED') };

  const walletName = getFlag(args, 'wallet');
  if (walletName === undefined && opts.requireExplicit) {
    throw new UsageError(
      `${opts.label ?? 'This command'} needs a seed source. Provide one of:\n` +
      '  --seed <hex>     seed as 64 hex chars (32-byte) or 128 (64-byte BIP-39)\n' +
      '  MN_SEED=<hex>    same seed via env (kept off the process list)\n' +
      '  --wallet <name>  derive from a saved wallet',
    );
  }
  return walletName === undefined ? {} : { wallet: walletName };
}

/**
 * Resolve a wallet seed from a command's arguments (walletSourceOf's precedence).
 * Returns the seed plus the backing wallet file/config (both null for a `--seed` / `MN_SEED`
 * source), so a caller that caches to the wallet file can skip that when there is none.
 * Wallets are the ones under the state root `root`; MN_SEED is the one in `host`'s settings.
 */
export async function resolveSeedSource(args: ParsedArgs, root: string, host: UnlockHost, opts: ResolveSeedOptions = {}): Promise<ResolvedSeed> {
  return seedUnder(root, host, walletSourceOf(args, host.settings(), opts));
}

/** Just the seed — for commands that don't touch the wallet file. */
export async function resolveSeed(args: ParsedArgs, root: string, host: UnlockHost, opts?: ResolveSeedOptions): Promise<Buffer> {
  return (await resolveSeedSource(args, root, host, opts)).seed;
}

async function seedUnder(root: string, host: UnlockHost, source: WalletSource): Promise<ResolvedSeed> {
  if ('seed' in source) {
    // The two sizes a seed comes in, as parseSeedHex accepts them: any other is a mistake, never a different wallet.
    if (source.seed.length !== 32 && source.seed.length !== 64) {
      throw new UsageError(`A seed must be 32 or 64 bytes (a raw seed, or a BIP-39 seed); this one is ${source.seed.length}`);
    }
    return { seed: Buffer.from(source.seed), walletPath: null, config: null };
  }
  const walletPath = resolveWalletPath(root, source.wallet);
  const { seed, mnemonic: _mnemonic, ...config } = await unlockWallet(walletPath, { root, host });
  return { seed: Buffer.from(seed, 'hex'), walletPath, config };
}
