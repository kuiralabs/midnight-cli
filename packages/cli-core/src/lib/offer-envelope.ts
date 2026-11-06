// The offer file: what a maker hands a taker. The transaction's bytes are the
// offer; around them the envelope says the network, the terms, the id and
// when the maker means the offer to expire, so a taker can see what it is
// before reading the bytes. The bytes stay the truth: a taker reads them with
// its engine and refuses an envelope that says otherwise.
//
// Expiry is mn's own (the chain gives a shielded half swap none): a taker
// using mn refuses an expired offer, and only the maker cancelling it makes
// that binding on chain.

import type { NetworkName } from './network.ts';
import { NotAnOfferError, type OfferContents, type SwapLeg, type SwapTerms } from './swap-offer.ts';

/** What the envelope's `kind` says, so a file is known for an offer at a glance. */
export const OFFER_ENVELOPE_KIND = 'midnight-swap-offer';
/** The envelope's version: a reader refuses one it doesn't know. */
export const OFFER_ENVELOPE_VERSION = 1;

/** An offer as its file holds it. */
export interface OfferEnvelope {
  network: NetworkName;
  id: string;
  terms: SwapTerms;
  /** When the maker means the offer to expire. */
  expiresAt: Date;
  /** The offer: a sealed ledger-9 transaction, hex. */
  tx: string;
}

/** An offer past the expiry its maker set. */
export class OfferExpiredError extends Error {
  readonly code = 'OFFER_EXPIRED';
  constructor(id: string, expiresAt: Date) {
    super(`The offer ${id.slice(0, 16)}… expired at ${expiresAt.toISOString()}; ask the maker for a new one`);
    this.name = 'OfferExpiredError';
  }
}

/** The envelope as its file's text: JSON, amounts as decimal strings. */
export function encodeOfferEnvelope(envelope: OfferEnvelope): string {
  const leg = ({ token, amount }: SwapLeg) => ({ token, amount: amount.toString() });
  return JSON.stringify({
    kind: OFFER_ENVELOPE_KIND,
    version: OFFER_ENVELOPE_VERSION,
    network: envelope.network,
    id: envelope.id,
    terms: { give: leg(envelope.terms.give), want: leg(envelope.terms.want) },
    expiresAt: envelope.expiresAt.toISOString(),
    tx: envelope.tx,
  }, null, 2) + '\n';
}

/** Reads an offer file's text. Throws NotAnOfferError for text that isn't one. */
export function decodeOfferEnvelope(text: string): OfferEnvelope {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new NotAnOfferError('the file is not an offer file (not JSON)');
  }
  if (raw === null || typeof raw !== 'object' || raw.kind !== OFFER_ENVELOPE_KIND) throw new NotAnOfferError('the file is not an offer file');
  if (raw.version !== OFFER_ENVELOPE_VERSION) throw new NotAnOfferError(`the offer file is version ${String(raw.version)}; this mn reads version ${OFFER_ENVELOPE_VERSION}`);
  const text_ = (field: string, value: unknown) => {
    if (typeof value !== 'string' || value === '') throw new NotAnOfferError(`the offer file has no ${field}`);
    return value;
  };
  const leg = (field: string, value: unknown): SwapLeg => {
    const { token, amount } = (value ?? {}) as { token?: unknown; amount?: unknown };
    if (typeof token !== 'string' || !/^[0-9a-fA-F]{64}$/.test(token) || typeof amount !== 'string' || !/^[1-9][0-9]*$/.test(amount)) {
      throw new NotAnOfferError(`the offer file's ${field} is not a token and a whole amount`);
    }
    return { token, amount: BigInt(amount) };
  };
  const terms = (raw.terms ?? {}) as { give?: unknown; want?: unknown };
  const expiresAt = new Date(text_('expiry', raw.expiresAt));
  if (Number.isNaN(expiresAt.getTime())) throw new NotAnOfferError('the offer file\'s expiry is not a date');
  return {
    network: text_('network', raw.network) as NetworkName,
    id: text_('id', raw.id),
    terms: { give: leg('give', terms.give), want: leg('want', terms.want) },
    expiresAt,
    tx: text_('transaction', raw.tx),
  };
}

/** Throws NotAnOfferError when the envelope says other than its bytes, read by the engine, do. */
export function assertEnvelopeMatches(envelope: OfferEnvelope, read: OfferContents): void {
  const legDiffers = (a: SwapLeg, b: SwapLeg) => a.token.toLowerCase() !== b.token.toLowerCase() || a.amount !== b.amount;
  if (envelope.id !== read.id) throw new NotAnOfferError('the offer file\'s id is not its transaction\'s');
  if (legDiffers(envelope.terms.give, read.terms.give) || legDiffers(envelope.terms.want, read.terms.want)) {
    throw new NotAnOfferError('the offer file states other terms than its transaction holds');
  }
}

/** Throws OfferExpiredError once the envelope's expiry has passed. */
export function assertOfferUnexpired(envelope: OfferEnvelope, now: Date): void {
  if (now.getTime() >= envelope.expiresAt.getTime()) throw new OfferExpiredError(envelope.id, envelope.expiresAt);
}
