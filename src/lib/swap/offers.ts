// Private swaps with offer files, over the wallet session: the maker makes an
// offer and hands its file on; the taker reads the file, checks it, and takes
// it. Everything a taker checks happens before its wallet builds or proves
// anything: that the file is an offer for this network, that its bytes say
// what the file says, that the terms are the agreed ones, that the maker's
// expiry hasn't passed, and that none of its coins is spent.

import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import type { NetworkConfig, NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import type { WalletSession } from '@kuiralabs/midnight-cli-core/lib/wallet-session';
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { checkTerms, type OfferContents, type SwapTerms } from '@kuiralabs/midnight-cli-core/lib/swap-offer';
import { assertEnvelopeMatches, assertOfferUnexpired, decodeOfferEnvelope, encodeOfferEnvelope, type OfferEnvelope } from '@kuiralabs/midnight-cli-core/lib/offer-envelope';
import { closeOpenOffers, readOpenOffers, recordOpenOffer, type OpenOffer } from '@kuiralabs/midnight-cli-core/lib/open-offers';
import { spendsOf, type CoinSpend } from '@kuiralabs/midnight-chain/lib/offer-liveness';

/** An offer made: its file's text and what it is. */
export interface MadeOffer {
  envelope: OfferEnvelope;
  /** The offer file's text. */
  file: string;
}

/**
 * Makes an offer with the session's wallet: its half of the swap, proved and
 * signed, recorded among the wallet's open offers so its later spends don't
 * cancel it unawares.
 */
export async function makeOffer(session: WalletSession, walletAddress: string, terms: SwapTerms, expiresAt: Date, now: Date = new Date()): Promise<MadeOffer> {
  const engine = await engineFor(session.network);
  const tx = await session.makeOffer(terms.give, terms.want);
  const read = engine.ledger.readOffer(tx);
  const envelope: OfferEnvelope = { network: session.network, id: read.id, terms: read.terms, expiresAt, tx };
  recordOpenOffer(session.network, walletAddress, { id: read.id, terms: read.terms, nullifiers: read.nullifiers, madeAt: now, expiresAt });
  return { envelope, file: encodeOfferEnvelope(envelope) };
}

/** An offer file read and checked against its own bytes, for this network. */
export interface ReadOffer {
  envelope: OfferEnvelope;
  contents: OfferContents;
}

/** Reads an offer file's text for `network`. Throws NotAnOfferError for anything that isn't one, or says other than its bytes. */
export async function readOfferFile(text: string, network: NetworkName): Promise<ReadOffer> {
  const envelope = decodeOfferEnvelope(text);
  if (envelope.network !== network) {
    throw new UsageError(`The offer is for ${envelope.network}, not ${network}: take it on ${envelope.network} (--network ${envelope.network}).`);
  }
  const contents = (await engineFor(network)).ledger.readOffer(envelope.tx);
  assertEnvelopeMatches(envelope, contents);
  return { envelope, contents };
}

/** Where an offer stands: live, taken (its coins spent), or past its maker's expiry. */
export interface OfferStanding {
  expired: boolean;
  /** The spends of the offer's coins; empty while it is live. */
  spends: CoinSpend[];
}

/** Whether the offer is past its expiry, and whether its coins are spent, asked of the indexer. */
export async function standingOf(offer: ReadOffer, networkConfig: NetworkConfig, now: Date, signal?: AbortSignal): Promise<OfferStanding> {
  const spends = await spendsOf(networkConfig, offer.contents.nullifiers, { signal });
  return { expired: now.getTime() >= offer.envelope.expiresAt.getTime(), spends };
}

/** The offer's coins are spent: it was taken, or its maker cancelled it. */
export class OfferTakenError extends UsageError {
  constructor(id: string, spends: readonly CoinSpend[]) {
    super(`The offer ${id.slice(0, 16)}… is no longer live: its coins were spent in transaction ${spends[0]!.transactionHash} (block ${spends[0]!.blockHeight}). It was taken, or its maker cancelled it.`);
    this.name = 'OfferTakenError';
  }
}

/**
 * Takes an offer with the session's wallet once every check passes: the
 * agreed terms, the expiry, and that the offer is live. Submits the swap and
 * returns its hash.
 */
export async function takeOffer(session: WalletSession, offer: ReadOffer, agreed: SwapTerms, networkConfig: NetworkConfig, now: Date = new Date(), signal?: AbortSignal): Promise<string> {
  checkTerms(offer.contents.terms, agreed);
  assertOfferUnexpired(offer.envelope, now);
  const { spends } = await standingOf(offer, networkConfig, now, signal);
  if (spends.length > 0) throw new OfferTakenError(offer.envelope.id, spends);
  const swap = await session.takeOffer(offer.envelope.tx);
  return session.submit(swap);
}

/** An open offer of the wallet's, and whether it has been taken since. */
export interface ListedOffer {
  offer: OpenOffer;
  expired: boolean;
  taken: boolean;
}

/**
 * The wallet's open offers on the network, each asked of the indexer: the
 * ones taken since are closed in mn's record and listed as taken.
 */
export async function listOffers(network: NetworkName, networkConfig: NetworkConfig, walletAddress: string, now: Date = new Date(), signal?: AbortSignal): Promise<ListedOffer[]> {
  const listed: ListedOffer[] = [];
  for (const offer of readOpenOffers(network, walletAddress)) {
    const spends = await spendsOf(networkConfig, offer.nullifiers, { signal });
    listed.push({ offer, expired: now.getTime() >= offer.expiresAt.getTime(), taken: spends.length > 0 });
  }
  const taken = listed.filter((l) => l.taken).map((l) => l.offer.id);
  if (taken.length > 0) closeOpenOffers(network, walletAddress, taken);
  return listed;
}

/** No open offer of the wallet's has that id. */
export class NoSuchOfferError extends UsageError {
  constructor(id: string) {
    super(`This wallet has no open offer ${id} on this network: midnight swap list shows its open offers.`);
    this.name = 'NoSuchOfferError';
  }
}

/** What cancelling did: the cancel's transaction, if one was needed, and the offers found already taken. */
export interface CancelOutcome {
  txHash: string | undefined;
  cancelled: OpenOffer[];
  alreadyTaken: OpenOffer[];
}

/**
 * Cancels the wallet's open offer with this id (or a prefix of it, 8
 * characters at least): spends its coins back to the wallet, then closes it in
 * mn's record. An offer found taken already is only closed.
 */
export async function cancelOffer(session: WalletSession, networkConfig: NetworkConfig, walletAddress: string, id: string, signal?: AbortSignal): Promise<CancelOutcome> {
  const wanted = id.toLowerCase();
  const matches = readOpenOffers(session.network, walletAddress).filter((o) => wanted.length >= 8 && o.id.startsWith(wanted));
  if (matches.length === 0) throw new NoSuchOfferError(id);
  if (matches.length > 1) throw new UsageError(`${id} names ${matches.length} open offers: give more of the id`);
  const offer = matches[0]!;
  const spends = await spendsOf(networkConfig, offer.nullifiers, { signal });
  if (spends.length > 0) {
    closeOpenOffers(session.network, walletAddress, [offer.id]);
    return { txHash: undefined, cancelled: [], alreadyTaken: [offer] };
  }
  const cancel = await session.cancelOffers([offer]);
  const txHash = await session.submit(cancel);
  closeOpenOffers(session.network, walletAddress, [offer.id]);
  return { txHash, cancelled: [offer], alreadyTaken: [] };
}
