// Sending NIGHT from a wallet: unshielded, from its unshielded coins to an
// unshielded address, or shielded, from its shielded coins to a shielded
// address. The call syncs the wallet, proves, submits, and waits for the
// indexer to list the transaction.

import { type Host, throwIfCancelled, UsageError, type NetworkName, networkTargetOf, progressSteps, withCallSdkWarnings, nightAmountText, shieldedDisabledReason, shieldedSyncEnabled } from '@kuiralabs/midnight-cli-core';
import { silentSpinner } from '@kuiralabs/midnight-cli-core/ui';
import { type Receipt, RECEIPT_WAIT_MS } from '@kuiralabs/midnight-chain';
import { saveShieldedAddress } from '../wallet-config.ts';
import { seedOf, type WalletSource } from '../seed-resolver.ts';
import { receiptOfSubmitted, saySyncPercent, submitSteps } from './submit-steps.ts';
import { networkChoiceOf, unshieldedAddressOf, type WalletCallOptions, type WalletOpened } from './wallet-call.ts';

export interface TransferNightOptions extends WalletCallOptions<WalletOpened> {
  /** The recipient's address on the network: unshielded (mn_addr_…), or shielded (mn_shield-addr_…) when `shielded`. */
  recipient: string;
  /** NIGHT to send, in its smallest unit; more than 0. */
  amount: bigint;
  /** Send from the wallet's shielded NIGHT to a shielded address. */
  shielded?: boolean;
  /** Allow a shielded transfer where the network has no shielded faucet (preview, preprod, stagenet). */
  forceShielded?: boolean;
  /** How long to wait for the indexer to list the transaction, in milliseconds: RECEIPT_WAIT_MS when not given; 0 does not wait. */
  receiptWaitMs?: number;
}

/** A submitted transfer. */
export interface NightTransfer {
  readonly network: NetworkName;
  /** The transaction's identifier (`midnight tx status` takes it). */
  readonly txHash: string;
  /** The transaction once the indexer lists it, or why it is missing; absent when `receiptWaitMs` is 0. */
  readonly receipt?: Receipt;
}

/**
 * Refuses, as a usage mistake, a shielded transfer on a network with no
 * shielded faucet (no wallet holds shielded NIGHT there), unless `force`.
 */
export function assertShieldedTransferAllowed(network: NetworkName, force = false): void {
  if (!shieldedSyncEnabled(network, force)) throw new UsageError(shieldedDisabledReason(network));
}

/**
 * Sends `amount` NIGHT from the wallet to `recipient`: syncs the wallet
 * (proof server, node and indexer), pays the fee from its Dust, submits, and
 * waits for the indexer to list the transaction. A shielded transfer is
 * refused where the network has no shielded faucet, unless `forceShielded`;
 * it gives a wallet file its shielded address.
 */
export async function transferNight(host: Host, source: WalletSource, options: TransferNightOptions): Promise<NightTransfer> {
  const { signal, onProgress, amount } = options;
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  if (amount <= 0n) throw new UsageError(`Invalid amount: ${nightAmountText(amount)} NIGHT — must be greater than 0`);
  const { network, networkConfig, root } = networkTargetOf(host, networkChoiceOf(options));
  if (options.shielded) assertShieldedTransferAllowed(network, options.forceShielded);
  const wallet = await seedOf(host, source);
  const address = await unshieldedAddressOf(wallet, network, host.engines);
  const steps = progressSteps(onProgress);
  onProgress?.({ kind: 'wallet-opened', network, address });

  const txHash = await withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, async (sdkWarnings) => {
    if (!options.shielded) {
      steps.start('Starting wallet...');
      return (await (await host.engines.for(network)).wallet.transfer({
        root,
        notice: host.notice,
        seedBuffer: wallet.seed,
        networkConfig,
        recipientAddress: options.recipient,
        amount,
        signal,
        log: options.log,
        sdkWarnings,
        onSync: (applied, highest) => saySyncPercent(steps, 'Syncing wallet', applied, highest),
        onSyncDetail: (detail) => steps.update(`Syncing wallet... (waiting on: ${detail})`),
        onDust: (status) => steps.update(`Dust: ${status}`),
        ...submitSteps(steps),
        onSyncWarning: (_tag, message) => steps.update(`Syncing wallet... (${message}, retrying)`),
      })).txHash;
    }

    // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
    const stopListening = sdkWarnings.listen(undefined);
    try {
      steps.start('Syncing wallet...');
      const text = nightAmountText(amount);
      const walletPath = wallet.walletPath;
      return await (await host.engines.for(network)).wallet.shieldedTransfer({
        seed: wallet.seed,
        root,
        notice: host.notice,
        network,
        networkConfig,
        recipient: options.recipient,
        amount,
        progress: silentSpinner(steps.update),
        // Right after another payment the wallet's Dust can be short of this
        // fee: wait when the rest is moments away, else say how long it takes.
        waitForDustToCover: true,
        // A wallet file keeps its shielded address for the next read.
        ...(walletPath === null ? {} : { onSenderShieldedAddress: (shieldedAddress: string) => saveShieldedAddress(walletPath, network, shieldedAddress) }),
        insufficient: (available) =>
          `Insufficient shielded balance: ${available} NIGHT available, ${text} NIGHT requested.\n` +
          `Fund shielded balance: midnight airdrop ${text} --shielded`,
        log: options.log,
        signal,
        onStatus: (status) => steps.update(status),
        onSyncProgress: (applied, highest) => saySyncPercent(steps, 'Syncing wallet', applied, highest),
        onSyncDetail: (detail) => steps.update(`Syncing wallet... (waiting on: ${detail})`),
      });
    } finally {
      stopListening();
    }
  });

  const receipt = await receiptOfSubmitted(networkConfig.indexer, txHash, steps, signal, receiptWaitMs);
  return { network, txHash, ...(receipt === undefined ? {} : { receipt }) };
}
