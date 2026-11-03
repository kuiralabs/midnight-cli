// Listing a wallet's open swap offers, each asked of the indexer: the ones
// taken since are closed in mn's record. No wallet opens.

import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import type { NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { networkTargetOf, type NetworkChoice } from '@kuiralabs/midnight-cli-core/lib/network-target';
import { progressSteps, type ProgressEvent } from '@kuiralabs/midnight-cli-core/lib/progress';
import { networkChoiceOf } from '../wallet/wallet-call.ts';
import { listOffers, type ListedOffer } from './offers.ts';
import { offerWalletAddress } from './swap-session.ts';

export interface ListSwapOffersOptions extends NetworkChoice {
  /** mn's wallet whose offers to list, a name or a path; the active wallet when not given. */
  wallet?: string;
  /** The time expiries are read against; the time of the call when not given. */
  now?: Date;
  /** Cancels the listing: a call cancelled already starts nothing; one cancelled later stops with CancelledError. */
  signal?: AbortSignal;
  /** Each step, in today's words for a person. */
  onProgress?: (event: ProgressEvent) => void;
}

/** A wallet's open offers on a network. */
export interface SwapOffersListed {
  readonly network: NetworkName;
  /** Each open offer, whether it is past its expiry, and whether it was taken since (then closed in mn's record). */
  readonly offers: readonly ListedOffer[];
}

/** The wallet's open offers on the network, each asked of the indexer; the ones taken since are closed in mn's record and listed as taken. */
export async function listSwapOffers(host: Host, options: ListSwapOffersOptions = {}): Promise<SwapOffersListed> {
  const { signal } = options;
  const now = options.now ?? new Date();
  throwIfCancelled(signal);
  const { network, root, networkConfig } = networkTargetOf(host, networkChoiceOf(options));
  const address = await offerWalletAddress(host, root, options.wallet, network);
  const steps = progressSteps(options.onProgress);
  steps.start('Asking the indexer about each open offer...');
  const offers = await listOffers(root, network, networkConfig, address, now, signal);
  steps.done(`${offers.length} offer${offers.length === 1 ? '' : 's'}`);
  return { network, offers };
}
