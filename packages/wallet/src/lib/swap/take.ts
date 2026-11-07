// Taking a swap offer: every check a taker makes passes before its wallet
// opens (the file is an offer for this network, its bytes say what it says,
// the terms are the agreed ones, the expiry hasn't passed), the wallet adds
// its half once the offer is found live, and the swap is submitted.

import { existsSync } from 'node:fs';
import { type Host, throwIfCancelled, type NetworkName, networkTargetOf, progressSteps, withCallSdkWarnings, checkTerms, type SwapTerms, assertOfferUnexpired, readOpenOffers, type VerboseLog } from '@kuiralabs/midnight-cli-core';
import { type Receipt, RECEIPT_WAIT_MS } from '@kuiralabs/midnight-chain';
import { networkChoiceOf } from '../wallet/wallet-call.ts';
import type { PaidCallOptions } from '../wallet/paid-call.ts';
import { receiptOfSubmitted } from '../wallet/submit-steps.ts';
import { OwnOfferError, readOfferFile, takeOffer } from './offers.ts';
import { offerWalletAddress, withSwapSession } from './swap-session.ts';
import { resolveWalletPath } from '../wallet-config.ts';

/** The offer is checked as far as it can be without the chain: the wallet opens next. */
export interface SwapOfferChecked {
  readonly kind: 'offer-checked';
  readonly network: NetworkName;
  readonly id: string;
  /** What the maker gives and wants back: the taker pays `want` and gets `give`. */
  readonly terms: SwapTerms;
}

export interface TakeSwapOfferOptions extends PaidCallOptions<SwapOfferChecked> {
  /** The offer file's text. */
  offer: string;
  /** The terms the taker agreed to, as the maker states them; an offer that says otherwise is refused. */
  agreed: SwapTerms;
  /** The time the expiry is read against; the time of the call when not given. */
  now?: Date;
  /** How long to wait for the indexer to list the swap, in milliseconds: RECEIPT_WAIT_MS when not given; 0 does not wait. */
  receiptWaitMs?: number;
  /** Diagnostic lines, as --verbose shows them. */
  log?: VerboseLog;
}

/** A swap submitted. */
export interface TakenSwapOffer {
  readonly network: NetworkName;
  /** The offer's id. */
  readonly id: string;
  /** The swap's transaction (`midnight tx status` takes it). */
  readonly txHash: string;
  /** The swap once the indexer lists it, or why it is missing; absent when `receiptWaitMs` is 0. */
  readonly receipt?: Receipt;
}

/**
 * Takes the offer with the payer's wallet: refuses an offer for another
 * network, one whose bytes say otherwise, other terms than `agreed` and an
 * expired one, and one of the wallet's own open offers (by mn's record of
 * them, for a wallet mn has a file for) before the wallet opens, then one
 * whose coins are spent; adds
 * the wallet's half and the fee, submits the swap, and waits for the indexer
 * to list it.
 */
export async function takeSwapOffer(host: Host, options: TakeSwapOfferOptions): Promise<TakenSwapOffer> {
  const { agreed, signal, onProgress } = options;
  const now = options.now ?? new Date();
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network, networkConfig } = target;
  const offer = await readOfferFile(target.root, options.offer, network, host.engines);
  checkTerms(offer.contents.terms, agreed);
  assertOfferUnexpired(offer.envelope, now);
  const { id } = offer.envelope;
  // A wallet that is mn's own keeps a record of the offers it made: taking one would swap its coins with itself.
  if (existsSync(resolveWalletPath(target.root, options.wallet))) {
    const address = await offerWalletAddress(host, target.root, options.wallet, network);
    if (readOpenOffers(target.root, network, address).some((own) => own.id === id)) throw new OwnOfferError(id);
  }
  options.log?.('swap', `take: offer ${id}, maker gives ${offer.contents.terms.give.amount} of ${offer.contents.terms.give.token}, wants ${offer.contents.terms.want.amount} of ${offer.contents.terms.want.token}`);
  onProgress?.({ kind: 'offer-checked', network, id, terms: offer.contents.terms });

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) => withSwapSession(target, options, sdkWarnings, async (session) => {
    const steps = progressSteps(onProgress);
    steps.start('Checking the offer, adding this half and proving the swap...');
    const txHash = await takeOffer(session, offer, agreed, networkConfig, now, signal);
    const receipt = await receiptOfSubmitted(networkConfig.indexer, txHash, steps, signal, receiptWaitMs, 'Swap submitted');
    return { network, id, txHash, ...(receipt === undefined ? {} : { receipt }) };
  }));
}
