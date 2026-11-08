// Pricing a dApp's contract call with its real proofs.
//
// The wallet SDK prices a fee before its own Dust spends are proven, so it
// erases the proofs of every transaction it balances and merges them into one
// (Transacting.js, mergeErasedTransactions: `transactions.map((tx) =>
// tx.eraseProofs())`) and prices that (calculateFee, feesWithMargin). A
// proof-erased transaction's size is estimated: its bytes, plus 4832 bytes for
// each contract call's proof (the ledger's PROOF_SIZE, a zswap input proof's
// size), whatever the circuit. A dApp's call arrives proven, though (midnight-js
// proves before it asks the wallet to balance), and its real size is known: a
// grant call's proof is 6364 bytes, a counter's 3852. The estimate for the grant
// call came out 13% under its fee, more than the margin covers.
//
// The difference is in one cost dimension only, the bytes of block space, so
// the fee of the erased transaction is priced again with that dimension
// corrected: the erased transaction's cost with its block usage set to what the
// proven proofs make it, through the chain's own fee prices.

import * as ledger from '@midnightntwrk/ledger-v9';

/** What can be priced: the ledger's transactions, of any proof kind. */
interface Priced {
  cost(params: ledger.LedgerParameters, enforceTimeToDismiss?: boolean): ledger.SyntheticCost;
  eraseProofs(): Priced;
}

/** The bytes of block space a transaction takes as the ledger estimates it: real for a proven one, estimated for a proof-erased one. */
const blockUsageOf = (tx: Priced, params: ledger.LedgerParameters): bigint => tx.cost(params).blockUsage;

/**
 * The bytes the proof-erased pricing of `transactions` leaves out (a negative
 * number when their proofs are smaller than it assumes): for each proven
 * transaction, its block usage less its proof-erased one's. Zero for one whose
 * proofs are not made yet (the erased estimate is all there is).
 */
export function proofBytesUnpriced(transactions: readonly Priced[], params: ledger.LedgerParameters): bigint {
  let missed = 0n;
  for (const tx of transactions) missed += blockUsageOf(tx, params) - blockUsageOf(tx.eraseProofs(), params);
  return missed;
}

/** Whether `tx` is proof-erased already: erasing it again changes nothing the ledger prices. */
export function isProofErased(tx: Priced, params: ledger.LedgerParameters): boolean {
  return blockUsageOf(tx, params) === blockUsageOf(tx.eraseProofs(), params);
}

/** The chain's price of a normalized cost, as the ledger's FeePrices::overall_cost reckons it (in DUST). */
function overallCost(params: ledger.LedgerParameters, cost: ledger.SyntheticCost): number {
  const normalized = params.normalizeFullness(cost);
  const prices = params.feePrices;
  const utilization = Math.max(prices.readFactor * normalized.readTime, prices.computeFactor * normalized.computeTime, prices.blockUsageFactor * normalized.blockUsage);
  return prices.overallPrice * (utilization + prices.writeFactor * normalized.bytesWritten + prices.writeFactor * normalized.bytesChurned);
}

/**
 * `fee`, the price of the proof-erased `erased`, priced again with `extraBytes`
 * more block usage (fewer, when negative): the fee scaled by the chain's price
 * of the corrected cost over its price of the estimated one. The margin and
 * overhead `fee` carries scale with it. Rounded up to the Speck.
 */
export function feeWithBlockUsage(fee: bigint, erased: Priced, params: ledger.LedgerParameters, extraBytes: bigint): bigint {
  if (extraBytes === 0n || fee === 0n) return fee;
  const cost = erased.cost(params);
  const corrected = { ...cost, blockUsage: cost.blockUsage + extraBytes };
  const ratio = overallCost(params, corrected) / overallCost(params, cost);
  // The ratio as parts in 10^12, so the fee (beyond 2^53 Specks) is scaled in bigints.
  const PARTS = 1_000_000_000_000n;
  const scaled = fee * BigInt(Math.ceil(ratio * Number(PARTS)));
  return (scaled + PARTS - 1n) / PARTS;
}
