// Dev wallet provisioning for `mn dev`.
// Creates a fixed set of named wallets on localnet, funds them from genesis,
// and registers them for dust. Idempotent — wallets that already exist are
// left untouched (the user can `mn wallet remove <name>` to force re-setup).

import { existsSync } from 'node:fs';
import { getActiveWalletName, loadWalletConfig, resolveWalletPath, setActiveWallet, unlockWallet } from '../wallet-config.ts';
import { createWallet, walletFilePath, walletSecretFrom } from '../wallet-create.ts';
import { passphraseForNewSecret } from '../passphrase.ts';
import { engineFor } from '../engine.ts';
import { checkBalance } from '../balance-subscription.ts';
import { resolveNetwork } from '../resolve-network.ts';
import type { NetworkConfig } from '../network.ts';
import type { CallSdkWarnings } from '../sdk-warnings.ts';
import { throwIfCancelled } from '../errors.ts';

/** Default dev wallet names — one per common test persona. */
export const DEFAULT_DEV_WALLET_NAMES = ['dev-alice', 'dev-bob', 'dev-carol'] as const;

/** Default NIGHT amount to airdrop to each dev wallet. */
export const DEFAULT_DEV_AIRDROP_AMOUNT = 1000;

export type WalletProvisionState = 'reused' | 'created';

export interface ProvisionedWallet {
  name: string;
  state: WalletProvisionState;
}

/** The steps of setting up a wallet; the defaults are the wallet functions mn's own commands use. */
export interface ProvisionSteps {
  generate: (name: string, signal?: AbortSignal) => Promise<void>;
  airdrop: (name: string, amountNight: number, signal?: AbortSignal) => Promise<void>;
  registerDust: (name: string, signal?: AbortSignal) => Promise<void>;
  /** Whether an existing wallet still has no NIGHT registered for Dust (a setup interrupted after funding). */
  needsDust: (name: string, signal?: AbortSignal) => Promise<boolean>;
}

interface ProvisionRun {
  names: readonly string[];
  amountNight: number;
  onProgress?: (wallet: string, phase: 'creating' | 'funding' | 'dust' | 'done', state: WalletProvisionState) => void;
  signal?: AbortSignal;
}

/** The steps to run; without them, the wallet functions, whose SDK runs keep their warnings to the provisioning call's `sdkWarnings`. */
export type ProvisionOptions = ProvisionRun & ({ steps: ProvisionSteps } | { sdkWarnings: CallSdkWarnings });

/** The steps through the wallet functions, on `network` (resolved once, for every wallet). */
function walletSteps(network: NetworkConfig, sdkWarnings: CallSdkWarnings): ProvisionSteps {
  return {
    generate: generateWallet,
    airdrop: (name, amountNight, signal) => airdropToWallet(network, name, amountNight, signal, sdkWarnings),
    registerDust: (name, signal) => registerWalletDust(network, name, signal, sdkWarnings),
    needsDust: (name, signal) => walletNeedsDust(network, name, signal),
  };
}

/**
 * Ensure each wallet exists, is funded from genesis, and is dust-registered.
 * Only runs create → airdrop → dust for brand-new wallets; reuses existing ones as-is.
 * Always targets the `undeployed` network — airdrop is localnet-only.
 *
 * Every new wallet is funded before any registers: a ledger-9 registration
 * waits for its NIGHT to generate the fee (about a minute for 1000 NIGHT),
 * and generation starts at the airdrop, so the later wallets' waits run
 * while the earlier ones register instead of one after another.
 */
export async function provisionDevWallets(opts: ProvisionOptions): Promise<ProvisionedWallet[]> {
  const steps = 'steps' in opts ? opts.steps : walletSteps(undeployedNetwork(), opts.sdkWarnings);
  const results: ProvisionedWallet[] = [];
  const created: string[] = [];

  // `wallet generate` sets the new wallet as active — remember the user's
  // current active wallet so we can restore it after provisioning.
  const previousActive = safeGetActiveWallet();

  try {
    for (const name of opts.names) {
      throwIfCancelled(opts.signal);

      if (walletExists(name)) {
        // Funded but never registered (setup stopped between funding and
        // registering): finish it below rather than reuse it as is.
        if (await steps.needsDust(name, opts.signal)) {
          created.push(name);
          continue;
        }
        opts.onProgress?.(name, 'done', 'reused');
        results.push({ name, state: 'reused' });
        continue;
      }

      opts.onProgress?.(name, 'creating', 'created');
      await steps.generate(name, opts.signal);

      opts.onProgress?.(name, 'funding', 'created');
      await steps.airdrop(name, opts.amountNight, opts.signal);
      created.push(name);
    }

    for (const name of created) {
      throwIfCancelled(opts.signal);
      opts.onProgress?.(name, 'dust', 'created');
      await steps.registerDust(name, opts.signal);

      opts.onProgress?.(name, 'done', 'created');
      results.push({ name, state: 'created' });
    }
  } finally {
    restoreActiveWallet(previousActive);
  }

  return opts.names.flatMap((name) => results.filter((r) => r.name === name));
}

function safeGetActiveWallet(): string | null {
  try {
    return getActiveWalletName();
  } catch {
    return null;
  }
}

function restoreActiveWallet(name: string | null): void {
  if (!name) return;
  if (!walletExists(name)) return;
  try {
    setActiveWallet(name);
  } catch { /* best-effort */ }
}

// ── Internals ────────────────────────────────────────────────

function walletExists(name: string): boolean {
  return existsSync(walletFilePath(name));
}

/** The local network, with any endpoints saved for it, as the wallet commands resolve it. */
function undeployedNetwork(): NetworkConfig {
  return resolveNetwork({
    args: { command: 'dev', subcommand: undefined, positionals: [], flags: { network: 'undeployed' } },
  }).config;
}

async function generateWallet(name: string, signal?: AbortSignal): Promise<void> {
  const passphrase = await passphraseForNewSecret();
  // Cancelled while the passphrase was asked for: no wallet is written.
  throwIfCancelled(signal);
  await createWallet(name, walletSecretFrom(), passphrase);
}

async function airdropToWallet(network: NetworkConfig, name: string, amountNight: number, signal: AbortSignal | undefined, sdkWarnings: CallSdkWarnings): Promise<void> {
  const recipientAddress = (await loadWalletConfig(resolveWalletPath(name))).addresses.undeployed;
  // dev's wallets live on the local chain.
  await (await engineFor('undeployed')).wallet.airdrop({ networkConfig: network, recipientAddress, amountNight, signal, sdkWarnings });
}

async function walletNeedsDust(network: NetworkConfig, name: string, signal: AbortSignal | undefined): Promise<boolean> {
  const address = (await loadWalletConfig(resolveWalletPath(name))).addresses.undeployed;
  const { registeredUtxos, unregisteredUtxos } = await checkBalance(address, network.indexerWS, undefined, signal);
  return registeredUtxos === 0 && unregisteredUtxos > 0;
}

async function registerWalletDust(network: NetworkConfig, name: string, signal: AbortSignal | undefined, sdkWarnings: CallSdkWarnings): Promise<void> {
  const { seed } = await unlockWallet(resolveWalletPath(name));
  await (await engineFor('undeployed')).wallet.registerDust(Buffer.from(seed, 'hex'), network, { signal, sdkWarnings });
}
