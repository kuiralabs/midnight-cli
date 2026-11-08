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
import { nodeRefusalOf } from './sdk-errors.ts';

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

/** Fee settings at mn's first margin, for one wallet. */
export function newFeePricing(): FeePricing {
  return { additionalFeeOverhead: DUST_COST_OVERHEAD, feeBlocksMargin: DUST_FEE_MARGIN_STEPS[0]! };
}

/** The margin after `blocks` in DUST_FEE_MARGIN_STEPS; undefined when `blocks` is the last one or past it. */
export function nextFeeMargin(blocks: number): number | undefined {
  return DUST_FEE_MARGIN_STEPS.find((step) => step > blocks);
}

/** Back to the first margin, once a transaction priced with a larger one has gone through. */
export function resetFeeMargin(pricing: FeePricing): void {
  pricing.feeBlocksMargin = DUST_FEE_MARGIN_STEPS[0]!;
}

const OVERSPEND = new RegExp(`custom error:?\\s*${BALANCE_OVERSPEND_ERROR_CODE}\\b`, 'i');

/**
 * Whether the node refused the transaction because the Dust it pays falls
 * short of its fee (error 138): in the node's words under the SDK's submission
 * error (a FiberFailure's included), in a refusal mn already reported as
 * TransactionRefusedError, or in any message among the error's causes.
 */
export function isFeeShortRefusal(err: unknown): boolean {
  const said = nodeRefusalOf(err);
  if (said !== undefined && OVERSPEND.test(said)) return true;
  const seen = new Set<unknown>();
  for (let current: unknown = err; current !== null && typeof current === 'object' && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const { message, reason } = current as { message?: unknown; reason?: unknown };
    if ((typeof message === 'string' && OVERSPEND.test(message)) || (typeof reason === 'string' && OVERSPEND.test(reason))) return true;
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

/** What a paying command says while it runs a payment again after FEE_REPRICED. */
export const RERUN_REPRICED_STATUS = 'The node refused the fee as too low: running it again with the larger margin the wallet now prices with...';

/**
 * Runs `pay`, and again after each failure `rerunAfter` accepts (a payment mn
 * serve answered with FEE_REPRICED: nothing was spent, and its next balance is
 * priced with the larger margin), saying so through `onStatus`. Any other
 * failure is the payment's. `rerunAfter` holds the bound on how many times.
 */
export async function rerunWhenRepriced<T>(pay: () => Promise<T>, rerunAfter: (err: unknown) => boolean, onStatus: (message: string) => void, signal: AbortSignal | undefined): Promise<T> {
  for (;;) {
    throwIfCancelled(signal);
    try {
      return await pay();
    } catch (err) {
      if (!rerunAfter(err)) throw err;
      onStatus(RERUN_REPRICED_STATUS);
    }
  }
}
