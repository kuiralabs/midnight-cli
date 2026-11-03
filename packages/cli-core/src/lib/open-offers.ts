// The offers a wallet has made and not yet seen taken or cancelled, kept in
// mn's state. An offer's coins are committed to it until then: a later spend
// of any of them would cancel the offer, so a wallet's spends are checked
// against this record (assertSpendsNoOfferCoin) and refused unless the caller
// says to cancel. Expiry is not an end: the chain lets an expired offer be
// taken until its coins are spent, so it stays open until then.

import { join } from 'node:path';
import { readJsonIfPresent, writeJsonDurably } from './durable-file.ts';
import type { NetworkName } from './network.ts';
import type { SwapLeg, SwapTerms } from './swap-offer.ts';

export interface OpenOffer {
  id: string;
  terms: SwapTerms;
  /** The nullifiers of the coins the offer spends, hex. */
  nullifiers: string[];
  madeAt: Date;
  expiresAt: Date;
}

/** A spend would use coins an open offer of this wallet's holds, cancelling it. */
export class OfferCoinsInUseError extends Error {
  readonly code = 'OFFER_COINS_IN_USE';
  readonly offerIds: string[];
  constructor(offerIds: string[]) {
    super(`This would spend coins held by ${offerIds.length === 1 ? 'an open swap offer' : `${offerIds.length} open swap offers`} (${offerIds.map((id) => `${id.slice(0, 16)}…`).join(', ')}), cancelling ${offerIds.length === 1 ? 'it' : 'them'}. Cancel ${offerIds.length === 1 ? 'it' : 'them'} first, or wait until ${offerIds.length === 1 ? 'it is' : 'they are'} taken.`);
    this.name = 'OfferCoinsInUseError';
    this.offerIds = offerIds;
  }
}

interface StoredLeg { token: string; amount: string }
interface StoredOffer { id: string; terms: { give: StoredLeg; want: StoredLeg }; nullifiers: string[]; madeAt: string; expiresAt: string }

/** The file under the state root `root` holding a wallet's open offers on a network; the wallet by its unshielded address there. */
export function openOffersFile(root: string, network: NetworkName, walletAddress: string): string {
  return join(root, 'swap-offers', network, `${walletAddress}.json`);
}

const leg = (stored: StoredLeg): SwapLeg => ({ token: stored.token, amount: BigInt(stored.amount) });
const stored = (l: SwapLeg): StoredLeg => ({ token: l.token, amount: l.amount.toString() });

/** The wallet's open offers on the network. */
export function readOpenOffers(root: string, network: NetworkName, walletAddress: string): OpenOffer[] {
  const file = readJsonIfPresent<{ offers: StoredOffer[] }>(openOffersFile(root, network, walletAddress));
  return (file?.offers ?? []).map((o) => ({
    id: o.id,
    terms: { give: leg(o.terms.give), want: leg(o.terms.want) },
    nullifiers: o.nullifiers,
    madeAt: new Date(o.madeAt),
    expiresAt: new Date(o.expiresAt),
  }));
}

function writeOpenOffers(root: string, network: NetworkName, walletAddress: string, offers: OpenOffer[]): void {
  writeJsonDurably(openOffersFile(root, network, walletAddress), {
    offers: offers.map((o) => ({
      id: o.id,
      terms: { give: stored(o.terms.give), want: stored(o.terms.want) },
      nullifiers: o.nullifiers,
      madeAt: o.madeAt.toISOString(),
      expiresAt: o.expiresAt.toISOString(),
    })),
  });
}

/** Records an offer the wallet made. */
export function recordOpenOffer(root: string, network: NetworkName, walletAddress: string, offer: OpenOffer): void {
  const offers = readOpenOffers(root, network, walletAddress).filter((o) => o.id !== offer.id);
  writeOpenOffers(root, network, walletAddress, [...offers, offer]);
}

/** Closes the wallet's offers with these ids (taken or cancelled); the ones it had. */
export function closeOpenOffers(root: string, network: NetworkName, walletAddress: string, ids: readonly string[]): OpenOffer[] {
  const offers = readOpenOffers(root, network, walletAddress);
  const closing = offers.filter((o) => ids.includes(o.id));
  if (closing.length > 0) writeOpenOffers(root, network, walletAddress, offers.filter((o) => !ids.includes(o.id)));
  return closing;
}

/** Throws OfferCoinsInUseError when a transaction spending these nullifiers would use an open offer's coins, unless it cancels exactly those offers. */
export function assertSpendsNoOfferCoin(open: readonly OpenOffer[], spent: readonly string[], cancelling: readonly string[] = []): void {
  const spentSet = new Set(spent.map((n) => n.toLowerCase()));
  const hit = open.filter((o) => !cancelling.includes(o.id) && o.nullifiers.some((n) => spentSet.has(n.toLowerCase())));
  if (hit.length > 0) throw new OfferCoinsInUseError(hit.map((o) => o.id));
}
