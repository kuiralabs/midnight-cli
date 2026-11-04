// Dev wallet provisioning for `mn dev`.
// Creates a fixed set of named wallets on localnet, funds them from genesis,
// and registers them for dust. Idempotent — wallets that already exist are
// left untouched (the user can `mn wallet remove <name>` to force re-setup).

import { existsSync } from 'node:fs';
import { getActiveWalletName, loadWalletConfig, resolveWalletPath, setActiveWallet, unlockWallet, type UnlockHost, createWallet, walletFilePath, walletSecretFrom, passphraseForNewSecret } from '@kuiralabs/midnight-wallet';
import { sdkSetOf, resolveNetwork, type NetworkSettings, type NetworkConfig, type CallSdkWarnings, throwIfCancelled, nightToMicro } from '@kuiralabs/midnight-cli-core';
import { checkBalance } from '@kuiralabs/midnight-chain';

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
  /** The state root the wallets and config live under. */
  root: string;
  names: readonly string[];
  amountNight: number;
  onProgress?: (wallet: string, phase: 'creating' | 'funding' | 'dust' | 'done', state: WalletProvisionState) => void;
  signal?: AbortSignal;
}

/** The steps to run; without them, the wallet functions, run in `host`, whose SDK runs keep their warnings to the provisioning call's `sdkWarnings`. */
export type ProvisionOptions = ProvisionRun & ({ steps: ProvisionSteps } | { sdkWarnings: CallSdkWarnings; host: UnlockHost });

/** The steps through the wallet functions, on `network` (resolved once, for every wallet). */
function walletSteps(root: string, host: UnlockHost, network: NetworkConfig, sdkWarnings: CallSdkWarnings): ProvisionSteps {
  return {
    generate: (name, signal) => generateWallet(root, host, name, signal),
    airdrop: (name, amountNight, signal) => airdropToWallet(root, host, network, name, amountNight, signal, sdkWarnings),
    registerDust: (name, signal) => registerWalletDust(root, host, network, name, signal, sdkWarnings),
    needsDust: (name, signal) => walletNeedsDust(root, host, network, name, signal),
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
  const { root } = opts;
  const steps = 'steps' in opts ? opts.steps : walletSteps(root, opts.host, undeployedNetwork(root, opts.host.settings()), opts.sdkWarnings);
  const results: ProvisionedWallet[] = [];
  const created: string[] = [];

  // `wallet generate` sets the new wallet as active — remember the user's
  // current active wallet so we can restore it after provisioning.
  const previousActive = safeGetActiveWallet(root);

  try {
    for (const name of opts.names) {
      throwIfCancelled(opts.signal);

      if (walletExists(root, name)) {
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
    restoreActiveWallet(root, previousActive);
  }

  return opts.names.flatMap((name) => results.filter((r) => r.name === name));
}

function safeGetActiveWallet(root: string): string | null {
  try {
    return getActiveWalletName(root);
  } catch {
    return null;
  }
}

function restoreActiveWallet(root: string, name: string | null): void {
  if (!name) return;
  if (!walletExists(root, name)) return;
  try {
    setActiveWallet(root, name);
  } catch { /* best-effort */ }
}

// ── Internals ────────────────────────────────────────────────

function walletExists(root: string, name: string): boolean {
  return existsSync(walletFilePath(root, name));
}

/** The local network, with any endpoints saved for it, as the wallet commands resolve it with the host's settings. */
function undeployedNetwork(root: string, settings: NetworkSettings): NetworkConfig {
  return resolveNetwork({
    args: { command: 'dev', subcommand: undefined, positionals: [], flags: { network: 'undeployed' } },
    configDir: root,
  }, settings).config;
}

async function generateWallet(root: string, host: UnlockHost, name: string, signal?: AbortSignal): Promise<void> {
  const passphrase = await passphraseForNewSecret(host, root);
  // Cancelled while the passphrase was asked for: no wallet is written.
  throwIfCancelled(signal);
  await createWallet(root, name, walletSecretFrom(), passphrase, await host.engines.any());
}

async function airdropToWallet(root: string, host: UnlockHost, network: NetworkConfig, name: string, amountNight: number, signal: AbortSignal | undefined, sdkWarnings: CallSdkWarnings): Promise<void> {
  const recipientAddress = (await loadWalletConfig(resolveWalletPath(root, name), host.engines)).addresses.undeployed;
  // dev's wallets live on the local chain.
  await (await host.engines.load(sdkSetOf('undeployed', root))).wallet.airdrop({ networkConfig: network, recipientAddress, amount: nightToMicro(amountNight), signal, sdkWarnings, root, notice: host.notice });
}

async function walletNeedsDust(root: string, host: UnlockHost, network: NetworkConfig, name: string, signal: AbortSignal | undefined): Promise<boolean> {
  const address = (await loadWalletConfig(resolveWalletPath(root, name), host.engines)).addresses.undeployed;
  const { registeredUtxos, unregisteredUtxos } = await checkBalance(address, network.indexerWS, undefined, signal);
  return registeredUtxos === 0 && unregisteredUtxos > 0;
}

async function registerWalletDust(root: string, host: UnlockHost, network: NetworkConfig, name: string, signal: AbortSignal | undefined, sdkWarnings: CallSdkWarnings): Promise<void> {
  const { seed } = await unlockWallet(resolveWalletPath(root, name), { root, host });
  await (await host.engines.load(sdkSetOf('undeployed', root))).wallet.registerDust(Buffer.from(seed, 'hex'), network, { signal, sdkWarnings, root, notice: host.notice });
}
