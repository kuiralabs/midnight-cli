// A swap offer: the maker's half of a shielded swap, proved and signed, and
// deliberately unbalanced. It spends what the maker gives and pays the maker
// what it wants back, so the ledger accepts it only once a taker adds the
// other half: the wanted tokens in, and the given tokens out to itself.
// Neither side can change the other's terms, and there are no partial fills.
//
// What an offer is comes from its bytes alone: each engine reads them with its
// own ledger (EngineLedger.readOffer). Whether those are the terms the two
// sides agreed is checked here, before the taker builds or spends anything.

/** One side of a swap: a shielded token by its raw type (hex), and how much of it in base units. */
export interface SwapLeg {
  token: string;
  amount: bigint;
}

/** A swap as the maker states it: what the maker gives, and what it wants back. */
export interface SwapTerms {
  give: SwapLeg;
  want: SwapLeg;
}

/** What an offer's bytes say it is. */
export interface OfferContents {
  /** The sha256 of the bytes, hex: short enough for a chat message. */
  id: string;
  terms: SwapTerms;
  /** The nullifiers of the coins it spends, hex: once any of them is on chain, the offer is dead. */
  nullifiers: string[];
}

/** Bytes that are not one shielded swap half: not a sealed ledger-9 transaction, a balanced one, more than two tokens, or unshielded parts. */
export class NotAnOfferError extends Error {
  readonly code = 'NOT_AN_OFFER';
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`Not a swap offer: ${reason}`, options);
    this.name = 'NotAnOfferError';
  }
}

/** An offer whose own terms differ from the terms the two sides agreed. */
export class TermsMismatchError extends Error {
  readonly code = 'TERMS_MISMATCH';
  readonly agreed: SwapTerms;
  readonly offered: SwapTerms;
  constructor(agreed: SwapTerms, offered: SwapTerms) {
    super(`The offer gives ${describeLeg(offered.give)} for ${describeLeg(offered.want)}, not the agreed ${describeLeg(agreed.give)} for ${describeLeg(agreed.want)}`);
    this.name = 'TermsMismatchError';
    this.agreed = agreed;
    this.offered = offered;
  }
}

/** Throws TermsMismatchError unless the offer's own terms are exactly the agreed ones. */
export function checkTerms(offered: SwapTerms, agreed: SwapTerms): void {
  if (!sameLeg(offered.give, agreed.give) || !sameLeg(offered.want, agreed.want)) {
    throw new TermsMismatchError(agreed, offered);
  }
}

/** A leg as a person reads it: the amount, then the token's raw type. */
export function describeLeg(leg: SwapLeg): string {
  return `${leg.amount} of token ${leg.token}`;
}

const sameLeg = (a: SwapLeg, b: SwapLeg) => a.token.toLowerCase() === b.token.toLowerCase() && a.amount === b.amount;
