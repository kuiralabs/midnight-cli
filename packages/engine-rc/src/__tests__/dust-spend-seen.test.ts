// awaitDustSpendSeen: after a payment's Dust was spent first by another
// transaction of the wallet's, the rebuild waits until the wallet no longer
// holds the coin it paid with. States are plain values in the SDK's shape.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as rx from 'rxjs';
import { CancelledError } from '@kuiralabs/midnight-cli-core';
import { awaitDustSpendSeen, pendingDustNonces } from '../dust-spend-seen.ts';

/** A wallet state holding Dust coins `free` and `pending`, by nonce. */
const holding = (free: bigint[], pending: bigint[] = []) => ({
  dust: { availableCoins: free.map((nonce) => ({ token: { nonce } })), pendingCoins: pending.map((nonce) => ({ token: { nonce } })) },
});

afterEach(() => {
  vi.useRealTimers();
});

describe('awaitDustSpendSeen', () => {
  it('reads the coins a payment pays with from what the wallet holds pending', () => {
    expect(pendingDustNonces(holding([3n], [1n, 2n]))).toEqual([1n, 2n]);
  });

  it('waits while the wallet holds the coin, free again or still pending, and ends once it is gone', async () => {
    const states = new rx.BehaviorSubject(holding([1n]));
    let done = false;
    const seen = awaitDustSpendSeen(states, [1n]).then((value) => { done = true; return value; });
    await Promise.resolve();
    states.next(holding([], [1n]));
    await Promise.resolve();
    expect(done).toBe(false);
    states.next(holding([2n]));
    expect(await seen).toBe(true);
  });

  it('ends at once when the wallet had already seen the spend, or the payment paid with no Dust', async () => {
    expect(await awaitDustSpendSeen(rx.of(holding([2n])), [1n])).toBe(true);
    expect(await awaitDustSpendSeen(rx.NEVER, [])).toBe(true);
  });

  it('gives up past its time, false, so the caller builds it again anyway', async () => {
    vi.useFakeTimers();
    const seen = awaitDustSpendSeen(new rx.BehaviorSubject(holding([1n])), [1n], { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await seen).toBe(false);
  });

  it('stops with CancelledError when cancelled', async () => {
    const cancel = new AbortController();
    const seen = awaitDustSpendSeen(new rx.BehaviorSubject(holding([1n])), [1n], { signal: cancel.signal });
    cancel.abort();
    await expect(seen).rejects.toBeInstanceOf(CancelledError);
  });
});
