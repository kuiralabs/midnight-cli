// Private swaps with offer files, over the wallet session: the maker makes an
// offer and hands its file on; the taker reads the file, checks it, and takes
// it. Everything a taker checks happens before its wallet builds or proves
// anything: that the file is an offer for this network, that its bytes say
// what the file says, that the terms are the agreed ones, that the maker's
// expiry hasn't passed, and that none of its coins is spent.

import { sdkSetOf, sleep, SyncTimeoutError, type SwapLeg, type Engine, type HostEngines, type NetworkConfig, type NetworkName, type WalletSession, UsageError, InsufficientBalanceError, checkTerms, type OfferContents, type SwapTerms, assertEnvelopeMatches, assertOfferUnexpired, decodeOfferEnvelope, encodeOfferEnvelope, type OfferEnvelope, closeOpenOffers, readOpenOffers, recordOpenOffer, type OpenOffer } from '@kuiralabs/midnight-cli-core';
import { spendsOf, type CoinSpend } from '@kuiralabs/midnight-chain';

/** An offer made: its file's text and what it is. */
export interface MadeOffer {
  envelope: OfferEnvelope;
  /** The offer file's text. */
  file: string;
}

/**
 * Makes an offer with the session's wallet: its half of the swap, proved and
 * signed, read back by `engine` (the session network's), and recorded among
 * the wallet's open offers (under the state root `root`) so its later spends
 * don't cancel it unawares.
 */
export async function makeOffer(session: WalletSession, engine: Engine, root: string, walletAddress: string, terms: SwapTerms, expiresAt: Date, now: Date = new Date()): Promise<MadeOffer> {
  const tx = await session.makeOffer(terms.give, terms.want);
  const read = engine.ledger.readOffer(tx);
  const envelope: OfferEnvelope = { network: session.network, id: read.id, terms: read.terms, expiresAt, tx };
  recordOpenOffer(root, session.network, walletAddress, { id: read.id, terms: read.terms, nullifiers: read.nullifiers, madeAt: now, expiresAt });
  return { envelope, file: encodeOfferEnvelope(envelope) };
}

/** How often the wallet is asked whether it holds the coin a split made, in milliseconds. */
export const SPLIT_COIN_POLL_MS = 1_000;
/** How long the wallet has to sync the coin a finalized split made, in milliseconds. */
export const SPLIT_COIN_WAIT_MS = 120_000;

/**
 * Waits until the session's wallet holds a free coin worth exactly `leg`, as
 * it does once it has synced the split that made it. Throws SyncTimeoutError
 * after `waitMs`.
 */
export async function awaitFreeCoin(session: WalletSession, leg: SwapLeg, signal?: AbortSignal, waitMs: number = SPLIT_COIN_WAIT_MS): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!(await session.holdsFreeCoin(leg))) {
    if (Date.now() >= deadline) {
      throw new SyncTimeoutError(`The wallet has not synced the coin the split made within ${Math.round(waitMs / 1000)} s: the split is final, so run the same \`swap make\` again; it makes the offer from that coin.`);
    }
    await sleep(SPLIT_COIN_POLL_MS, signal);
  }
}

/** An offer file read and checked against its own bytes, for this network. */
export interface ReadOffer {
  envelope: OfferEnvelope;
  contents: OfferContents;
}

/** Reads an offer file's text for `network`, with the engine of `engines` the config under the state root `root` gives it. Throws NotAnOfferError for anything that isn't one, or says other than its bytes. */
export async function readOfferFile(root: string, text: string, network: NetworkName, engines: HostEngines): Promise<ReadOffer> {
  const envelope = decodeOfferEnvelope(text);
  if (envelope.network !== network) {
    throw new UsageError(`The offer is for ${envelope.network}, not ${network}: take it on ${envelope.network} (--network ${envelope.network}).`);
  }
  const contents = (await engines.load(sdkSetOf(network, root))).ledger.readOffer(envelope.tx);
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

/** The offer's coins are spent: it was taken, or its maker cancelled it, first. */
export class OfferTakenError extends Error {
  readonly code = 'OFFER_TAKEN';
  /** The transaction that spent the offer's coins (took or cancelled it), and its block. */
  readonly spentIn: { readonly transactionHash: string; readonly blockHeight: number };
  constructor(id: string, spentIn: { readonly transactionHash: string; readonly blockHeight: number }, options: { note?: string } = {}) {
    super(
      `The offer ${id.slice(0, 16)}… is no longer live: its coins were spent in transaction ${spentIn.transactionHash} (block ${spentIn.blockHeight}). `
      + `It was taken, or its maker cancelled it, first.${options.note === undefined ? '' : ` ${options.note}`}`,
    );
    this.name = 'OfferTakenError';
    this.spentIn = { transactionHash: spentIn.transactionHash, blockHeight: spentIn.blockHeight };
    Object.setPrototypeOf(this, OfferTakenError.prototype);
  }
}

/** How long to wait for the indexer to list the spend of an offer's coin once the node refused a transaction spending it, in milliseconds. */
export const SPENT_COIN_WAIT_MS = 15_000;
/** How often the indexer is asked meanwhile, in milliseconds. */
const SPENT_COIN_POLL_MS = 1_000;

/** The codes a node's refusal of a transaction is reported with (the engine's, from the node's words). */
const NODE_REFUSAL_CODES: ReadonlySet<string> = new Set(['TX_REJECTED', 'STALE_UTXO']);

/**
 * Whether the node refused the transaction, in the error or any of its
 * causes: reported with a refusal's code, or in the node's words for a
 * shielded coin spent already (ledger 9's Zswap NullifierAlreadyPresent,
 * "Custom error: 239"). A transaction that lost a race for a coin is refused
 * either at once with those words, or, once in the node's pool, as "invalid"
 * when the other one lands.
 */
export function refusedByNode(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current: unknown = err; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NODE_REFUSAL_CODES.has(code)) return true;
    if (/custom error:\s*239\b/i.test(current.message)) return true;
  }
  return false;
}

/**
 * When the node refused a transaction spending `nullifiers`, the spends of
 * those coins by another transaction, once the indexer lists them (asked
 * every second, up to `waitMs`): the race it lost. Empty for any other
 * failure, and when none of these coins was spent.
 */
export async function spendsAfterRefusal(err: unknown, networkConfig: Pick<NetworkConfig, 'indexer' | 'indexerWS'>, nullifiers: readonly string[], signal?: AbortSignal, waitMs: number = SPENT_COIN_WAIT_MS): Promise<CoinSpend[]> {
  if (!refusedByNode(err)) return [];
  const deadline = Date.now() + waitMs;
  for (;;) {
    const spends = await spendsOf(networkConfig, nullifiers, { signal });
    if (spends.length > 0 || Date.now() >= deadline) return spends;
    await sleep(SPENT_COIN_POLL_MS, signal);
  }
}

/** How much of the shielded token `token` the session's wallet holds. */
export async function shieldedHeld(session: WalletSession, token: string): Promise<bigint> {
  const { shielded } = await session.balances();
  return Object.entries(shielded).reduce((sum, [held, amount]) => (held.toLowerCase() === token.toLowerCase() ? sum + amount : sum), 0n);
}

/** The wallet holds `held` of `leg`'s token, less than `leg` (what `role` names): by how much, and what to do. */
export function shortOf(leg: SwapLeg, held: bigint, role: string): InsufficientBalanceError {
  return new InsufficientBalanceError(`The wallet holds ${held} of the shielded token ${leg.token}, and ${role} ${leg.amount}: it is short by ${leg.amount - held}. Receive more of it first.`);
}

/**
 * Takes an offer with the session's wallet once every check passes: the
 * agreed terms, the expiry, that the offer is live, and that the wallet holds
 * what the maker wants (INSUFFICIENT_BALANCE before anything is proved,
 * naming the token and both amounts). Submits the swap and returns its hash. An offer taken or cancelled first, found before the swap
 * is built or when the node refuses it, is refused with OfferTakenError.
 */
export async function takeOffer(session: WalletSession, offer: ReadOffer, agreed: SwapTerms, networkConfig: NetworkConfig, now: Date = new Date(), signal?: AbortSignal): Promise<string> {
  checkTerms(offer.contents.terms, agreed);
  assertOfferUnexpired(offer.envelope, now);
  const { spends } = await standingOf(offer, networkConfig, now, signal);
  if (spends.length > 0) throw new OfferTakenError(offer.envelope.id, spends[0]!);
  const { want } = offer.contents.terms;
  const held = await shieldedHeld(session, want.token);
  if (held < want.amount) throw shortOf(want, held, 'the offer wants');
  const swap = await session.takeOffer(offer.envelope.tx);
  try {
    return await session.submit(swap);
  } catch (err) {
    // Another taker, or the maker's cancel, reached the node first.
    const spentFirst = await spendsAfterRefusal(err, networkConfig, offer.contents.nullifiers, signal);
    // Not as its cause: mn reports a node's refusal found among an error's causes in place of the error.
    if (spentFirst.length > 0) throw new OfferTakenError(offer.envelope.id, spentFirst[0]!, { note: 'The node refused this swap for it.' });
    throw err;
  }
}

/** An open offer of the wallet's, and whether it has been taken since. */
export interface ListedOffer {
  offer: OpenOffer;
  expired: boolean;
  taken: boolean;
}

/**
 * The wallet's open offers on the network, each asked of the indexer: the
 * ones taken since are closed in mn's record (under the state root `root`)
 * and listed as taken.
 */
export async function listOffers(root: string, network: NetworkName, networkConfig: NetworkConfig, walletAddress: string, now: Date = new Date(), signal?: AbortSignal): Promise<ListedOffer[]> {
  const listed: ListedOffer[] = [];
  for (const offer of readOpenOffers(root, network, walletAddress)) {
    const spends = await spendsOf(networkConfig, offer.nullifiers, { signal });
    listed.push({ offer, expired: now.getTime() >= offer.expiresAt.getTime(), taken: spends.length > 0 });
  }
  const taken = listed.filter((l) => l.taken).map((l) => l.offer.id);
  if (taken.length > 0) closeOpenOffers(root, network, walletAddress, taken);
  return listed;
}

/** No open offer of the wallet's has that id. */
export class NoSuchOfferError extends UsageError {
  constructor(id: string) {
    super(`This wallet has no open offer ${id} on this network: midnight swap list shows its open offers.`);
    this.name = 'NoSuchOfferError';
  }
}

/** The shortest prefix of an offer's id that names it. */
export const OFFER_ID_MIN_PREFIX = 8;

/**
 * The wallet's open offer on `network` that `id` names (the whole id, or a
 * prefix of OFFER_ID_MIN_PREFIX hex characters at least), from mn's record
 * under the state root `root` alone: no wallet opens. Refuses an id that is
 * not hex or too short, and one that names no open offer, or more than one.
 */
export function findOpenOffer(root: string, network: NetworkName, walletAddress: string, id: string): OpenOffer {
  if (!/^[0-9a-fA-F]+$/.test(id) || id.length > 64) throw new UsageError(`An offer's id is hex, 64 characters at most (midnight swap list shows them), not "${id.length > 64 ? id.slice(0, 64) + '…' : id}"`);
  if (id.length < OFFER_ID_MIN_PREFIX) throw new UsageError(`Give at least ${OFFER_ID_MIN_PREFIX} characters of the offer's id, not ${id.length}: midnight swap list shows them`);
  const wanted = id.toLowerCase();
  const matches = readOpenOffers(root, network, walletAddress).filter((o) => o.id.startsWith(wanted));
  if (matches.length === 0) throw new NoSuchOfferError(id);
  if (matches.length > 1) throw new UsageError(`${id} names ${matches.length} open offers: give more of the id`);
  return matches[0]!;
}

/** The offer is one of the taking wallet's own open offers: taking it would swap the wallet's coins with itself. */
export class OwnOfferError extends UsageError {
  constructor(id: string) {
    super(`The offer ${id.slice(0, 16)}… is this wallet's own open offer: a wallet can't take its own offer. Take it with another wallet (--wallet), or withdraw it with midnight swap cancel ${id.slice(0, 16)}.`);
    this.name = 'OwnOfferError';
    Object.setPrototypeOf(this, OwnOfferError.prototype);
  }
}

/** What cancelling did: the cancel's transaction, if one was needed, and the offers found already taken with the spends of their coins. */
export interface CancelOutcome {
  txHash: string | undefined;
  cancelled: OpenOffer[];
  alreadyTaken: Array<{ offer: OpenOffer; spends: CoinSpend[] }>;
}

/**
 * Cancels the wallet's open offer with this id (or a prefix of it, 8
 * characters at least): spends its coins back to the wallet, then closes it in
 * mn's record under the state root `root`. An offer found taken already is
 * only closed.
 */
export async function cancelOffer(session: WalletSession, root: string, networkConfig: NetworkConfig, walletAddress: string, id: string, signal?: AbortSignal): Promise<CancelOutcome> {
  const offer = findOpenOffer(root, session.network, walletAddress, id);
  const takenWith = (spends: CoinSpend[]): CancelOutcome => {
    closeOpenOffers(root, session.network, walletAddress, [offer.id]);
    return { txHash: undefined, cancelled: [], alreadyTaken: [{ offer, spends }] };
  };
  const spends = await spendsOf(networkConfig, offer.nullifiers, { signal });
  if (spends.length > 0) return takenWith(spends);
  const cancel = await session.cancelOffers([offer]);
  let txHash: string;
  try {
    txHash = await session.submit(cancel);
  } catch (err) {
    // A taker reached the node first.
    const spentFirst = await spendsAfterRefusal(err, networkConfig, offer.nullifiers, signal);
    if (spentFirst.length > 0) return takenWith(spentFirst);
    throw err;
  }
  closeOpenOffers(root, session.network, walletAddress, [offer.id]);
  return { txHash, cancelled: [offer], alreadyTaken: [] };
}
