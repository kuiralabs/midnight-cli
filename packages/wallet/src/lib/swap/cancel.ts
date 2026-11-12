// Cancelling a swap offer of the wallet's: its coins are spent back to the
// wallet, so no taker can take it any more.

import { type Host, sdkSetOf, throwIfCancelled, type NetworkName, networkTargetOf, progressSteps, withCallSdkWarnings, type VerboseLog } from '@kuiralabs/midnight-cli-core';
import { type Receipt, RECEIPT_WAIT_MS } from '@kuiralabs/midnight-chain';
import { networkChoiceOf } from '../wallet/wallet-call.ts';
import type { PaidCallOptions } from '../wallet/paid-call.ts';
import { receiptOfSubmitted } from '../wallet/submit-steps.ts';
import { cancelOffer, findOpenOffer, type SpentIn, withSpendIdentifier } from './offers.ts';
import { offerWalletAddress, withSwapSession } from './swap-session.ts';

export interface CancelSwapOfferOptions extends PaidCallOptions {
  /** The open offer's id, or 8 characters of it at least. */
  id: string;
  /** How long to wait for the indexer to list the cancel, in milliseconds: RECEIPT_WAIT_MS when not given; 0 does not wait. */
  receiptWaitMs?: number;
  /** Diagnostic lines, as --verbose shows them. */
  log?: VerboseLog;
}

/** What cancelling did. */
export interface CancelledSwapOffer {
  readonly network: NetworkName;
  /** The offer's full id. */
  readonly id: string;
  /** Its coins were spent back to the wallet; false when it was found taken already (it is only closed in mn's record). */
  readonly cancelled: boolean;
  /** Why it was not cancelled: its coins were spent first, taken by a taker or cancelled from another copy of the wallet. Absent when it was cancelled. */
  readonly reason?: 'taken';
  /** With `reason`: the transaction that spent its coins (its identifier as `txHash` when it could be read, its `hash`), and its block. */
  readonly takenIn?: SpentIn;
  /** The cancel's transaction, when one was needed. */
  readonly txHash?: string;
  /** The cancel once the indexer lists it, or why it is missing; absent with no cancel, or when `receiptWaitMs` is 0. */
  readonly receipt?: Receipt;
}

/**
 * Cancels the payer's wallet's open offer `id` (a prefix of 8 characters at
 * least names it): spends its coins back to the wallet, waits for the indexer
 * to list the cancel, and closes the offer in mn's record. An offer found
 * taken already, before the cancel is built or when the node refuses it for
 * that, is only closed: `cancelled` is false, with the reason and the
 * transaction that took it. An id that is not one, or names no open
 * offer, or more than one, is refused from mn's record before the wallet opens.
 */
export async function cancelSwapOffer(host: Host, options: CancelSwapOfferOptions): Promise<CancelledSwapOffer> {
  const { signal, onProgress } = options;
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network, root, networkConfig } = target;
  const address = await offerWalletAddress(host, root, options.wallet, network);
  const engine = await host.engines.load(sdkSetOf(network, root));
  // From mn's record alone, before the wallet opens: opening it syncs, which takes minutes on a hosted network.
  let offer;
  try {
    offer = findOpenOffer(root, network, address, options.id);
  } catch (err) {
    // A record an earlier mn kept names the taking transaction by its hash: its identifier is read where the indexer gives it.
    throw await withSpendIdentifier(err, engine, networkConfig, signal);
  }
  options.log?.('swap', `cancel: offer ${offer.id} of wallet ${address}, ${offer.nullifiers.length} coin(s)`);

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) => withSwapSession(target, options, sdkWarnings, async (session) => {
    const steps = progressSteps(onProgress);
    steps.start('Spending the offer\'s coins back to this wallet...');
    const outcome = await cancelOffer(session, engine, root, networkConfig, address, options.id, signal);
    const taken = outcome.alreadyTaken[0];
    if (taken !== undefined) {
      steps.done('It was taken already');
      return { network, id: taken.offer.id, cancelled: false, reason: 'taken', takenIn: taken.takenIn };
    }
    // Not taken: cancelled, by the cancel's transaction.
    const { id } = outcome.cancelled[0]!;
    const txHash = outcome.txHash!;
    const receipt = await receiptOfSubmitted(networkConfig.indexer, txHash, steps, signal, receiptWaitMs, 'Offer cancelled');
    return { network, id, cancelled: true, txHash, ...(receipt === undefined ? {} : { receipt }) };
  }));
}
