// Cancelling a swap offer of the wallet's: its coins are spent back to the
// wallet, so no taker can take it any more.

import { type Host, throwIfCancelled, type NetworkName, networkTargetOf, progressSteps, withCallSdkWarnings, type VerboseLog } from '@kuiralabs/midnight-cli-core';
import { type Receipt, RECEIPT_WAIT_MS } from '@kuiralabs/midnight-chain';
import { networkChoiceOf } from '../wallet/wallet-call.ts';
import type { PaidCallOptions } from '../wallet/paid-call.ts';
import { receiptOfSubmitted } from '../wallet/submit-steps.ts';
import { cancelOffer, findOpenOffer } from './offers.ts';
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
  /** The cancel's transaction, when one was needed. */
  readonly txHash?: string;
  /** The cancel once the indexer lists it, or why it is missing; absent with no cancel, or when `receiptWaitMs` is 0. */
  readonly receipt?: Receipt;
}

/**
 * Cancels the payer's wallet's open offer `id` (a prefix of 8 characters at
 * least names it): spends its coins back to the wallet, waits for the indexer
 * to list the cancel, and closes the offer in mn's record. An offer found
 * taken already is only closed. An id that is not one, or names no open
 * offer, or more than one, is refused from mn's record before the wallet opens.
 */
export async function cancelSwapOffer(host: Host, options: CancelSwapOfferOptions): Promise<CancelledSwapOffer> {
  const { signal, onProgress } = options;
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network, root, networkConfig } = target;
  const address = await offerWalletAddress(host, root, options.wallet, network);
  // From mn's record alone, before the wallet opens: opening it syncs, which takes minutes on a hosted network.
  const offer = findOpenOffer(root, network, address, options.id);
  options.log?.('swap', `cancel: offer ${offer.id} of wallet ${address}, ${offer.nullifiers.length} coin(s)`);

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) => withSwapSession(target, options, sdkWarnings, async (session) => {
    const steps = progressSteps(onProgress);
    steps.start('Spending the offer\'s coins back to this wallet...');
    const outcome = await cancelOffer(session, root, networkConfig, address, options.id, signal);
    const { id } = [...outcome.cancelled, ...outcome.alreadyTaken][0]!;
    if (outcome.txHash === undefined) {
      steps.done('It was taken already');
      return { network, id, cancelled: false };
    }
    const receipt = await receiptOfSubmitted(networkConfig.indexer, outcome.txHash, steps, signal, receiptWaitMs, 'Offer cancelled');
    return { network, id, cancelled: true, txHash: outcome.txHash, ...(receipt === undefined ? {} : { receipt }) };
  }));
}
