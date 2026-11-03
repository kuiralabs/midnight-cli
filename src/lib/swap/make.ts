// Making a swap offer: the maker's wallet proves its half, and the offer
// comes back as an offer file's text for the maker to hand to a taker.

import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import type { NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { networkTargetOf } from '@kuiralabs/midnight-cli-core/lib/network-target';
import { progressSteps } from '@kuiralabs/midnight-cli-core/lib/progress';
import { withCallSdkWarnings } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import type { SwapTerms } from '@kuiralabs/midnight-cli-core/lib/swap-offer';
import { networkChoiceOf } from '../wallet/wallet-call.ts';
import type { PaidCallOptions } from '../wallet/paid-call.ts';
import { makeOffer } from './offers.ts';
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
}

/**
 * Makes a swap offer with the payer's wallet: proves its half of the swap
 * (it gives `terms.give` and is paid `terms.want`), and records the offer
 * among the wallet's open offers so its later spends don't cancel it unawares.
 * Its coins stay committed until the offer is taken or cancelled.
 */
export async function makeSwapOffer(host: Host, options: MakeSwapOfferOptions): Promise<MadeSwapOffer> {
  const { terms, expiresAt, signal, onProgress } = options;
  const now = options.now ?? new Date();
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network, root } = target;
  onProgress?.({ kind: 'swap-network', network });
  const address = await offerWalletAddress(host, root, options.wallet, network);

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) => withSwapSession(target, options, sdkWarnings, async (session) => {
    const steps = progressSteps(onProgress);
    steps.start('Making the offer (proving its half)...');
    const made = await makeOffer(session, await host.engines.for(session.network), root, address, terms, expiresAt, now);
    steps.done('Offer made');
    return { network, id: made.envelope.id, terms: made.envelope.terms, expiresAt, file: made.file };
  }));
}
