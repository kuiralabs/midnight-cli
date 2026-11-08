// The fee settings mn gives the wallet SDK, and what follows when the node
// refuses a fee as too low. The check after a refusal (the refused fee priced
// again, the wallet's Dust) is the SDK's answer at the interface boundary.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { DUST_COST_OVERHEAD, DUST_FEE_BLOCKS_MARGIN } from '../lib/constants.ts';
import { DUST_FEE_MARGIN_STEPS, RAISED_MARGIN_HOLD_MS, isFeeShortRefusal, newFeePricing, nextFeeMargin, repriceAfterFeeRefusal, repricingStatus, resetFeeMargin } from '../lib/fee-margin.ts';
import { FeeTooLowError, TransactionRefusedError } from '../lib/errors.ts';
import { classifyError, EXIT_TX_REJECTED } from '../lib/exit-codes.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

const DUST = 10n ** 15n;
const NODE_SAYS_138 = '1010: Invalid Transaction: Custom error: 138';

/** The wallet SDK's submit failing with the node's answer, as Effect.runPromise rejects (the cause under a symbol). */
async function sdkRefusal(nodeAnswer: string): Promise<unknown> {
  return Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error(nodeAnswer) }))).catch((err: unknown) => err);
}

describe('the fee settings', () => {
  it('price with no overhead and 3 blocks of margin, then 5, then 8', () => {
    expect(DUST_COST_OVERHEAD).toBe(0n);
    expect(DUST_FEE_BLOCKS_MARGIN).toBe(3);
    expect(DUST_FEE_MARGIN_STEPS).toEqual([3, 5, 8]);
    expect(newFeePricing()).toEqual({ additionalFeeOverhead: 0n, feeBlocksMargin: 3 });
  });

  it('give each wallet its own settings, to raise without touching another', () => {
    const one = newFeePricing();
    one.feeBlocksMargin = 8;
    expect(newFeePricing().feeBlocksMargin).toBe(3);
    resetFeeMargin(one);
    expect(one.feeBlocksMargin).toBe(3);
  });

  it('step to the next larger margin, and to none past the last', () => {
    expect(nextFeeMargin(3)).toBe(5);
    expect(nextFeeMargin(5)).toBe(8);
    expect(nextFeeMargin(8)).toBeUndefined();
    expect(nextFeeMargin(0)).toBe(3);
  });
});

describe('a raised margin', () => {
  it('holds for RAISED_MARGIN_HOLD_MS from when it was raised, then the first margin is read again', () => {
    let clock = 1_000_000;
    const pricing = newFeePricing(() => clock);
    pricing.feeBlocksMargin = 5;
    clock += RAISED_MARGIN_HOLD_MS - 1;
    expect(pricing.feeBlocksMargin).toBe(5);
    clock += 1;
    expect(pricing.feeBlocksMargin).toBe(3);
  });

  it('goes back to the first margin when the command that raised it resets it', () => {
    let clock = 0;
    const pricing = newFeePricing(() => clock);
    pricing.feeBlocksMargin = 8;
    expect(pricing.feeBlocksMargin).toBe(8);
    resetFeeMargin(pricing);
    expect(pricing.feeBlocksMargin).toBe(3);
    clock += 1;
    expect(pricing.feeBlocksMargin).toBe(3);
  });
});

describe('isFeeShortRefusal', () => {
  it("finds the node's error 138 under the SDK's submission error", async () => {
    expect(isFeeShortRefusal(await sdkRefusal(NODE_SAYS_138))).toBe(true);
  });

  it('finds it in a refusal mn reported, and in a message among the causes', () => {
    expect(isFeeShortRefusal(new TransactionRefusedError(NODE_SAYS_138))).toBe(true);
    expect(isFeeShortRefusal(new Error('Transaction submission failed: [SubmissionError] Transaction submission error', { cause: new Error(NODE_SAYS_138) }))).toBe(true);
  });

  it("doesn't take another refusal for it", async () => {
    expect(isFeeShortRefusal(await sdkRefusal('1010: Invalid Transaction: Custom error: 170'))).toBe(false);
    expect(isFeeShortRefusal(await sdkRefusal('1010: Invalid Transaction: Custom error: 1380'))).toBe(false);
    expect(isFeeShortRefusal(new Error('Not enough dust'))).toBe(false);
    expect(isFeeShortRefusal(null)).toBe(false);
  });
});

describe('repriceAfterFeeRefusal', () => {
  /** The refused fee, 0.5 DUST at the margin the settings hold when asked, rising 5% a block; the margins it was asked at. */
  const pricedWith = (pricing: { feeBlocksMargin: number }, dust: bigint) => {
    const asked: number[] = [];
    const check = async () => {
      asked.push(pricing.feeBlocksMargin);
      return { fee: (DUST / 2n) * 105n ** BigInt(pricing.feeBlocksMargin) / 100n ** BigInt(pricing.feeBlocksMargin), dust };
    };
    return { asked, check };
  };

  it('with Dust that covers the fee at the next margin, moves to that margin', async () => {
    const pricing = newFeePricing();
    const { asked, check } = pricedWith(pricing, DUST);

    expect(await repriceAfterFeeRefusal(pricing, check, new Error(NODE_SAYS_138))).toEqual({ kind: 'repriced', fromBlocks: 3, toBlocks: 5 });
    expect(asked).toEqual([5]);
    expect(pricing.feeBlocksMargin).toBe(5);
    expect(repricingStatus({ fromBlocks: 3, toBlocks: 5 })).toBe('The node refused the fee as too low (priced with 3 blocks of margin): pricing it with 5 and submitting again...');
  });

  it("with Dust that doesn't cover it, keeps the margin and leaves it to the Dust wait", async () => {
    const pricing = newFeePricing();
    const { check } = pricedWith(pricing, DUST / 2n);

    expect(await repriceAfterFeeRefusal(pricing, check, new Error(NODE_SAYS_138))).toEqual({ kind: 'dust-short', fee: 638140781250000n, dust: DUST / 2n });
    expect(pricing.feeBlocksMargin).toBe(3);
  });

  it('past the largest margin, fails with the fee and the margin, as a refusal', async () => {
    const pricing = newFeePricing();
    pricing.feeBlocksMargin = 8;
    const { check } = pricedWith(pricing, DUST);
    const refusal = new Error(NODE_SAYS_138);

    const err = await repriceAfterFeeRefusal(pricing, check, refusal).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FeeTooLowError);
    expect(err).toMatchObject({ code: 'FEE_TOO_LOW', fee: 738727721894531n, marginBlocks: 8, cause: refusal });
    expect((err as Error).message).toBe('The node refused the fee as too low (0.738727721894531 DUST, priced with 8 blocks of margin, the most mn tries). '
      + 'Fee prices are rising faster than that margin covers, which happens when blocks are full one after another: wait a minute and run it again.');
    expect(classifyError(err as Error, CORE_CODES)).toEqual({ exitCode: EXIT_TX_REJECTED, errorCode: 'FEE_TOO_LOW' });
  });

  it("puts the margin back when the check can't be made", async () => {
    const pricing = newFeePricing();
    const unreachable = new Error('indexer unreachable');

    await expect(repriceAfterFeeRefusal(pricing, () => Promise.reject(unreachable), new Error(NODE_SAYS_138))).rejects.toBe(unreachable);
    expect(pricing.feeBlocksMargin).toBe(3);
  });
});
