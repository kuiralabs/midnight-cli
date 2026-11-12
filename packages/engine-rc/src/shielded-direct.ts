// Direct-from-indexer shielded (zswap) balance reader.
//
// Bypasses the shielded-wallet SDK facade (minutes-to-hours + 16GB OOM on cold
// hosted syncs). Subscribes to `zswapLedgerEvents(id)` ourselves and folds the
// raw events into a `ZswapLocalState` (shielded-event-fold.ts: ledger-8 events
// with ledger 8, crossing to ledger 9 at the fork as the SDK's shielded wallet
// does) with `replayEventsWithChanges`, which reconciles BOTH received and
// spent coins locally using the full secret keys (the collapsed
// `connect`/`shieldedTransactions` session is encryption-only and cannot see
// spends, so it is not used). Reads the balances off the coin set. Mirrors the
// dust-direct reader's checkpoint/resume shape.
//
// The batched replay keeps the working set bounded (~155MB even on preview),
// unlike the SDK's cold sync.

import { subscribeGraphqlWs } from '@kuiralabs/midnight-chain';
import { ShieldedEventFold, type RawZswapEvent, type ShieldedFoldResult } from './shielded-event-fold.ts';
import { type ShieldedKeys, type ShieldedLedgerState } from './shielded-ledger-state.ts';

// The protocol version tells the fold which ledger reads each event.
const SUBSCRIPTION_QUERY = `
  subscription ZswapLedgerEvents($id: Int) {
    zswapLedgerEvents(id: $id) {
      id
      raw
      maxId
      protocolVersion
    }
  }
`;

/**
 * What a direct read returns. `state` is ledger 9 once the chain's zswap
 * timeline (or tip) is past the fork; a read that stopped before the fork
 * holds a ledger-8 state, which the next read resumes. `lastAppliedEventId` is
 * -1 if no event arrived; `partial` is true iff the sync stopped before
 * catching up to the indexer's tip (timeout or abort), and the state + cursor
 * are still valid to persist and resume from.
 */
export type ShieldedDirectResult = ShieldedFoldResult;

export interface ShieldedDirectOptions {
  /** Called with (eventsApplied, maxIdSeen, lastIdSeen, startFromId) whenever a new event arrives. */
  onProgress?: (eventsApplied: number, maxIdSeen: number, lastIdSeen: number, startFromId: number) => void;
  /**
   * Called after every chunk of events is applied, with the current state + last
   * applied event id. Lets the caller persist a checkpoint so a Ctrl+C / timeout
   * doesn't lose 50k events of work. Keep the callback cheap (a file write is
   * fine, network is not).
   */
  onCheckpoint?: (state: ShieldedLedgerState, lastAppliedEventId: number) => void;
  /**
   * Soft ceiling for the whole subscription. On expiry the call resolves with
   * `partial: true` and whatever state has been applied — never throws away
   * progress. Default: 600s.
   */
  timeoutMs?: number;
  /** If no event arrives for this long (and we've received some), treat as caught up. Default: 5s. */
  idleMs?: number;
  /**
   * If no event is received AT ALL within this window after connecting, treat the
   * stream as empty (nothing to catch up on) and return — but only when resuming
   * from a cached state. Default: 3s.
   */
  initialSilenceMs?: number;
  /** Abort the subscription mid-flight. */
  signal?: AbortSignal;
  /** Resume from this cached state instead of building fresh. */
  initialState?: ShieldedLedgerState;
  /** Subscribe starting at this event id (inclusive). Default: 0. */
  startFromId?: number;
  /**
   * The chain tip's protocol version, read before the subscription opens;
   * null or absent when unknown. A caught-up read on a chain past the fork
   * ends on ledger 9 even with no ledger-9 zswap event yet.
   */
  chainProtocolVersion?: bigint | null;
}

/**
 * Subscribe to zswap ledger events from `startFromId`, fold them into the
 * wallet's shielded state with its secret keys (reconciling receives AND
 * spends), and return the balances plus the state + resume cursor.
 *
 * "Caught up" is detected when the latest `id` received equals `maxId`.
 */
export function readShieldedBalanceDirect(
  keys: ShieldedKeys,
  indexerWS: string,
  options: ShieldedDirectOptions = {},
): Promise<ShieldedDirectResult> {
  const {
    onProgress,
    onCheckpoint,
    timeoutMs = 600_000,
    idleMs = 5_000,
    initialSilenceMs = 3_000,
    signal,
    initialState,
    startFromId = 0,
    chainProtocolVersion,
  } = options;

  // Events are applied in chunks so the final step is cheap, the event loop can
  // breathe between WASM calls, and the working set stays bounded on large
  // chains; each chunk is checkpointed so a timeout/abort doesn't lose the work.
  const fold = new ShieldedEventFold({ keys, initialState, startFromId, onCheckpoint });

  return subscribeGraphqlWs<ShieldedDirectResult>(indexerWS, {
    query: SUBSCRIPTION_QUERY,
    variables: { id: startFromId },
    idleMs,
    timeoutMs,
    // Fast-return only when resuming from cached state; a fresh cold sync must
    // wait for its (possibly slow) first event.
    initialSilenceMs: initialState ? initialSilenceMs : 0,
    signal,
    onNext: (data) => {
      const evt = (data as { zswapLedgerEvents?: RawZswapEvent } | undefined)?.zswapLedgerEvents;
      if (!evt) return false;
      fold.push(evt);
      onProgress?.(fold.eventsSeen, fold.maxIdSeen, fold.lastIdSeen, startFromId);
      // Caught up when we've received the final event in the current stream.
      return fold.caughtUp;
    },
    buildResult: (partial) => {
      try {
        return fold.finish({ partial, chainProtocolVersion });
      } catch (err) {
        throw new Error(`Failed to build shielded state: ${(err as Error).message}`);
      }
    },
  });
}
