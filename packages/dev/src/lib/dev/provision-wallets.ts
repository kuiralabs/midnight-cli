// Dev wallet provisioning for `mn dev`.
// Creates a fixed set of named wallets on localnet, funds them from genesis,
// and registers them for dust. Idempotent — a wallet that already exists is
// reused, topped up from genesis when it holds less than the amount new ones
// get (the user can `mn wallet remove <name>` to force re-setup).

import { existsSync } from 'node:fs';
import { getActiveWalletName, loadWalletConfig, resolveWalletPath, setActiveWallet, unlockWallet, type UnlockHost, createWallet, walletFilePath, walletSecretFrom, passphraseForNewSecret } from '@kuiralabs/midnight-wallet';
import { sdkSetOf, resolveNetwork, type NetworkSettings, type NetworkConfig, type CallSdkWarnings, throwIfCancelled, nightAmountText, nightToMicro, LOCAL_WALLET_FUNDING_NIGHT, NATIVE_TOKEN_TYPE } from '@kuiralabs/midnight-cli-core';
import { checkBalance } from '@kuiralabs/midnight-chain';
import { topUpShortfall } from './top-up.ts';

/** Default dev wallet names — one per common test persona. */
export const DEFAULT_DEV_WALLET_NAMES = ['dev-alice', 'dev-bob', 'dev-carol'] as const;

/** NIGHT airdropped to each new dev wallet: enough that its first transactions don't wait for Dust (the arithmetic is at LOCAL_WALLET_FUNDING_NIGHT). */
export const DEFAULT_DEV_AIRDROP_AMOUNT = LOCAL_WALLET_FUNDING_NIGHT;

export type WalletProvisionState = 'reused' | 'created';

export interface ProvisionedWallet {
  name: string;
  state: WalletProvisionState;
  /** Micro-NIGHT airdropped to an existing wallet to bring it up to the run's amount; absent when none was. */
  toppedUp?: bigint;
  /** An existing wallet registered for Dust by this run (its setup had stopped after funding). */
  registered?: true;
}

/** One wallet's line in mn dev's summary: `dev-bob: reused, topped up 49000 NIGHT, registered`. */
export function provisionedWalletText({ name, state, toppedUp, registered }: ProvisionedWallet): string {
  const done = [
    state,
    ...(toppedUp !== undefined ? [`topped up ${nightAmountText(toppedUp)} NIGHT`] : []),
    ...(registered === true ? ['registered'] : []),
  ];
  return `${name}: ${done.join(', ')}`;
}

/** What provisioning reads of an existing wallet on the local chain. */
export interface ExistingWallet {
  /** It still has no NIGHT registered for Dust (a setup interrupted after funding). */
  needsDust: boolean;
  /** Its unshielded NIGHT, in micro-NIGHT. */
  night: bigint;
}

/** The steps of setting up a wallet; the defaults are the wallet functions mn's own commands use. */
export interface ProvisionSteps {
  generate: (name: string, signal?: AbortSignal) => Promise<void>;
  /** Airdrops `amount` micro-NIGHT from genesis. */
  airdrop: (name: string, amount: bigint, signal?: AbortSignal) => Promise<void>;
  registerDust: (name: string, signal?: AbortSignal) => Promise<void>;
  inspect: (name: string, signal?: AbortSignal) => Promise<ExistingWallet>;
}

interface ProvisionRun {
  /** The state root the wallets and config live under. */
  root: string;
  names: readonly string[];
  amountNight: number;
  onProgress?: (wallet: string, phase: 'creating' | 'funding' | 'topping-up' | 'dust' | 'done', state: WalletProvisionState) => void;
  signal?: AbortSignal;
}

/** The steps to run; without them, the wallet functions, run in `host`, whose SDK runs keep their warnings to the provisioning call's `sdkWarnings`. */
export type ProvisionOptions = ProvisionRun & ({ steps: ProvisionSteps } | { sdkWarnings: CallSdkWarnings; host: UnlockHost });

/** The steps through the wallet functions, on `network` (resolved once, for every wallet). */
function walletSteps(root: string, host: UnlockHost, network: NetworkConfig, sdkWarnings: CallSdkWarnings): ProvisionSteps {
  return {
    generate: (name, signal) => generateWallet(root, host, name, signal),
    airdrop: (name, amount, signal) => airdropToWallet(root, host, network, name, amount, signal, sdkWarnings),
    registerDust: (name, signal) => registerWalletDust(root, host, network, name, signal, sdkWarnings),
    inspect: (name, signal) => inspectWallet(root, host, network, name, signal),
  };
}

/**
 * Ensure each wallet exists, is funded from genesis, and is dust-registered.
 * Runs create → airdrop → dust for brand-new wallets. An existing one is
 * reused; one holding less than `amountNight` is first topped up to it from
 * genesis (it was funded when the amount was smaller, and generates its Dust
 * that much slower), and one never registered is registered.
 * Always targets the `undeployed` network — airdrop is localnet-only.
 *
 * Every new wallet is funded before any registers: a ledger-9 registration
 * pays its fee from the Dust its NIGHT has generated since the airdrop, so
 * funding them all first gives each the most time to generate before it
 * registers (with DEFAULT_DEV_AIRDROP_AMOUNT none waits).
 */
export async function provisionDevWallets(opts: ProvisionOptions): Promise<ProvisionedWallet[]> {
  const { root } = opts;
  const steps = 'steps' in opts ? opts.steps : walletSteps(root, opts.host, undeployedNetwork(root, opts.host.settings()), opts.sdkWarnings);
  const results: ProvisionedWallet[] = [];
  /** The wallets to register, in order: the new ones and existing ones never registered. */
  const toRegister: string[] = [];
  const existing = new Set<string>();
  const toppedUp = new Map<string, bigint>();
  const withTopUp = (wallet: ProvisionedWallet): ProvisionedWallet => {
    const amount = toppedUp.get(wallet.name);
    return amount === undefined ? wallet : { ...wallet, toppedUp: amount };
  };

  // `wallet generate` sets the new wallet as active — remember the user's
  // current active wallet so we can restore it after provisioning.
  const previousActive = safeGetActiveWallet(root);

  try {
    for (const name of opts.names) {
      throwIfCancelled(opts.signal);

      if (walletExists(root, name)) {
        existing.add(name);
        const wallet = await steps.inspect(name, opts.signal);
        const shortfall = topUpShortfall(wallet.night, opts.amountNight);
        if (shortfall > 0n) {
          opts.onProgress?.(name, 'topping-up', 'reused');
          await steps.airdrop(name, shortfall, opts.signal);
          toppedUp.set(name, shortfall);
        }
        // Funded but never registered (setup stopped between funding and
        // registering): finish it below rather than reuse it as is.
        if (wallet.needsDust) {
          toRegister.push(name);
          continue;
        }
        opts.onProgress?.(name, 'done', 'reused');
        results.push(withTopUp({ name, state: 'reused' }));
        continue;
      }

      opts.onProgress?.(name, 'creating', 'created');
      await steps.generate(name, opts.signal);

      opts.onProgress?.(name, 'funding', 'created');
      await steps.airdrop(name, nightToMicro(opts.amountNight), opts.signal);
      toRegister.push(name);
    }

    for (const name of toRegister) {
      throwIfCancelled(opts.signal);
      const state: WalletProvisionState = existing.has(name) ? 'reused' : 'created';
      opts.onProgress?.(name, 'dust', state);
      await steps.registerDust(name, opts.signal);

      opts.onProgress?.(name, 'done', state);
      results.push(withTopUp(state === 'reused' ? { name, state, registered: true } : { name, state }));
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

async function airdropToWallet(root: string, host: UnlockHost, network: NetworkConfig, name: string, amount: bigint, signal: AbortSignal | undefined, sdkWarnings: CallSdkWarnings): Promise<void> {
  const recipientAddress = (await loadWalletConfig(resolveWalletPath(root, name), host.engines)).addresses.undeployed;
  // dev's wallets live on the local chain.
  await (await host.engines.load(sdkSetOf('undeployed', root))).wallet.airdrop({ networkConfig: network, recipientAddress, amount, signal, sdkWarnings, root, notice: host.notice });
}

async function inspectWallet(root: string, host: UnlockHost, network: NetworkConfig, name: string, signal: AbortSignal | undefined): Promise<ExistingWallet> {
  const address = (await loadWalletConfig(resolveWalletPath(root, name), host.engines)).addresses.undeployed;
  const { registeredUtxos, unregisteredUtxos, balances } = await checkBalance(address, network.indexerWS, undefined, signal);
  return { needsDust: registeredUtxos === 0 && unregisteredUtxos > 0, night: balances.get(NATIVE_TOKEN_TYPE) ?? 0n };
}

async function registerWalletDust(root: string, host: UnlockHost, network: NetworkConfig, name: string, signal: AbortSignal | undefined, sdkWarnings: CallSdkWarnings): Promise<void> {
  const { seed } = await unlockWallet(resolveWalletPath(root, name), { root, host });
  await (await host.engines.load(sdkSetOf('undeployed', root))).wallet.registerDust(Buffer.from(seed, 'hex'), network, { signal, sdkWarnings, root, notice: host.notice });
}
