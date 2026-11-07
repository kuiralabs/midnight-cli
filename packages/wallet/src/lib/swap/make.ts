// Making a swap offer: the maker's wallet proves its half, and the offer
// comes back as an offer file's text for the maker to hand to a taker. An
// offer holds every coin it spends until it is taken or cancelled, so when no
// free coin is worth exactly what it gives, the wallet first splits one (a
// transfer to itself), and the offer holds only the coin the split made.

import { type Host, throwIfCancelled, type NetworkName, networkTargetOf, progressSteps, withCallSdkWarnings, type SwapTerms, type VerboseLog, UsageError, type WalletSession, type SwapLeg } from '@kuiralabs/midnight-cli-core';
import { networkChoiceOf } from '../wallet/wallet-call.ts';
import type { PaidCallOptions } from '../wallet/paid-call.ts';
import { type Receipt, RECEIPT_WAIT_MS } from '@kuiralabs/midnight-chain';
import { receiptOfSubmitted } from '../wallet/submit-steps.ts';
import { awaitFreeCoin, makeOffer, shieldedHeld, shortOf } from './offers.ts';
import { offerWalletAddress, withSwapSession } from './swap-session.ts';

/** The swap's network is known: its wallet opens next. */
export interface SwapNetworkChosen {
  readonly kind: 'swap-network';
  readonly network: NetworkName;
}

export interface MakeSwapOfferOptions extends PaidCallOptions<SwapNetworkChosen> {
  /** What the maker gives and wants back, each a shielded token and an amount of its smallest unit. */
  terms: SwapTerms;
  /** When takers using mn stop taking the offer (the chain takes it until it is cancelled). */
  expiresAt: Date;
  /** When the offer is made, as mn's record of the wallet's open offers keeps it; the time of the call when not given. */
  now?: Date;
  /** How long to wait for the indexer to list a split, in milliseconds: RECEIPT_WAIT_MS when not given; 0 does not wait. */
  receiptWaitMs?: number;
  /** Diagnostic lines, as --verbose shows them. */
  log?: VerboseLog;
}

/** The split that left the wallet a coin worth exactly what the offer gives. */
export interface CoinSplit {
  readonly txHash: string;
  /** The split once the indexer lists it, or why it is missing; absent when `receiptWaitMs` is 0. */
  readonly receipt?: Receipt;
}

/** An offer made. */
export interface MadeSwapOffer {
  readonly network: NetworkName;
  /** The offer's id, 64 hex characters (`swap cancel` takes 8 of them at least). */
  readonly id: string;
  /** The terms as the offer's own bytes state them. */
  readonly terms: SwapTerms;
  readonly expiresAt: Date;
  /** The offer file's text, to hand to the taker. */
  readonly file: string;
  /** The split made first, when no free coin was worth exactly what the offer gives; absent when none was needed. */
  readonly split?: CoinSplit;
}

/** Refuses an expiry that is no date, or not after `now`, before anything is built: the offer file could not state it. */
function assertExpiryAhead(expiresAt: Date, now: Date): void {
  if (Number.isNaN(expiresAt.getTime())) throw new UsageError('The offer\'s expiry is not a date: give one after now');
  if (expiresAt.getTime() <= now.getTime()) throw new UsageError(`The offer's expiry ${expiresAt.toISOString()} has already passed: give one after now`);
}

/**
 * Refuses an offer of more than the wallet holds of the token, before a split
 * is built and paid: cancelling an open offer can't make up a shortfall, so
 * this is INSUFFICIENT_BALANCE, not OFFER_COINS_IN_USE. A wallet that holds
 * enough, but partly in its open offers, goes on to the split, whose coin
 * picking refuses the offers' coins with OFFER_COINS_IN_USE.
 */
async function assertHolds(session: WalletSession, give: SwapLeg, log: VerboseLog | undefined): Promise<void> {
  const held = await shieldedHeld(session, give.token);
  log?.('swap', `make: wallet holds ${held} of ${give.token}, the offer gives ${give.amount}`);
  if (held < give.amount) throw shortOf(give, held, 'the offer gives');
}

/**
 * Makes a swap offer with the payer's wallet: proves its half of the swap
 * (it gives `terms.give` and is paid `terms.want`), and records the offer
 * among the wallet's open offers so its later spends don't cancel it unawares.
 * The offer spends one coin worth exactly `terms.give`: when the wallet holds
 * none outside its open offers, it first splits one (a transfer to itself,
 * paying a fee in Dust), waits for the indexer to list it and for the wallet
 * to hold the new coin. The coin stays committed until the offer is taken or
 * cancelled. A cancel after the split leaves the split made and no offer.
 * An expiry that is no date or not after `now` is refused before the wallet
 * opens; an offer of more than the wallet holds, before the split.
 */
export async function makeSwapOffer(host: Host, options: MakeSwapOfferOptions): Promise<MadeSwapOffer> {
  const { terms, expiresAt, signal, onProgress } = options;
  const now = options.now ?? new Date();
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  assertExpiryAhead(expiresAt, now);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network, root, networkConfig } = target;
  onProgress?.({ kind: 'swap-network', network });
  const address = await offerWalletAddress(host, root, options.wallet, network);

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) => withSwapSession(target, options, sdkWarnings, async (session) => {
    const steps = progressSteps(onProgress);
    let split: CoinSplit | undefined;
    if (!(await session.holdsFreeCoin(terms.give))) {
      await assertHolds(session, terms.give, options.log);
      steps.start('Splitting a coin worth exactly what the offer gives (a transfer to this wallet)...');
      const txHash = await session.submit(await session.splitCoin(terms.give));
      const receipt = await receiptOfSubmitted(networkConfig.indexer, txHash, steps, signal, receiptWaitMs, 'Coin split');
      split = { txHash, ...(receipt === undefined ? {} : { receipt }) };
      steps.start('Waiting for the wallet to hold the new coin...');
      await awaitFreeCoin(session, terms.give, signal);
      steps.done('New coin held');
    }
    steps.start('Making the offer (proving its half)...');
    const made = await makeOffer(session, await host.engines.for(session.network), root, address, terms, expiresAt, now);
    steps.done('Offer made');
    return { network, id: made.envelope.id, terms: made.envelope.terms, expiresAt, file: made.file, ...(split === undefined ? {} : { split }) };
  }));
}
