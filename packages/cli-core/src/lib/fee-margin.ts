// Pricing a fee again when the node refuses it as too low.
//
// The wallet SDK prices a fee before proving, with a margin of blocks of
// rising prices (constants.ts). When prices rise faster than the margin
// covers, or the transaction lands later than usual, the node refuses it:
// "1010: Invalid Transaction: Custom error: 138", the ledger's
// BalanceCheckOverspend, a Dust payment short of the fee. Pricing it again at
// the same margin fails the same way (measured: twelve attempts at no margin,
// all refused), so each new price takes the next, larger margin.
//
// The same refusal also comes when the wallet's Dust does not cover the fee,
// which needs a wait for Dust, not a larger margin: the refused transaction's
// fee is priced again with the next margin and set against the wallet's Dust
// to tell the two apart.

import { BALANCE_OVERSPEND_ERROR_CODE, DUST_COST_OVERHEAD, DUST_FEE_BLOCKS_MARGIN } from './constants.ts';
import { FeeTooLowError, throwIfCancelled } from './errors.ts';
import { DROPPED_FROM_POOL_WORDS, nodeRefusalOf } from './sdk-errors.ts';

/** The margins, in blocks, a fee is priced with in turn: the first, then one more each time the node refuses the fee as too low. */
export const DUST_FEE_MARGIN_STEPS: readonly number[] = [DUST_FEE_BLOCKS_MARGIN, 5, 8];

/**
 * The fee settings the wallet SDK reads each time it prices a fee. The SDK
 * keeps the object it is given and reads `feeBlocksMargin` from it at every
 * price, so raising it here changes the next price, not the wallet.
 */
export interface FeePricing {
  readonly additionalFeeOverhead: bigint;
  feeBlocksMargin: number;
}

/**
 * How long a margin raised after a refused fee holds: 10 minutes. Every payment
 * of the command that met the refusal goes at it (a grant deploy's five
 * transactions take about two minutes): going back to the first margin after
 * each one that lands made the next refuse again, and a grant step that a
 * re-run makes again was then made over and over (measured: twelve times).
 */
export const RAISED_MARGIN_HOLD_MS = 10 * 60_000;

/**
 * Fee settings at mn's first margin, for one wallet. A margin set larger
 * holds for RAISED_MARGIN_HOLD_MS from when it was set, then the settings
 * read the first margin again; `now` is the clock that is measured by.
 */
export function newFeePricing(now: () => number = Date.now): FeePricing {
  const first = DUST_FEE_MARGIN_STEPS[0]!;
  let raised: { blocks: number; at: number } | undefined;
  return {
    additionalFeeOverhead: DUST_COST_OVERHEAD,
    get feeBlocksMargin(): number {
      if (raised !== undefined && now() - raised.at < RAISED_MARGIN_HOLD_MS) return raised.blocks;
      raised = undefined;
      return first;
    },
    set feeBlocksMargin(blocks: number) {
      raised = blocks === first ? undefined : { blocks, at: now() };
    },
  };
}

/** The margin after `blocks` in DUST_FEE_MARGIN_STEPS; undefined when `blocks` is the last one or past it. */
export function nextFeeMargin(blocks: number): number | undefined {
  return DUST_FEE_MARGIN_STEPS.find((step) => step > blocks);
}

/** Back to the first margin: a command that raised it is done. */
export function resetFeeMargin(pricing: FeePricing): void {
  pricing.feeBlocksMargin = DUST_FEE_MARGIN_STEPS[0]!;
}

const OVERSPEND = new RegExp(`custom error:?\\s*${BALANCE_OVERSPEND_ERROR_CODE}\\b`, 'i');
/** The ledger's DustDoubleSpend: the Dust coin a transaction spends was spent by another first. */
export const DUST_DOUBLE_SPEND_ERROR_CODE = 196;
const DOUBLE_SPEND = new RegExp(`custom error:?\\s*${DUST_DOUBLE_SPEND_ERROR_CODE}\\b`, 'i');

/**
 * Whether the node refused the transaction because the Dust it pays falls
 * short of its fee (error 138): in the node's words under the SDK's submission
 * error (a FiberFailure's included), in a refusal mn already reported as
 * TransactionRefusedError, or in any message among the error's causes.
 */
export function isFeeShortRefusal(err: unknown): boolean {
  return refusalSays(err, OVERSPEND);
}

/** Whether the node refused the transaction because another spent its Dust coin first (error 196), anywhere in the error's causes. */
export function isDustDoubleSpendRefusal(err: unknown): boolean {
  return refusalSays(err, DOUBLE_SPEND);
}

/**
 * Whether the node took the transaction into its pool and then dropped it as
 * invalid while building a block, anywhere in the error's causes. A Midnight
 * node validates a transaction against the latest block as it arrives, so one
 * that is valid then and dropped later conflicts with a transaction the block
 * took first: two from one wallet in the pool at once, spending the same Dust
 * or coin (the node logs "Rejecting transaction ... at pre-dispatch: ...
 * double spend", and tells the submitter only that it is invalid).
 */
export function isDroppedFromPool(err: unknown): boolean {
  return refusalSays(err, DROPPED_FROM_POOL_WORDS);
}

/** Whether the node's words, or a message or reason among the error's causes, match `pattern`. */
function refusalSays(err: unknown, pattern: RegExp): boolean {
  const said = nodeRefusalOf(err);
  if (said !== undefined && pattern.test(said)) return true;
  const seen = new Set<unknown>();
  for (let current: unknown = err; current !== null && typeof current === 'object' && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const { message, reason } = current as { message?: unknown; reason?: unknown };
    if ((typeof message === 'string' && pattern.test(message)) || (typeof reason === 'string' && pattern.test(reason))) return true;
  }
  return false;
}

/** The refused transaction's fee as the wallet prices it now, and the Dust the wallet holds now, both in Specks. */
export interface FeeRefusalCheck {
  fee: bigint;
  dust: bigint;
}

/** What follows a refused fee: priced again with a larger margin, or a wait for Dust. */
export type FeeRefusalStep =
  | { kind: 'repriced'; fromBlocks: number; toBlocks: number }
  | { kind: 'dust-short'; fee: bigint; dust: bigint };

/**
 * After the node refused a fee as too low (isFeeShortRefusal): moves `pricing`
 * to the next margin and asks `check` for the refused transaction's fee priced
 * with it, and the wallet's Dust. Dust that covers it: the fee was priced too
 * low, and the caller builds the transaction again ('repriced'). Dust that
 * doesn't: the margin goes back and the caller waits for Dust ('dust-short').
 * Throws FeeTooLowError, with the fee at the last margin, when there is no
 * larger margin to try.
 */
export async function repriceAfterFeeRefusal(pricing: FeePricing, check: () => Promise<FeeRefusalCheck>, refusal: unknown): Promise<FeeRefusalStep> {
  const fromBlocks = pricing.feeBlocksMargin;
  const toBlocks = nextFeeMargin(fromBlocks);
  if (toBlocks !== undefined) pricing.feeBlocksMargin = toBlocks;
  let checked: FeeRefusalCheck;
  try {
    checked = await check();
  } catch (err) {
    pricing.feeBlocksMargin = fromBlocks;
    throw err;
  }
  const { fee, dust } = checked;
  if (dust < fee) {
    pricing.feeBlocksMargin = fromBlocks;
    return { kind: 'dust-short', fee, dust };
  }
  if (toBlocks === undefined) throw new FeeTooLowError(fee, fromBlocks, { cause: refusal });
  return { kind: 'repriced', fromBlocks, toBlocks };
}

/** What a paying path says while it prices a refused fee again. */
export function repricingStatus(step: { fromBlocks: number; toBlocks: number }): string {
  return `The node refused the fee as too low (priced with ${step.fromBlocks} blocks of margin): pricing it with ${step.toBlocks} and submitting again...`;
}

/** The code mn serve refuses a submit with when the node refused its fee as too low and it now prices with a larger margin (FeeRepricedError). */
export const FEE_REPRICED_CODE = 'FEE_REPRICED';

/** The code of a fee refused as too low past the largest margin (FeeTooLowError). */
export const FEE_TOO_LOW_CODE = 'FEE_TOO_LOW';

/** Whether `err` is mn serve's FEE_REPRICED, by the code it carries. */
export function isFeeRepriced(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === FEE_REPRICED_CODE;
}

/** The code of a payment refused because another transaction from the wallet spent its Dust first (DustDoubleSpentError). */
export const DUST_DOUBLE_SPENT_CODE = 'DUST_DOUBLE_SPENT';

/** Whether `err` is a DUST_DOUBLE_SPENT refusal, by the code it carries. */
export function isDustDoubleSpent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === DUST_DOUBLE_SPENT_CODE;
}

/** What a paying command says while it runs a payment again after FEE_REPRICED. */
export const RERUN_REPRICED_STATUS = 'The node refused the fee as too low: running it again with the larger margin the wallet now prices with...';

/** What a paying command says while it runs a payment again after DUST_DOUBLE_SPENT. */
export const RERUN_DOUBLE_SPENT_STATUS = 'Another transaction from this wallet spent the same Dust first: running it again, paying with Dust that is still free...';

/** How many times a payment is built again after its Dust (or coin) was spent by another transaction of the wallet's. */
export const DUST_DOUBLE_SPEND_RETRIES = 2;

/** The code of a payment the node dropped from its pool as invalid, as another transaction from the wallet spent its Dust or coin first (TransactionInvalidatedError). */
export const TX_INVALIDATED_CODE = 'TX_INVALIDATED';

/** Whether `err` is a TX_INVALIDATED refusal, by the code it carries. */
export function isTxInvalidated(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === TX_INVALIDATED_CODE;
}

/** What a paying command says while it runs a payment again after TX_INVALIDATED. */
export const RERUN_INVALIDATED_STATUS = 'The node dropped it: another transaction from this wallet spent the same Dust or coin first. Running it again with what is still free...';

/** Whether a payment that failed with `err` had its Dust or coin spent first by another transaction of the wallet's (DUST_DOUBLE_SPENT, TX_INVALIDATED): nothing of it was spent, and run again it pays with what is still free. */
export function isSpentFirst(err: unknown): boolean {
  return isDustDoubleSpent(err) || isTxInvalidated(err);
}

/** What a paying command says while it runs a payment again after `err` (isSpentFirst). */
export function rerunSpentFirstStatus(err: unknown): string {
  return isTxInvalidated(err) ? RERUN_INVALIDATED_STATUS : RERUN_DOUBLE_SPENT_STATUS;
}

/**
 * Runs `pay`, and again after each failure `rerunAfter` accepts (a payment mn
 * serve answered with FEE_REPRICED: nothing was spent, and its next balance is
 * priced with the larger margin), saying so through `onStatus`. Any other
 * failure is the payment's. `rerunAfter` holds the bound on how many times.
 */
export async function rerunWhenRepriced<T>(pay: () => Promise<T>, rerunAfter: (err: unknown) => boolean, onStatus: (message: string) => void, signal: AbortSignal | undefined, statusOf: (err: unknown) => string = () => RERUN_REPRICED_STATUS): Promise<T> {
  for (;;) {
    throwIfCancelled(signal);
    try {
      return await pay();
    } catch (err) {
      if (!rerunAfter(err)) throw err;
      onStatus(statusOf(err));
    }
  }
}
