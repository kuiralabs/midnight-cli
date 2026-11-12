// Inspecting a swap offer: what its file says, checked against its own bytes,
// and whether it is still live, asked of the indexer. No wallet opens.

import { type Host, sdkSetOf, throwIfCancelled, type NetworkName, networkTargetOf, type NetworkChoice, progressSteps, type ProgressEvent, type SwapTerms } from '@kuiralabs/midnight-cli-core';
import type { CoinSpend } from '@kuiralabs/midnight-chain';
import { networkChoiceOf } from '../wallet/wallet-call.ts';
import { readOfferFile, type SpentIn, spentInOf, standingOf } from './offers.ts';

export interface InspectSwapOfferOptions extends NetworkChoice {
  /** The offer file's text. */
  offer: string;
  /** The time the expiry is read against; the time of the call when not given. */
  now?: Date;
  /** Cancels the inspection: a call cancelled already starts nothing; one cancelled later stops with CancelledError. */
  signal?: AbortSignal;
  /** Each step, in today's words for a person. */
  onProgress?: (event: ProgressEvent) => void;
}

/** Where an offer stands. */
export interface SwapOfferStanding {
  readonly network: NetworkName;
  readonly id: string;
  /** What the maker gives and wants back, as the offer's bytes state them. */
  readonly terms: SwapTerms;
  readonly expiresAt: Date;
  /** Past the maker's expiry: takers using mn refuse it. */
  readonly expired: boolean;
  /** None of its coins is spent: it can be taken. */
  readonly live: boolean;
  /** The spends of its coins (it was taken, or its maker cancelled it); empty while it is live. */
  readonly spends: readonly CoinSpend[];
  /** When it is not live: the transaction that spent its first coin (its identifier as `txHash` when it could be read, its `hash`), and its block. */
  readonly takenIn?: SpentIn;
}

/**
 * Reads the offer file's text for the network (refusing one for another
 * network, or whose bytes say otherwise than the file), and asks the indexer
 * whether its coins are spent.
 */
export async function inspectSwapOffer(host: Host, options: InspectSwapOfferOptions): Promise<SwapOfferStanding> {
  const { signal } = options;
  const now = options.now ?? new Date();
  throwIfCancelled(signal);
  const { network, root, networkConfig } = networkTargetOf(host, networkChoiceOf(options));
  const offer = await readOfferFile(root, options.offer, network, host.engines);
  const steps = progressSteps(options.onProgress);
  steps.start('Asking the indexer whether it is still live...');
  const { expired, spends } = await standingOf(offer, networkConfig, now, signal);
  steps.done(spends.length === 0 ? 'Live' : 'Taken');
  const { envelope } = offer;
  const takenIn = spends.length === 0 ? undefined : await spentInOf(spends[0]!, await host.engines.load(sdkSetOf(network, root)), networkConfig, signal);
  return { network, id: envelope.id, terms: envelope.terms, expiresAt: envelope.expiresAt, expired, live: spends.length === 0, spends, ...(takenIn === undefined ? {} : { takenIn }) };
}
