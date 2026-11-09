// Waiting, after a payment's Dust was spent first by another transaction of
// the wallet's, until the wallet has seen that spend.
//
// Two payments from one wallet at once (two mn processes, a script and mn, two
// machines with one seed) can pick the same Dust coin. The node takes the
// first and refuses the second: as it arrives (196, DustDoubleSpend) or, when
// both were in its pool, by dropping it as invalid while it builds the block
// that takes the first. The refused one is reverted, so its Dust coin is free
// again in this wallet's view until the wallet syncs the other's spend: built
// again at once it pays with that coin again and is refused again (measured:
// two rebuilds within 2 s of a drop both picked the spent coin). The rebuild
// waits until the coin is gone from the wallet.

import * as rx from 'rxjs';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core';

/** How long a payment refused for Dust spent first waits for the wallet to see that spend before it is built again: a few blocks and the indexer's lag, on any network. */
export const DUST_SPEND_SEEN_WAIT_MS = 60_000;

/** The part of a wallet state the wait reads: its Dust coins, by nonce, pending (a transaction not yet on chain pays with them) and free. */
export interface DustCoinsView {
  dust: {
    readonly pendingCoins: readonly { token: { nonce: bigint } }[];
    readonly availableCoins: readonly { token: { nonce: bigint } }[];
  };
}

/** The Dust coins `state` holds pending, by nonce: the coins its transactions not yet on chain pay with. */
export function pendingDustNonces(state: DustCoinsView): bigint[] {
  return state.dust.pendingCoins.map((coin) => coin.token.nonce);
}

/** Whether `state` still holds any of the Dust coins `nonces`, pending or free. */
function holdsAny(state: DustCoinsView, nonces: ReadonlySet<bigint>): boolean {
  return state.dust.pendingCoins.some((coin) => nonces.has(coin.token.nonce))
    || state.dust.availableCoins.some((coin) => nonces.has(coin.token.nonce));
}

/**
 * Waits until a wallet state from `states` holds none of the Dust coins
 * `paidWith` (the refused payment's, by nonce): the wallet has seen the spend
 * that took them, and the next balance pays with what is still free. True once
 * it has (at once when it had already); false past `timeoutMs`, when the
 * caller builds it again anyway and the node's answer decides. CancelledError
 * when `signal` aborts.
 */
export async function awaitDustSpendSeen<S extends DustCoinsView>(states: rx.Observable<S>, paidWith: readonly bigint[], { timeoutMs = DUST_SPEND_SEEN_WAIT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal | undefined } = {}): Promise<boolean> {
  throwIfCancelled(signal);
  if (paidWith.length === 0) return true;
  const coins = new Set(paidWith);
  const cancelled = signal === undefined ? rx.NEVER : rx.fromEvent(signal, 'abort');
  const seen = await rx.firstValueFrom(
    states.pipe(
      rx.filter((state) => !holdsAny(state, coins)),
      rx.map(() => true),
      rx.timeout({ first: timeoutMs, with: () => rx.of(false) }),
      rx.takeUntil(cancelled),
    ),
    { defaultValue: false },
  );
  throwIfCancelled(signal);
  return seen;
}
