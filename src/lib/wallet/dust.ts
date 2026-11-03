// A wallet's Dust: whether its NIGHT is registered to generate Dust and how
// much it has, registering it, and a snapshot of its Dust another wallet
// restores from instead of syncing it cold.

import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import type { NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { networkTargetOf } from '@kuiralabs/midnight-cli-core/lib/network-target';
import { progressSteps } from '@kuiralabs/midnight-cli-core/lib/progress';
import { withCallSdkWarnings } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import type { DustExportResult } from '@kuiralabs/midnight-cli-core/lib/engine';
import { checkBalance } from '@kuiralabs/midnight-chain/lib/balance-subscription';
import { type Receipt, RECEIPT_WAIT_MS, receiptOf } from '@kuiralabs/midnight-chain/lib/tx-receipt';
import { seedOf, type WalletSource } from '../seed-resolver.ts';
import { networkChoiceOf, unshieldedAddressOf, type WalletCallOptions, type WalletOpened } from './wallet-call.ts';

/** A wallet's NIGHT coins by whether they generate Dust. */
export interface DustRegistrationCounts {
  readonly network: NetworkName;
  /** Unspent NIGHT coins registered to generate Dust. */
  readonly registeredUtxos: number;
  /** Unspent NIGHT coins not registered. */
  readonly unregisteredUtxos: number;
}

/** A wallet none of whose NIGHT generates Dust: its Dust is not read. */
export interface DustUnregistered extends DustRegistrationCounts {
  readonly registered: false;
}

/** A wallet with NIGHT that generates Dust, and the Dust it has. */
export interface DustRegistered extends DustRegistrationCounts {
  readonly registered: true;
  /** Dust, in its smallest unit (specks). */
  readonly dust: bigint;
  /** Dust coins that can pay a fee now. */
  readonly availableCoins: number;
  /** The wallet's unspent NIGHT coins the Dust reader saw. */
  readonly ownedUtxos: number;
  /** Dust events this read applied (0 when its cache was current). */
  readonly eventsApplied: number;
  /** Whether a cache took part: the read resumed from it, or it was current. */
  readonly fromCache: boolean;
}

export type DustStatus = DustUnregistered | DustRegistered;

export interface ReadDustStatusOptions extends WalletCallOptions<WalletOpened> {
  /** Read the Dust past every cache, from the indexer. */
  forceFresh?: boolean;
}

/**
 * Whether the wallet's NIGHT generates Dust, from the indexer; when some does,
 * its Dust, from mn's reader of the indexer's events (through its cache).
 */
export async function readDustStatus(host: Host, source: WalletSource, options: ReadDustStatusOptions = {}): Promise<DustStatus> {
  const { signal, log, onProgress } = options;
  throwIfCancelled(signal);
  const { network, networkConfig, root } = networkTargetOf(host, networkChoiceOf(options));
  const wallet = await seedOf(host, source);
  const address = await unshieldedAddressOf(wallet, network, host.engines);
  const steps = progressSteps(onProgress);
  onProgress?.({ kind: 'wallet-opened', network, address });

  // Registration first, from the indexer's coins alone: a wallet with none registered has no Dust to read.
  steps.start(`Checking registration on ${network}...`);
  const { registeredUtxos, unregisteredUtxos } = await checkBalance(address, networkConfig.indexerWS, (current, highest) => {
    if (highest > 0) {
      const pct = Math.min(Math.round((current / highest) * 100), 100);
      steps.update(pct >= 100 ? 'Checking registration...' : `Checking registration... ${pct}%`);
    }
  }, signal);
  throwIfCancelled(signal);
  steps.done('Registration checked');
  if (registeredUtxos === 0) return { network, registered: false, registeredUtxos, unregisteredUtxos };

  // Read from the indexer directly: the Dust wallet SDK's sync can hang on `isConnected`.
  steps.start(`Reading dust events from ${networkConfig.networkId.toLowerCase()}...`);
  const view = await (await host.engines.for(network)).wallet.dustBalance(wallet.seed, networkConfig, {
    root,
    notice: host.notice,
    forceFresh: options.forceFresh,
    signal,
    log,
    onStatus: (message) => steps.update(message),
  });
  steps.done(view.fromCache && view.eventsApplied === 0 ? 'Cache up to date' : 'Dust events applied');
  return {
    network,
    registered: true,
    registeredUtxos,
    unregisteredUtxos,
    dust: view.balance,
    availableCoins: view.availableCoins,
    ownedUtxos: view.ownedUtxoCount,
    eventsApplied: view.eventsApplied,
    fromCache: view.fromCache,
  };
}

/** What registering a wallet's NIGHT for Dust did. */
export interface DustRegistrationResult {
  readonly network: NetworkName;
  /** The wallet had Dust already: nothing was registered or submitted. */
  readonly alreadyAvailable: boolean;
  /** The wallet's Dust once synced, in its smallest unit (specks). */
  readonly dust: bigint;
  /** The registration's identifier, when one was submitted. */
  readonly txHash?: string;
  /** The submitted registration once the indexer lists it, or why it is missing; absent when none was submitted, or `receiptWaitMs` is 0. */
  readonly receipt?: Receipt;
}

export interface RegisterDustOptions extends WalletCallOptions<WalletOpened> {
  /** How long to wait for the indexer to list a submitted registration, in milliseconds: RECEIPT_WAIT_MS when not given; 0 does not wait. */
  receiptWaitMs?: number;
}

/**
 * Registers the wallet's NIGHT to generate Dust, unless it has Dust already:
 * syncs the wallet (proof server, node and indexer), submits, and waits for
 * the indexer to list the registration.
 */
export async function registerDust(host: Host, source: WalletSource, options: RegisterDustOptions = {}): Promise<DustRegistrationResult> {
  const { signal, log, onProgress } = options;
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  const { network, networkConfig, root } = networkTargetOf(host, networkChoiceOf(options));
  const wallet = await seedOf(host, source);
  const address = await unshieldedAddressOf(wallet, network, host.engines);
  const steps = progressSteps(onProgress);
  onProgress?.({ kind: 'wallet-opened', network, address });

  steps.start('Syncing wallet...');
  const result = await withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, async (sdkWarnings) => (await host.engines.for(network)).wallet.registerDust(wallet.seed, networkConfig, {
    root,
    notice: host.notice,
    signal,
    sdkWarnings,
    log,
    onStatus: (status) => steps.update(status),
    onSyncProgress: (applied, highest) => {
      if (highest > 0) {
        const pct = Math.min(Math.round((applied / highest) * 100), 100);
        steps.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
      }
    },
    onSyncDetail: (detail) => steps.update(`Syncing wallet... (waiting on: ${detail})`),
    onSyncWarning: (_tag, message) => steps.update(`Syncing wallet... (${message}, retrying)`),
  }));
  let receipt: Receipt | undefined;
  if (result.txHash && receiptWaitMs > 0) {
    steps.update('Waiting for the indexer to list it...');
    receipt = await receiptOf(networkConfig.indexer, result.txHash, signal, receiptWaitMs);
  }
  steps.done(result.alreadyAvailable ? 'Dust already available' : 'Dust registration complete');
  return {
    network,
    alreadyAvailable: result.alreadyAvailable,
    dust: result.dustBalance,
    ...(result.txHash ? { txHash: result.txHash } : {}),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

/**
 * The wallet's Dust as a snapshot the wallet SDK restores from (its
 * `dustSerializedState`), read fast from the indexer's events through mn's
 * cache. A partial snapshot stopped short of the chain's tip: still a valid
 * checkpoint, but a wallet restored from it has events left to catch up on.
 */
export async function exportDustSnapshot(host: Host, source: WalletSource, options: WalletCallOptions = {}): Promise<DustExportResult> {
  const { signal, log } = options;
  throwIfCancelled(signal);
  const { network, networkConfig, root } = networkTargetOf(host, networkChoiceOf(options));
  const steps = progressSteps(options.onProgress);
  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, async (sdkWarnings) => {
    // The chain-id check connects to the node; keep polkadot-js's RPC-CORE noise off the terminal.
    const stopListening = sdkWarnings.listen(undefined);
    try {
      const wallet = await seedOf(host, source);
      steps.start(`Reading dust events from ${network}...`);
      const result = await (await host.engines.for(network)).wallet.exportDust(wallet.seed, network, networkConfig, {
        root,
        notice: host.notice,
        signal,
        log,
        onProgress: (applied, maxIdSeen) => steps.update(
          maxIdSeen > 0
            ? `Reading dust events... ${applied}/${maxIdSeen + 1}`
            : `Reading dust events... ${applied}`,
        ),
      });
      steps.done(
        result.partial
          ? 'Dust snapshot ready (incomplete)'
          : result.fromCache && result.eventCount === 0 ? 'Cache up to date' : 'Dust snapshot ready',
      );
      return result;
    } finally {
      stopListening();
    }
  });
}
