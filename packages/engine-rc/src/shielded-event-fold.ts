// Folds the indexer's zswap events into a wallet's shielded local state, across
// a ledger-8 to ledger-9 fork.
//
// Each event's ledger is decided as the wallet SDK's shielded wallet decides
// it: by the protocol version the indexer reports the event under. The state
// starts on the ledger of the first event it sees (or of the checkpoint it
// resumes), replays ledger-8 events with ledger 8, and at the first event at or
// above the fork crosses to ledger 9 whole (see shielded-ledger-state.ts), then
// replays the rest with ledger 9. A chain whose tip is past the fork but whose
// zswap timeline has no ledger-9 event yet is crossed at the end of a
// caught-up fold, as the SDK's version signal does.
//
// Replay uses the full secret keys, so both received and spent coins are
// reconciled. Pure logic: no I/O. The direct reader (shielded-direct.ts) feeds
// it from the indexer subscription.

import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import { ledgerOfProtocolVersion, type LedgerVersion } from './fork-schedule.ts';
import {
  crossShieldedToLedger9, emptyShieldedLedgerState,
  type ShieldedKeys, type ShieldedLedgerState,
} from './shielded-ledger-state.ts';

/** One zswap event as the indexer serves it. */
export interface RawZswapEvent {
  id: number;
  /** The serialized event, hex-encoded. */
  raw: string;
  /** The highest zswap event id the indexer holds. */
  maxId: number;
  /** The protocol version the indexer reports the event under; absent when it doesn't say. */
  protocolVersion?: number | null;
}

/** A ledger-8 event arrived after the fold had crossed to ledger 9: the timeline went back across the fork. */
export class ZswapEventBeforeForkError extends Error {
  constructor(readonly eventId: number, readonly protocolVersion: number) {
    super(
      `Zswap event ${eventId} is a ledger-8 event (protocol version ${protocolVersion}), but the shielded state is already on ledger 9. ` +
      'The indexer served the events out of order across the fork; clear the shielded cache (midnight cache clear) and sync again.',
    );
    this.name = 'ZswapEventBeforeForkError';
    Object.setPrototypeOf(this, ZswapEventBeforeForkError.prototype);
  }
}

export interface ShieldedEventFoldOptions {
  /** The wallet's zswap secret keys, one per ledger. */
  keys: ShieldedKeys;
  /** The checkpoint to resume from; absent for a fold from the start of the timeline. */
  initialState?: ShieldedLedgerState;
  /** The first event id this fold reads (its cursor is the id before it). */
  startFromId: number;
  /** Called after each chunk is applied, with the state and the id of the last event in it. */
  onCheckpoint?: (state: ShieldedLedgerState, lastAppliedEventId: number) => void;
  /** Events applied per WASM call. Default: 500. */
  chunkSize?: number;
}

/** Where a fold stands when it ends. */
export interface ShieldedFoldEnd {
  /** The fold stopped before the indexer's tip (timeout or abort). */
  partial: boolean;
  /** The protocol version of the chain's tip, read before the events were; null when unknown. */
  chainProtocolVersion?: bigint | null;
}

export interface ShieldedFoldResult {
  /** Native (NIGHT) shielded balance in atomic units. */
  balance: bigint;
  /** Number of spendable NIGHT coins tracked. */
  availableCoins: number;
  /** Shielded tokens other than NIGHT, by raw type (sorted), with their balances. */
  tokens: ReadonlyMap<string, bigint>;
  /** Events applied in this fold. */
  eventCount: number;
  /** The final state: ledger 9 once the timeline (or the tip) is past the fork. */
  state: ShieldedLedgerState;
  /** Id of the last event applied. -1 if none arrived. */
  lastAppliedEventId: number;
  partial: boolean;
}

const DEFAULT_CHUNK_SIZE = 500;

/** Sum a state's coins: NIGHT apart, and every other token by its raw type. */
function balancesOf(state: ShieldedLedgerState): { balance: bigint; count: number; tokens: Map<string, bigint> } {
  // Shielded NIGHT coins carry the unshielded raw token type (matches balance.ts / facade).
  const night = state.ledgerVersion === 8 ? ledgerV8.unshieldedToken().raw : ledgerV9.unshieldedToken().raw;
  let balance = 0n;
  let count = 0;
  const tokens = new Map<string, bigint>();
  for (const coin of state.state.coins) {
    if (coin.type === night) {
      balance += coin.value;
      count++;
    } else {
      tokens.set(coin.type, (tokens.get(coin.type) ?? 0n) + coin.value);
    }
  }
  return { balance, count, tokens: new Map([...tokens].sort(([a], [b]) => a.localeCompare(b))) };
}

export class ShieldedEventFold {
  private state: ShieldedLedgerState | undefined;
  private readonly pending8: ledgerV8.Event[] = [];
  private readonly pending9: ledgerV9.Event[] = [];
  private applied = 0;
  private lastEventId: number;
  private maxId = -1;
  private readonly chunkSize: number;

  constructor(private readonly options: ShieldedEventFoldOptions) {
    this.state = options.initialState;
    this.lastEventId = options.startFromId - 1;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /** Events applied so far plus those waiting for the next chunk. */
  get eventsSeen(): number { return this.applied + this.pending8.length + this.pending9.length; }

  /** The highest zswap event id the indexer reported. */
  get maxIdSeen(): number { return this.maxId; }

  /** The fold has read every event the indexer reported holding. */
  get caughtUp(): boolean { return this.lastEventId >= this.maxId; }

  /** Take one event: decide its ledger, cross the fork if it is the first past it, and queue it. */
  push(event: RawZswapEvent): void {
    // An event the indexer reports no version for is read on the state's own
    // ledger, as the SDK reads it.
    const version = event.protocolVersion ?? null;
    const ledger = version !== null ? ledgerOfProtocolVersion(version) : (this.state?.ledgerVersion ?? 9);
    if (this.state === undefined) this.state = emptyShieldedLedgerState(ledger);
    if (version !== null && ledger !== this.state.ledgerVersion) {
      if (ledger === 8) throw new ZswapEventBeforeForkError(event.id, version);
      this.crossFork();
    }

    const bytes = Buffer.from(event.raw, 'hex');
    try {
      if (ledger === 8) this.pending8.push(ledgerV8.Event.deserialize(bytes));
      else this.pending9.push(ledgerV9.Event.deserialize(bytes));
    } catch (err) {
      throw new Error(`Failed to deserialize zswap event ${event.id}: ${(err as Error).message}`);
    }
    // Set before a flush, so the checkpoint cursor matches the events applied
    // (resuming at cursor + 1 must not re-apply one).
    this.lastEventId = event.id;
    if (event.maxId > this.maxId) this.maxId = event.maxId;
    if (this.pending8.length + this.pending9.length >= this.chunkSize) this.flush();
  }

  /** Apply the queued events and checkpoint. The cursor is the last queued event's id. */
  flush(): void {
    if (this.state === undefined || this.pending8.length + this.pending9.length === 0) return;
    const count = this.pending8.length + this.pending9.length;
    try {
      this.state = this.state.ledgerVersion === 8
        ? { ledgerVersion: 8, state: this.state.state.replayEventsWithChanges(this.options.keys.v8, this.pending8).state }
        : { ledgerVersion: 9, state: this.state.state.replayEventsWithChanges(this.options.keys.v9, this.pending9).state };
    } catch (err) {
      throw new Error(`Failed applying zswap events: ${(err as Error).message}`);
    }
    this.applied += count;
    this.pending8.length = 0;
    this.pending9.length = 0;
    if (this.options.onCheckpoint && this.lastEventId >= 0) {
      try { this.options.onCheckpoint(this.state, this.lastEventId); } catch { /* best-effort */ }
    }
  }

  /** Apply what is queued and read the result. */
  finish(end: ShieldedFoldEnd): ShieldedFoldResult {
    this.flush();
    let state = this.state ?? emptyShieldedLedgerState(this.ledgerWithoutEvents(end.chainProtocolVersion));
    // The SDK's version signal: a chain whose tip is past the fork, read to its
    // last zswap event, hands a ledger-8 wallet over even with no ledger-9 event
    // to signal it. The tip was read before the events, so none is left unread.
    if (state.ledgerVersion === 8 && !end.partial && this.caughtUp
      && end.chainProtocolVersion != null && ledgerOfProtocolVersion(end.chainProtocolVersion) === 9) {
      state = crossShieldedToLedger9(state);
    }
    this.state = state;
    const { balance, count, tokens } = balancesOf(state);
    return {
      balance,
      availableCoins: count,
      tokens,
      eventCount: this.applied,
      state,
      lastAppliedEventId: this.lastEventId,
      partial: end.partial,
    };
  }

  /** The ledger of a fold that read no event and resumed nothing: the chain tip's, else ledger 9. */
  private ledgerWithoutEvents(chainProtocolVersion: bigint | null | undefined): LedgerVersion {
    return chainProtocolVersion != null ? ledgerOfProtocolVersion(chainProtocolVersion) : 9;
  }

  /** Hand the ledger-8 state over to ledger 9: apply what is queued (checkpointing it as ledger 8), then cross it whole. */
  private crossFork(): void {
    this.flush();
    if (this.state !== undefined) this.state = crossShieldedToLedger9(this.state);
  }
}
