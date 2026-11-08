// Sending NIGHT from a wallet: unshielded, from its unshielded coins to an
// unshielded address, or shielded, from its shielded coins to a shielded
// address; to one recipient, or to several in one transaction. The call
// syncs the wallet, proves, submits, and waits for the indexer to list the
// transaction.

import { type Host, throwIfCancelled, UsageError, type NetworkName, networkTargetOf, progressSteps, withCallSdkWarnings, nightAmountText, shieldedDisabledReason, shieldedSyncEnabled } from '@kuiralabs/midnight-cli-core';
import { silentSpinner } from '@kuiralabs/midnight-cli-core/ui';
import { assertNetworkReady, explainProofFailure, type Receipt, RECEIPT_WAIT_MS } from '@kuiralabs/midnight-chain';
import { saveShieldedAddress } from '../wallet-config.ts';
import { seedOf, type WalletSource } from '../seed-resolver.ts';
import { receiptOfSubmitted, saySyncPercent, submitSteps } from './submit-steps.ts';
import { networkChoiceOf, unshieldedAddressOf, type WalletCallOptions, type WalletOpened } from './wallet-call.ts';
import { assertRecipientCount, recipientLabel } from '../transfer-recipients.ts';

/** One recipient of a transfer and what it is paid. */
export interface NightPayment {
  /** The recipient's address on the network: unshielded (mn_addr_…), or shielded (mn_shield-addr_…) when the transfer is shielded. */
  readonly recipient: string;
  /** NIGHT, in its smallest unit; more than 0. */
  readonly amount: bigint;
}

/**
 * What a transfer pays: one recipient (`recipient` and `amount`), or several
 * in one transaction (`recipients`), never both.
 */
export interface TransferNightOptions extends WalletCallOptions<WalletOpened> {
  /** The recipient's address on the network: unshielded (mn_addr_…), or shielded (mn_shield-addr_…) when `shielded`. Not with `recipients`. */
  recipient?: string;
  /** NIGHT to send, in its smallest unit; more than 0. Not with `recipients`. */
  amount?: bigint;
  /**
   * Several recipients paid in one transaction, one output each, in this
   * order; at most MAX_TRANSFER_RECIPIENTS. A recipient listed twice is paid
   * twice. Not with `recipient` and `amount`.
   */
  recipients?: readonly NightPayment[];
  /** Send from the wallet's shielded NIGHT to a shielded address. */
  shielded?: boolean;
  /** Allow a shielded transfer where the network has no shielded faucet (preview, preprod). */
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

/** How to fund a wallet's shielded NIGHT on `network`: the local faucet on undeployed, a shielded transfer from another wallet elsewhere. */
export function fundShieldedHint(network: NetworkName, amountText: string): string {
  return network === 'undeployed'
    ? `Fund the shielded balance: midnight airdrop ${amountText} --shielded`
    : 'Fund the shielded balance with a shielded transfer from another wallet (midnight transfer <this wallet\'s shielded address> <amount> --shielded).';
}

/**
 * Refuses, as a usage mistake, a shielded transfer on a network with no
 * shielded faucet (no wallet holds shielded NIGHT there), unless `force`.
 */
export function assertShieldedTransferAllowed(network: NetworkName, force = false): void {
  if (!shieldedSyncEnabled(network, force)) throw new UsageError(shieldedDisabledReason(network));
}

/**
 * The payments `options` asks for: `recipient` and `amount`, or `recipients`.
 * Refuses both, neither, an empty or too long list, and an amount not above 0.
 */
export function paymentsOf(options: Pick<TransferNightOptions, 'recipient' | 'amount' | 'recipients'>): NightPayment[] {
  const single = options.recipient !== undefined || options.amount !== undefined;
  if (single && options.recipients !== undefined) {
    throw new UsageError('Give either recipient and amount, or recipients, not both.');
  }
  if (options.recipients === undefined) {
    if (options.recipient === undefined || options.amount === undefined) {
      throw new UsageError('A transfer needs recipient and amount, or recipients.');
    }
    if (options.amount <= 0n) throw new UsageError(`Invalid amount: ${nightAmountText(options.amount)} NIGHT — must be greater than 0`);
    return [{ recipient: options.recipient, amount: options.amount }];
  }
  const payments = [...options.recipients];
  assertRecipientCount(payments.length);
  payments.forEach(({ recipient, amount }, index) => {
    if (amount <= 0n) {
      throw new UsageError(`${recipientLabel(index, payments.length, recipient)}: Invalid amount: ${nightAmountText(amount)} NIGHT — must be greater than 0`);
    }
  });
  return payments;
}

/**
 * Sends NIGHT from the wallet to `recipient`, or to each of `recipients` in
 * one transaction: syncs the wallet (proof server, node and indexer), pays the
 * fee from its Dust, submits, and waits for the indexer to list the
 * transaction. A shielded transfer is refused where the network has no
 * shielded faucet, unless `forceShielded`; it gives a wallet file its
 * shielded address.
 */
export async function transferNight(host: Host, source: WalletSource, options: TransferNightOptions): Promise<NightTransfer> {
  const { signal, onProgress } = options;
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  const [first, ...rest] = paymentsOf(options);
  const { recipient, amount } = first!;
  const extraRecipients = rest.map((payment) => ({ address: payment.recipient, amount: payment.amount }));
  const total = [first!, ...rest].reduce((sum, payment) => sum + payment.amount, 0n);
  const { network, networkConfig, root } = networkTargetOf(host, networkChoiceOf(options));
  if (options.shielded) assertShieldedTransferAllowed(network, options.forceShielded);
  const wallet = await seedOf(host, source);
  const address = await unshieldedAddressOf(wallet, network, host.engines);
  const steps = progressSteps(onProgress);
  onProgress?.({ kind: 'wallet-opened', network, address });

  const txHash = await withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, async (sdkWarnings) => {
    if (!options.shielded) {
      steps.start('Starting wallet...');
      // A ledger-9 chain, and the indexer, the node and the proof server answer, before the sync and the proof.
      await assertNetworkReady(network, networkConfig, { proofServer: true }, { signal });
      return (await (await host.engines.for(network)).wallet.transfer({
        root,
        notice: host.notice,
        seedBuffer: wallet.seed,
        networkConfig,
        recipientAddress: recipient,
        amount,
        extraRecipients,
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
      await assertNetworkReady(network, networkConfig, { proofServer: true }, { signal });
      const text = nightAmountText(total);
      const walletPath = wallet.walletPath;
      return await (await host.engines.for(network)).wallet.shieldedTransfer({
        seed: wallet.seed,
        root,
        notice: host.notice,
        network,
        networkConfig,
        recipient,
        amount,
        extraRecipients,
        progress: silentSpinner(steps.update),
        // Right after another payment the wallet's Dust can be short of this
        // fee: wait when the rest is moments away, else say how long it takes.
        waitForDustToCover: true,
        // A wallet file keeps its shielded address for the next read.
        ...(walletPath === null ? {} : { onSenderShieldedAddress: (shieldedAddress: string) => saveShieldedAddress(walletPath, network, shieldedAddress) }),
        insufficient: (available) =>
          `Insufficient shielded balance: ${available} NIGHT available, ${text} NIGHT requested${rest.length > 0 ? ` in all, for ${rest.length + 1} recipients` : ''}.\n` + fundShieldedHint(network, text),
        log: options.log,
        signal,
        onStatus: (status) => steps.update(status),
        onSyncProgress: (applied, highest) => saySyncPercent(steps, 'Syncing wallet', applied, highest),
        onSyncDetail: (detail) => steps.update(`Syncing wallet... (waiting on: ${detail})`),
      });
    } finally {
      stopListening();
    }
  }).catch(async (err: unknown) => { throw await explainProofFailure(err, networkConfig.proofServer, signal); });

  const receipt = await receiptOfSubmitted(networkConfig.indexer, txHash, steps, signal, receiptWaitMs);
  return { network, txHash, ...(receipt === undefined ? {} : { receipt }) };
}
