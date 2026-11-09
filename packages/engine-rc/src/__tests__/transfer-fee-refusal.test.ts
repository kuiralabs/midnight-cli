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
import { DustDoubleSpentError, FeeTooLowError, RERUN_DOUBLE_SPENT_STATUS, RERUN_INVALIDATED_STATUS, TransactionInvalidatedError } from '@kuiralabs/midnight-cli-core';
import { NodeClientError } from '@midnightntwrk/wallet-sdk/node-client/effect';
import { buildAndSubmitTransfer } from '../transfer.ts';
import { deriveUnshieldedAddress } from '../derive-address.ts';
import type { FacadeBundle } from '../facade.ts';

const DUST = 10n ** 15n;
const T0 = new Date('2026-11-08T06:00:00Z');
const addressOf = (seedByte: number) => MidnightBech32m.parse(deriveUnshieldedAddress(Buffer.alloc(32, seedByte), 'undeployed')).decode(UnshieldedAddress, 'undeployed');
const ONE_PAYMENT = [{ receiverAddress: addressOf(9), amount: 1_000_000n }];

/** The SDK's submit failing as it does when the node refuses the Dust payment as short of the fee. */
const nodeRefusesFee = (): Promise<never> => nodeRefuses(138);
/** The SDK's submit failing as it does when the node refuses with `code`: 138 a fee short, 196 Dust another transaction spent first. */
const nodeRefuses = (code: number): Promise<never> =>
  Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error(`1010: Invalid Transaction: Custom error: ${code}`) })));

/** A synced wallet state whose Dust balance at a time is `dust(at)`. */
const syncedState = (dust: (at: Date) => bigint) => {
  const done = { isStrictlyComplete: () => true, appliedIndex: 1n, highestRelevantWalletIndex: 1n };
  return {
    unshielded: { progress: done, availableCoins: [], pendingCoins: [], balances: {} },
    shielded: { progress: done },
    dust: { progress: done, balance: dust, availableCoins: [{}], pendingCoins: [], address: {} },
  };
};

/**
 * A bundle over the stubbed facade: the wallet's Dust is `dust(at)`; a fee is
 * 0.5 DUST times 1.05 a block of the margin mn's settings hold when it is
 * priced; the first `refusals` submits are refused as too low.
 */
function wallet(dust: (at: Date) => bigint, refusals: number, refusalCode = 138) {
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
    submitTransaction: vi.fn(async () => (refused++ < refusals ? nodeRefuses(refusalCode) : 'tx-hash')),
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

  it('with Dust another transaction of the wallet spent first (error 196), builds it again with the same margin', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle, builtWith } = wallet(() => 10n * DUST, 1, 196);
    const statuses: string[] = [];

    expect(await transfer(bundle, statuses)).toBe('tx-hash');

    expect(builtWith).toEqual([3, 3]);
    expect(statuses).toContain(RERUN_DOUBLE_SPENT_STATUS);
  });

  it('with its Dust spent by others three times, fails as DUST_DOUBLE_SPENT after building it again twice', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle, builtWith } = wallet(() => 10n * DUST, 3, 196);

    const err = await transfer(bundle, []).catch((e: unknown) => e);

    expect(builtWith).toEqual([3, 3, 3]);
    expect(err).toBeInstanceOf(DustDoubleSpentError);
    expect(err).toMatchObject({ code: 'DUST_DOUBLE_SPENT', rebuilt: 2 });
    expect((err as Error).message).toContain('Another transaction from this wallet spent the same Dust first');
  });
});

/** The SDK's submit failing as it does when the node took the transaction into its pool and dropped it while building a block. */
const nodeDrops = (): Promise<never> => {
  const invalid = new NodeClientError.TransactionInvalidError({ message: 'Transaction is invalid and was rejected by the node', txData: new Uint8Array([0]) });
  return Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: invalid })));
};

/**
 * A wallet with one Dust coin (nonce 1) that another transaction of the
 * wallet's, sent at the same time by another process, spent first. The stubbed
 * SDK pays each build's fee with the first Dust coin it holds free, marks it
 * pending until the submit ends (reverting it, free again, when the node
 * refuses), and submits to a node that has coin 1 spent: the first submit is
 * `first` (dropped from the pool, or refused with 196), any later one paying
 * with coin 1 is refused with 196. The wallet sees the other's spend
 * `seenAfterMs` after the first refusal: coin 1 gone, its change coin 2 held.
 */
function contestedWallet(first: 'dropped' | 196, seenAfterMs: number) {
  const feePricing = newFeePricing();
  let held = [1n];
  let pending: bigint[] = [];
  const spentOnChain = new Set([1n]);
  const view = () => {
    const done = { isStrictlyComplete: () => true, appliedIndex: 1n, highestRelevantWalletIndex: 1n };
    const coin = (nonce: bigint) => ({ token: { nonce } });
    return {
      unshielded: { progress: done, availableCoins: [], pendingCoins: [], balances: {} },
      shielded: { progress: done },
      dust: { progress: done, balance: () => 10n * DUST, availableCoins: held.filter((n) => !pending.includes(n)).map(coin), pendingCoins: pending.map(coin), address: {} },
    };
  };
  const states = new rx.BehaviorSubject(view());
  const emit = () => states.next(view());
  /** The Dust coin each build paid with. */
  const paidWith: bigint[] = [];
  let submits = 0;
  const facade = {
    state: () => states,
    transferTransaction: vi.fn(async () => {
      const coin = held.find((n) => !pending.includes(n))!;
      pending = [coin];
      paidWith.push(coin);
      emit();
      return { coin };
    }),
    signRecipe: vi.fn(async (recipe: unknown) => recipe),
    finalizeRecipe: vi.fn(async (recipe: { coin: bigint }) => ({ coin: recipe.coin, serialize: () => new Uint8Array() })),
    submitTransaction: vi.fn(async (tx: { coin: bigint }) => {
      try {
        if (!spentOnChain.has(tx.coin)) return 'tx-hash';
        if (submits++ > 0) return await nodeRefuses(196);
        setTimeout(() => { held = [2n]; emit(); }, seenAfterMs);
        return await (first === 'dropped' ? nodeDrops() : nodeRefuses(196));
      } finally {
        pending = [];
        emit();
      }
    }),
    calculateTransactionFee: vi.fn(async () => DUST / 2n),
  };
  const bundle = { facade, keystore: { signDataAsync: vi.fn() }, feePricing } as unknown as FacadeBundle;
  return { bundle, paidWith };
}

describe('buildAndSubmitTransfer, when another transaction of the wallet spent its Dust first', () => {
  it('dropped from the node\'s pool, says so and builds it again once the wallet has seen that spend, paying with the change', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle, paidWith } = contestedWallet('dropped', 5_000);
    const statuses: string[] = [];

    expect(await transfer(bundle, statuses)).toBe('tx-hash');

    expect(paidWith).toEqual([1n, 2n]);
    expect(statuses).toContain(RERUN_INVALIDATED_STATUS);
  });

  it('refused with 196 before the wallet saw the spend, builds it again once it has, not with the same coin', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle, paidWith } = contestedWallet(196, 5_000);
    const statuses: string[] = [];

    expect(await transfer(bundle, statuses)).toBe('tx-hash');

    expect(paidWith).toEqual([1n, 2n]);
    expect(statuses).toContain(RERUN_DOUBLE_SPENT_STATUS);
  });

  it('dropped every time, fails as TX_INVALIDATED after building it again twice', async () => {
    vi.useFakeTimers({ now: T0 });
    const { bundle } = wallet(() => 10n * DUST, 3);
    (bundle.facade.submitTransaction as ReturnType<typeof vi.fn>).mockImplementation(() => nodeDrops());

    const err = await transfer(bundle, []).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionInvalidatedError);
    expect(err).toMatchObject({ code: 'TX_INVALIDATED', rebuilt: 2 });
    expect((err as Error).message).toContain('another transaction from this wallet');
  });
});
