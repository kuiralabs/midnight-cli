// A transaction's price before it is proven: what the paying wallet would
// commit to its fee, as the wallet prices it when it balances (the same
// margin, the same choice of Dust coins), against the Dust the wallet has. A
// contract script asks mn serve for it with the transaction midnight-js is
// about to prove (PRICE_TRANSACTION_METHOD, in constants.ts), so a deploy or a call says what
// it costs before anything is proven or sent.

import { PRICE_TRANSACTION_METHOD } from './constants.ts';
import { dustShortfallOf } from './sdk-errors.ts';
import { type DustBalanceSource, LOOK_AHEAD_MS, msUntilDust } from './dust-wait.ts';

/** A transaction's price, in Specks, against the paying wallet's Dust. */
export interface TransactionPrice {
  /** The Dust the wallet commits to the fee: the fee at the chain's prices now, with the wallet's margin, all of it burned. */
  committed: bigint;
  /** The Dust the wallet has. */
  have: bigint;
  /** Whether that covers what it commits. */
  covers: boolean;
  /** How long the wallet's registered NIGHT takes to generate the rest: 0 when it covers already, null when not within a day. */
  waitMs: number | null;
  /** The blocks of rising prices the fee is priced with: the fee at the chain's prices now is `committed` over the ledger's maximum price adjustment to this power. */
  marginBlocks: number;
}

/** A TransactionPrice as it crosses JSON-RPC: the amounts as decimal strings of Specks. */
export interface TransactionPriceWire {
  committed: string;
  have: string;
  covers: boolean;
  waitMs: number | null;
  marginBlocks: number;
}

export function transactionPriceToWire(price: TransactionPrice): TransactionPriceWire {
  return { ...price, committed: price.committed.toString(), have: price.have.toString() };
}

/** The price in `value`, as mn serve answered it; throws when it isn't one. */
export function transactionPriceFromWire(value: unknown): TransactionPrice {
  const wire = (value ?? {}) as Partial<TransactionPriceWire>;
  const specks = (amount: unknown): bigint | undefined => (typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : undefined);
  const committed = specks(wire.committed);
  const have = specks(wire.have);
  const { covers, waitMs, marginBlocks } = wire;
  if (committed === undefined || have === undefined || typeof covers !== 'boolean'
    || !(waitMs === null || (typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs >= 0))
    || typeof marginBlocks !== 'number' || !Number.isInteger(marginBlocks) || marginBlocks < 0) {
    throw new Error(`mn serve answered ${PRICE_TRANSACTION_METHOD} with something that is not a price: ${JSON.stringify(value)}`);
  }
  return { committed, have, covers, waitMs, marginBlocks };
}

/**
 * The price `estimate` gives (the wallet's fee for the transaction with its
 * own Dust spend added), against the Dust `dust` holds at `now`. A wallet
 * whose Dust falls short is refused by the estimate with what the fee takes
 * and what its coins hold (a DustShortfall): that is the price, and the wait
 * is how long the balance takes to grow by the difference (the shortfall is
 * measured on the wallet's clock for the chain, which needn't be this
 * machine's). Any other failure is the estimate's.
 */
export async function priceTransaction(estimate: () => Promise<bigint>, dust: DustBalanceSource, marginBlocks: number, now: Date = new Date()): Promise<TransactionPrice> {
  try {
    const committed = await estimate();
    return { committed, have: dust.balance(now), covers: true, waitMs: 0, marginBlocks };
  } catch (err) {
    const shortfall = dustShortfallOf(err);
    if (shortfall === undefined || shortfall.available >= shortfall.needed) throw err;
    const target = dust.balance(now) + (shortfall.needed - shortfall.available);
    return { committed: shortfall.needed, have: shortfall.available, covers: false, waitMs: msUntilDust(dust, target, now, LOOK_AHEAD_MS), marginBlocks };
  }
}
