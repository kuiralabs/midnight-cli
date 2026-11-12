// Direct-from-indexer dust balance reader.
//
// Bypasses the dust-wallet SDK's sync machinery (which hangs on preprod due to
// an `isConnected` predicate that never flips for idle wallets). Subscribes to
// `dustLedgerEvents(id: 0)` ourselves and folds the raw events into a Dust
// local state (dust-event-fold.ts: ledger-8 events with ledger 8, migrating to
// ledger 9 at the fork as the SDK's forking Dust wallet does), then reads
// `walletBalance(now)`.
//
// The SDK's dust wallet does the same thing internally — we just don't wait on
// the cosmetic `isConnected` flag.

import { subscribeGraphqlWs } from '@kuiralabs/midnight-chain';
import { DustEventFold, type DustFoldResult, type DustRetention, type RawDustEvent } from './dust-event-fold.ts';
import { type DustKeys, type DustLedgerState } from './dust-ledger-state.ts';

export type { DustRetention } from './dust-event-fold.ts';

// MN_DISABLE_DUST_COLLAPSE=1 disables the dust generation-tree collapse (debugging / safety valve): the repository then passes `collapse: false`, read from its host's settings.

// The protocol version tells the fold which ledger reads each event.
const SUBSCRIPTION_QUERY = `
  subscription DustLedgerEvents($id: Int) {
    dustLedgerEvents(id: $id) {
      type: __typename
      id
      raw
      maxId
      protocolVersion
    }
  }
`;

/**
 * What a direct read returns. `state` is ledger 9 once the chain's Dust
 * timeline (or tip) is past the fork; a partial read that stopped before the
 * fork holds a ledger-8 state, which the next read resumes.
 * `lastAppliedEventId` is -1 if no event arrived; `partial` is true iff the
 * sync stopped before catching up to the indexer's tip (timeout or abort), and
 * the state + cursor are still valid to persist and resume from.
 */
export type DustDirectResult = DustFoldResult;

export interface DustDirectOptions {
  /** Called with (eventsApplied, maxIdSeen, lastIdSeen, startFromId) whenever a new event arrives. */
  onProgress?: (eventsApplied: number, maxIdSeen: number, lastIdSeen: number, startFromId: number) => void;
  /**
   * Called after every chunk of events is applied to the local state, with
   * the current state + last applied event id. Lets the caller persist a
   * checkpoint so a Ctrl+C / timeout doesn't lose 100k events of work.
   * Note: invoked synchronously after `replayEvents`; keep the callback
   * cheap (file write is fine, network is not).
   */
  onCheckpoint?: (state: DustLedgerState, lastAppliedEventId: number, retention: DustRetention) => void;
  /**
   * Soft ceiling for the whole subscription. On expiry the call resolves
   * with `partial: true` and whatever state has been applied so far —
   * never throws away progress. Default: 600s. Set very high to disable.
   */
  timeoutMs?: number;
  /** If no event arrives for this long (and we've received some), treat as caught up. Default: 5s. */
  idleMs?: number;
  /**
   * If no event is received AT ALL within this window after connecting, treat
   * the stream as empty (nothing to catch up on) and return. This lets a
   * cached-resume with zero new events finish quickly instead of waiting on
   * `timeoutMs`. Default: 3s.
   */
  initialSilenceMs?: number;
  /** Abort the subscription mid-flight. */
  signal?: AbortSignal;
  /** Resume from this cached state instead of building fresh. */
  initialState?: DustLedgerState;
  /** Subscribe starting at this event id (inclusive). Default: 0. */
  startFromId?: number;
  /** Retention data from a cached checkpoint, so resume keeps collapsing correctly. */
  initialRetention?: DustRetention;
  /** Collapse foreign generation ranges before checkpoint/return. Default: true. */
  collapse?: boolean;
  /** The network the wallet is on (the migration at the fork carries it). */
  networkId: string;
  /**
   * The chain tip's protocol version, read before the subscription opens;
   * null or absent when unknown. A caught-up read on a chain past the fork
   * ends on ledger 9 even with no ledger-9 Dust event yet.
   */
  chainProtocolVersion?: bigint | null;
}

/**
 * Subscribe to all dust ledger events from `startFromId`, fold them into the
 * Dust state with the wallet's keys, and return the resulting balance plus
 * diagnostics.
 *
 * "Caught up" is detected when the latest `id` received equals `maxId`.
 */
export function readDustBalanceDirect(
  keys: DustKeys,
  indexerWS: string,
  options: DustDirectOptions,
): Promise<DustDirectResult> {
  const {
    onProgress,
    onCheckpoint,
    timeoutMs = 600_000,
    idleMs = 5_000,
    initialSilenceMs = 3_000,
    signal,
    initialState,
    startFromId = 0,
    initialRetention,
    collapse,
    networkId,
    chainProtocolVersion,
  } = options;

  // Events are applied in chunks as they arrive so the final step is cheap and
  // progress stays responsive (replaying 100k events in one synchronous WASM
  // call blocks the event loop for tens of seconds), and each chunk is
  // checkpointed so a timeout/abort doesn't lose the work.
  const fold = new DustEventFold({
    keys,
    networkId,
    initialState,
    initialRetention,
    startFromId,
    collapse: collapse !== false,
    onCheckpoint,
  });

  return subscribeGraphqlWs<DustDirectResult>(indexerWS, {
    query: SUBSCRIPTION_QUERY,
    variables: { id: startFromId },
    idleMs,
    timeoutMs,
    // Fast-return only when resuming from cached state; a fresh cold sync must
    // wait for its (possibly slow) first event.
    initialSilenceMs: initialState ? initialSilenceMs : 0,
    signal,
    onNext: (data) => {
      const evt = (data as { dustLedgerEvents?: RawDustEvent } | undefined)?.dustLedgerEvents;
      if (!evt) return false;
      fold.push(evt);
      onProgress?.(fold.eventsSeen, fold.maxIdSeen, fold.lastIdSeen, startFromId);
      // Caught up when we've received the final event in the current stream.
      return fold.caughtUp;
    },
    buildResult: (partial) => {
      try {
        return fold.finish({ partial, chainProtocolVersion, now: new Date() });
      } catch (err) {
        throw new Error(`Failed to build dust state: ${(err as Error).message}`);
      }
    },
  });
}
