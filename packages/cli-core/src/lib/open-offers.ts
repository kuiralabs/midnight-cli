// The offers a wallet has made and not yet seen taken or cancelled, kept in
// mn's state, and beside them the ones it saw settled (taken, or cancelled),
// for a while, so a later command about one still answers what became of it. An offer's coins are committed to it until then: a later spend
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

/** How an offer stopped being open: its coins spent by another transaction (a taker's, or a cancel from another copy of the wallet), or cancelled by this mn. */
export type OfferSettlement = 'taken' | 'cancelled';

/** An offer the wallet saw settled: when, how, and the transaction that spent its coins when known. */
export interface SettledOffer extends OpenOffer {
  settledBy: OfferSettlement;
  settledAt: Date;
  /** The transaction's identifier (66 hex characters), the txHash mn reports, when known. */
  txHash?: string;
  /** The transaction's hash (64 hex characters), as the indexer lists a spend, when known. */
  hash?: string;
  blockHeight?: number;
}

/** How an offer being closed settled. */
export interface Settlement {
  settledBy: OfferSettlement;
  /** The transaction's identifier (66 hex characters), the txHash mn reports. */
  txHash?: string;
  /** The transaction's hash (64 hex characters). */
  hash?: string;
  blockHeight?: number;
  /** When it was seen settled; the time of the call when not given. */
  at?: Date;
}

/**
 * How long a settled offer is kept: long enough for its maker to come back
 * days later (a cancel, a list) and be told it was taken and by which
 * transaction, short enough that the record of a wallet that trades often
 * stays small (it is read before every spend). Past it the offer is
 * forgotten; its spend is still on chain (midnight tx status).
 */
export const SETTLED_OFFER_KEEP_DAYS = 30;
const SETTLED_OFFER_KEEP_MS = SETTLED_OFFER_KEEP_DAYS * 24 * 60 * 60 * 1000;

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

/** mn's record of a wallet's open offers can't be read: not JSON, or not the shape mn writes. */
export class OfferRecordUnreadableError extends Error {
  readonly code = 'OFFER_RECORD_UNREADABLE';
  /** The record's file. */
  readonly file: string;
  constructor(file: string, detail: string) {
    super(
      `mn can't read its record of this wallet's open swap offers, ${file}: ${detail}. ` +
      'Restore the file if you have a copy of it. Otherwise move it aside: mn then forgets those offers, ' +
      'so it no longer keeps a spend off their coins (spending one cancels its offer), and `swap cancel` can\'t find them; ' +
      'they stay takeable on chain until their coins are spent.',
    );
    this.name = 'OfferRecordUnreadableError';
    this.file = file;
    Object.setPrototypeOf(this, OfferRecordUnreadableError.prototype);
  }
}

interface StoredLeg { token: string; amount: string }
interface StoredOffer { id: string; terms: { give: StoredLeg; want: StoredLeg }; nullifiers: string[]; madeAt: string; expiresAt: string }
// Settled offers are kept under their own key: an mn that predates it reads only `offers`, and never takes a settled one for open.
interface StoredSettled extends StoredOffer { settledBy: OfferSettlement; settledAt: string; txHash?: string; hash?: string; blockHeight?: number }

/** The file under the state root `root` holding a wallet's open offers on a network; the wallet by its unshielded address there. */
export function openOffersFile(root: string, network: NetworkName, walletAddress: string): string {
  return join(root, 'swap-offers', network, `${walletAddress}.json`);
}

const leg = (stored: StoredLeg): SwapLeg => ({ token: stored.token, amount: BigInt(stored.amount) });
const stored = (l: SwapLeg): StoredLeg => ({ token: l.token, amount: l.amount.toString() });

/** The offer `o` as stored, read; throws a message saying what about it is not as mn writes it. */
function readStoredOffer(o: unknown, at: number): OpenOffer {
  const wrong = (what: string): never => { throw new Error(`offer ${at + 1} ${what}`); };
  if (typeof o !== 'object' || o === null) return wrong('is not an object');
  const { id, terms, nullifiers, madeAt, expiresAt } = o as Partial<Record<keyof StoredOffer, unknown>>;
  if (typeof id !== 'string') return wrong('has no id');
  const readLeg = (name: string, value: unknown): SwapLeg => {
    const stored = value as Partial<StoredLeg> | null | undefined;
    if (typeof stored?.token !== 'string' || typeof stored.amount !== 'string' || !/^\d+$/.test(stored.amount)) return wrong(`has no ${name} token and amount`);
    return leg(stored as StoredLeg);
  };
  const t = terms as { give?: unknown; want?: unknown } | null | undefined;
  if (typeof t !== 'object' || t === null) return wrong('has no terms');
  if (!Array.isArray(nullifiers) || !nullifiers.every((n) => typeof n === 'string')) return wrong('has no list of nullifiers');
  const readDate = (name: string, value: unknown): Date => {
    const date = new Date(typeof value === 'string' ? value : Number.NaN);
    return Number.isNaN(date.getTime()) ? wrong(`has no ${name} date`) : date;
  };
  return {
    id,
    terms: { give: readLeg('give', t.give), want: readLeg('want', t.want) },
    nullifiers: nullifiers as string[],
    madeAt: readDate('madeAt', madeAt),
    expiresAt: readDate('expiresAt', expiresAt),
  };
}

/** The settled offer `o` as stored, read; throws a message saying what about it is not as mn writes it. */
function readStoredSettled(o: unknown, at: number): SettledOffer {
  const offer = readStoredOffer(o, at);
  const { settledBy, settledAt, txHash, hash, blockHeight } = o as Partial<Record<keyof StoredSettled, unknown>>;
  const wrong = (what: string): never => { throw new Error(`settled offer ${at + 1} ${what}`); };
  if (settledBy !== 'taken' && settledBy !== 'cancelled') return wrong('says neither taken nor cancelled');
  const when = new Date(typeof settledAt === 'string' ? settledAt : Number.NaN);
  if (Number.isNaN(when.getTime())) return wrong('has no settledAt date');
  if (txHash !== undefined && typeof txHash !== 'string') return wrong('has a txHash that is not text');
  if (hash !== undefined && typeof hash !== 'string') return wrong('has a hash that is not text');
  if (blockHeight !== undefined && typeof blockHeight !== 'number') return wrong('has a blockHeight that is not a number');
  // An mn before 0.6.0's release kept a taken offer's transaction hash (64 hex characters) as its txHash: it is the hash.
  // A cancel's txHash is the identifier its submit returned.
  const isHash = settledBy === 'taken' && txHash !== undefined && /^[0-9a-fA-F]{64}$/.test(txHash);
  const identifier = isHash ? undefined : txHash;
  const transactionHash = hash ?? (isHash ? txHash : undefined);
  return {
    ...offer, settledBy, settledAt: when,
    ...(identifier === undefined ? {} : { txHash: identifier }),
    ...(transactionHash === undefined ? {} : { hash: transactionHash }),
    ...(blockHeight === undefined ? {} : { blockHeight }),
  };
}

interface OfferRecord { open: OpenOffer[]; settled: SettledOffer[] }

/** The wallet's record on the network: its open offers, and the settled ones kept. Throws OfferRecordUnreadableError when it can't be read. */
function readRecord(root: string, network: NetworkName, walletAddress: string): OfferRecord {
  const path = openOffersFile(root, network, walletAddress);
  let stored: unknown;
  try {
    stored = readJsonIfPresent<unknown>(path);
  } catch (err) {
    throw new OfferRecordUnreadableError(path, `it is not JSON (${(err as Error).message})`);
  }
  if (stored === undefined) return { open: [], settled: [] };
  const { offers, settled } = (stored as { offers?: unknown; settled?: unknown } | null) ?? {};
  if (typeof stored !== 'object' || stored === null || !Array.isArray(offers)) {
    throw new OfferRecordUnreadableError(path, 'it holds no list of offers');
  }
  if (settled !== undefined && !Array.isArray(settled)) throw new OfferRecordUnreadableError(path, 'its settled offers are not a list');
  try {
    return { open: offers.map(readStoredOffer), settled: (settled ?? []).map(readStoredSettled) };
  } catch (err) {
    throw new OfferRecordUnreadableError(path, (err as Error).message);
  }
}

/** The wallet's open offers on the network. Throws OfferRecordUnreadableError when mn's record of them can't be read. */
export function readOpenOffers(root: string, network: NetworkName, walletAddress: string): OpenOffer[] {
  return readRecord(root, network, walletAddress).open;
}

/** The offers the wallet saw settled on the network within SETTLED_OFFER_KEEP_DAYS of `now`, oldest first. */
export function readSettledOffers(root: string, network: NetworkName, walletAddress: string, now: Date = new Date()): SettledOffer[] {
  return keptAt(readRecord(root, network, walletAddress).settled, now);
}

function keptAt(settled: readonly SettledOffer[], now: Date): SettledOffer[] {
  return settled.filter((o) => now.getTime() - o.settledAt.getTime() <= SETTLED_OFFER_KEEP_MS);
}

const storedOffer = (o: OpenOffer): StoredOffer => ({
  id: o.id,
  terms: { give: stored(o.terms.give), want: stored(o.terms.want) },
  nullifiers: o.nullifiers,
  madeAt: o.madeAt.toISOString(),
  expiresAt: o.expiresAt.toISOString(),
});

function writeRecord(root: string, network: NetworkName, walletAddress: string, record: OfferRecord): void {
  writeJsonDurably(openOffersFile(root, network, walletAddress), {
    offers: record.open.map(storedOffer),
    settled: record.settled.map((o): StoredSettled => ({
      ...storedOffer(o),
      settledBy: o.settledBy,
      settledAt: o.settledAt.toISOString(),
      ...(o.txHash === undefined ? {} : { txHash: o.txHash }),
      ...(o.hash === undefined ? {} : { hash: o.hash }),
      ...(o.blockHeight === undefined ? {} : { blockHeight: o.blockHeight }),
    })),
  });
}

/** Records an offer the wallet made. */
export function recordOpenOffer(root: string, network: NetworkName, walletAddress: string, offer: OpenOffer): void {
  const record = readRecord(root, network, walletAddress);
  writeRecord(root, network, walletAddress, { open: [...record.open.filter((o) => o.id !== offer.id), offer], settled: record.settled });
}

/**
 * Closes the wallet's offers with these ids (taken or cancelled); the ones it
 * had. With `settlement`, they are kept as settled that way (see
 * SETTLED_OFFER_KEEP_DAYS), and settled ones past their time are forgotten.
 */
export function closeOpenOffers(root: string, network: NetworkName, walletAddress: string, ids: readonly string[], settlement?: Settlement): OpenOffer[] {
  const record = readRecord(root, network, walletAddress);
  const closing = record.open.filter((o) => ids.includes(o.id));
  if (closing.length === 0) return closing;
  const at = settlement?.at ?? new Date();
  const settled = settlement === undefined ? [] : closing.map((o): SettledOffer => ({
    ...o,
    settledBy: settlement.settledBy,
    settledAt: at,
    ...(settlement.txHash === undefined ? {} : { txHash: settlement.txHash }),
    ...(settlement.hash === undefined ? {} : { hash: settlement.hash }),
    ...(settlement.blockHeight === undefined ? {} : { blockHeight: settlement.blockHeight }),
  }));
  writeRecord(root, network, walletAddress, {
    open: record.open.filter((o) => !ids.includes(o.id)),
    settled: [...keptAt(record.settled, at).filter((o) => !ids.includes(o.id)), ...settled],
  });
  return closing;
}

/** Throws OfferCoinsInUseError when a transaction spending these nullifiers would use an open offer's coins, unless it cancels exactly those offers. */
export function assertSpendsNoOfferCoin(open: readonly OpenOffer[], spent: readonly string[], cancelling: readonly string[] = []): void {
  const spentSet = new Set(spent.map((n) => n.toLowerCase()));
  const hit = open.filter((o) => !cancelling.includes(o.id) && o.nullifiers.some((n) => spentSet.has(n.toLowerCase())));
  if (hit.length > 0) throw new OfferCoinsInUseError(hit.map((o) => o.id));
}
