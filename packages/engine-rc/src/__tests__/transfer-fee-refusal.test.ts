// A transfer whose fee the node refuses as too low (error 138). The wallet
// SDK's facade is stubbed at the SDK boundary: it builds, signs and proves
// placeholder transactions, prices a fee with the margin mn's settings hold
// when it is asked, and its submit fails as the SDK's does when the node
// refuses, until the test lets it through.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as rx from 'rxjs';
import { Effect } from 'effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { newFeePricing } from '@kuiralabs/midnight-cli-core/engine';
import { FeeTooLowError } from '@kuiralabs/midnight-cli-core';
import { buildAndSubmitTransfer } from '../transfer.ts';
import { deriveUnshieldedAddress } from '../derive-address.ts';
import type { FacadeBundle } from '../facade.ts';

const DUST = 10n ** 15n;
const T0 = new Date('2026-11-08T06:00:00Z');
const addressOf = (seedByte: number) => MidnightBech32m.parse(deriveUnshieldedAddress(Buffer.alloc(32, seedByte), 'undeployed')).decode(UnshieldedAddress, 'undeployed');
const ONE_PAYMENT = [{ receiverAddress: addressOf(9), amount: 1_000_000n }];

/** The SDK's submit failing as it does when the node refuses the Dust payment as short of the fee. */
const nodeRefusesFee = (): Promise<never> =>
  Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error('1010: Invalid Transaction: Custom error: 138') })));

/** A synced wallet state whose Dust balance at a time is `dust(at)`. */
const syncedState = (dust: (at: Date) => bigint) => {
  const done = { isStrictlyComplete: () => true, appliedIndex: 1n, highestRelevantWalletIndex: 1n };
  return {
    unshielded: { progress: done, availableCoins: [], pendingCoins: [], balances: {} },
    shielded: { progress: done },
    dust: { progress: done, balance: dust, availableCoins: [{}], address: {} },
  };
};

/**
 * A bundle over the stubbed facade: the wallet's Dust is `dust(at)`; a fee is
 * 0.5 DUST times 1.05 a block of the margin mn's settings hold when it is
 * priced; the first `refusals` submits are refused as too low.
 */
function wallet(dust: (at: Date) => bigint, refusals: number) {
  const feePricing = newFeePricing();
  const builtWith: number[] = [];
  /** The outputs each build was asked for. */
  const builtOutputs: unknown[][] = [];
  let refused = 0;
  const facade = {
    state: () => rx.of(syncedState(dust)),
    transferTransaction: vi.fn(async (transfers: Array<{ outputs: unknown[] }>) => {
      builtWith.push(feePricing.feeBlocksMargin);
      builtOutputs.push(transfers.flatMap((transfer) => transfer.outputs));
      return { recipe: builtWith.length };
    }),
    signRecipe: vi.fn(async (recipe: unknown) => recipe),
    finalizeRecipe: vi.fn(async () => ({ serialize: () => new Uint8Array() })),
    submitTransaction: vi.fn(async () => (refused++ < refusals ? nodeRefusesFee() : 'tx-hash')),
    calculateTransactionFee: vi.fn(async () => (DUST / 2n) * 105n ** BigInt(feePricing.feeBlocksMargin) / 100n ** BigInt(feePricing.feeBlocksMargin)),
  };
  const bundle = { facade, keystore: { signDataAsync: vi.fn() }, feePricing } as unknown as FacadeBundle;
  return { bundle, builtWith, builtOutputs, facade };
}

/** Runs the transfer to its end, letting the fake clock run through its waits. */
async function transfer(bundle: FacadeBundle, statuses: string[], payments = ONE_PAYMENT): Promise<string> {
  const running = buildAndSubmitTransfer(bundle, payments, undefined, undefined, (status) => statuses.push(status));
  let outcome: { value?: string; error?: unknown } | undefined;
  running.then((value) => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
  for (let i = 0; i < 600 && outcome === undefined; i++) await vi.advanceTimersByTimeAsync(1_000);
  if (outcome === undefined) throw new Error('the transfer did not end within ten minutes of fake time');
  if ('error' in outcome) throw outcome.error;
  return outcome.value!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('buildAndSubmitTransfer, when the node refuses the fee as too low', () => {
  it('with Dust that covers it, builds again with the next margin and submits that', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle, builtWith } = wallet(() => 10n * DUST, 1);
    const statuses: string[] = [];

    expect(await transfer(bundle, statuses)).toBe('tx-hash');

    expect(builtWith).toEqual([3, 5]);
    expect(statuses).toContain('The node refused the fee as too low (priced with 3 blocks of margin): pricing it with 5 and submitting again...');
  });

  it('pays several recipients in the transaction it builds again, each output as before', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle, builtWith, builtOutputs } = wallet(() => 10n * DUST, 1);
    const payments = [{ receiverAddress: addressOf(9), amount: 1_000_000n }, { receiverAddress: addressOf(10), amount: 2_500_000n }];

    expect(await transfer(bundle, [], payments)).toBe('tx-hash');

    expect(builtWith).toEqual([3, 5]);
    const outputs = payments.map(({ receiverAddress, amount }) => ({ amount, receiverAddress, type: expect.any(String) }));
    expect(builtOutputs).toEqual([outputs, outputs]);
  });

  it('refused at every margin, fails with FeeTooLowError after pricing with 3, 5 and 8', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle, builtWith } = wallet(() => 10n * DUST, 3);

    const err = await transfer(bundle, []).catch((e: unknown) => e);

    expect(builtWith).toEqual([3, 5, 8]);
    expect(err).toBeInstanceOf(FeeTooLowError);
    expect(err).toMatchObject({ code: 'FEE_TOO_LOW', marginBlocks: 8, fee: 738727721894531n });
  });

  it('with Dust short of the fee, waits for the Dust and builds again with the same margin', async () => {
    vi.useFakeTimers({ now: T0 });
    // 0.5 DUST, growing 0.01 DUST a second: short of the fee priced with 5 blocks (0.638), and 15 s from mn's 0.65 pre-flight threshold.
    const growing = (at: Date) => 500n * DUST / 1000n + BigInt(Math.max(0, Math.floor((at.getTime() - T0.getTime()) / 1000))) * DUST / 100n;
    const { bundle, builtWith } = wallet(growing, 1);
    const statuses: string[] = [];

    expect(await transfer(bundle, statuses)).toBe('tx-hash');

    expect(builtWith).toEqual([3, 3]);
    expect(bundle.feePricing.feeBlocksMargin).toBe(3);
    expect(statuses.some((status) => status === 'Waiting about 15 seconds for Dust to cover the fee (0.500000 of 0.650000 DUST)...')).toBe(true);
    expect(statuses.some((status) => status.startsWith('The node refused the fee as too low'))).toBe(false);
  });
});
