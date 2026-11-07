// Folds the indexer's Dust events into a wallet's Dust local state, across a
// ledger-8 to ledger-9 fork.
//
// Each event's ledger is decided as the wallet SDK's forking Dust wallet
// decides it: by the protocol version the indexer reports the event under. The
// state starts on the ledger of the first event it sees (or of the checkpoint
// it resumes), folds ledger-8 events with ledger 8, and at the first event at
// or above the fork migrates to ledger 9 with the SDK's cross-ledger migration
// (see dust-ledger-state.ts), then folds the rest with ledger 9. A chain whose
// tip is past the fork but whose Dust timeline has no ledger-9 event yet is
// crossed at the end of a caught-up fold, as the SDK's version signal does.
//
// Pure logic: no I/O. The direct reader (dust-direct.ts) feeds it from the
// indexer subscription.

import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import { collapseForeignGenerations } from './dust-collapse.ts';
import {
  crossToLedger9, emptyDustLedgerState, ledgerOfProtocolVersion, processDustTtls,
  type DustKeys, type DustLedger, type DustLedgerState,
} from './dust-ledger-state.ts';

/**
 * Data the collapse needs to keep working correctly across restarts: which
 * generation-tree leaves are ours (must never be collapsed) and how far the
 * tree has grown. Persisted alongside the dust state and fed back on resume.
 */
export interface DustRetention {
  /** Generation-tree indices owned by this wallet. */
  ownedGenerationIndices: number[];
  /** Next-free generation index reached (exclusive upper bound). */
  generationFrontier: number;
}

/** One Dust event as the indexer serves it. */
export interface RawDustEvent {
  id: number;
  /** The serialized event, hex-encoded. */
  raw: string;
  /** The highest Dust event id the indexer holds. */
  maxId: number;
  /** The protocol version the indexer reports the event under; absent when it doesn't say. */
  protocolVersion?: number | null;
}

/** A ledger-8 event arrived after the fold had crossed to ledger 9: the timeline went back across the fork. */
export class DustEventBeforeForkError extends Error {
  constructor(readonly eventId: number, readonly protocolVersion: number) {
    super(
      `Dust event ${eventId} is a ledger-8 event (protocol version ${protocolVersion}), but the Dust state is already on ledger 9. ` +
      'The indexer served the events out of order across the fork; clear the Dust cache (midnight cache clear) and sync again.',
    );
    this.name = 'DustEventBeforeForkError';
    Object.setPrototypeOf(this, DustEventBeforeForkError.prototype);
  }
}

export interface DustEventFoldOptions {
  /** The wallet's Dust secret keys, one per ledger. */
  keys: DustKeys;
  /** The network the wallet is on (the migration carries it). */
  networkId: string;
  /** The checkpoint to resume from; absent for a fold from the start of the timeline. */
  initialState?: DustLedgerState;
  /** The checkpoint's retention data. */
  initialRetention?: DustRetention;
  /** The first event id this fold reads (its cursor is the id before it). */
  startFromId: number;
  /** Collapse foreign generation ranges after each chunk. */
  collapse: boolean;
  /** Called after each chunk is applied, with the state and the id of the last event in it. */
  onCheckpoint?: (state: DustLedgerState, lastAppliedEventId: number, retention: DustRetention) => void;
  /** Events applied per WASM call. Default: 500. */
  chunkSize?: number;
}

/** Where a fold stands when it ends. */
export interface DustFoldEnd {
  /** The fold stopped before the indexer's tip (timeout or abort). */
  partial: boolean;
  /** The protocol version of the chain's tip, read before the events were; null when unknown. */
  chainProtocolVersion?: bigint | null;
  /** The time balances are read at. */
  now: Date;
}

export interface DustFoldResult {
  balance: bigint;
  availableCoins: number;
  eventCount: number;
  ownedUtxoCount: number;
  syncTime: Date;
  state: DustLedgerState;
  retention: DustRetention;
  lastAppliedEventId: number;
  partial: boolean;
}

const DEFAULT_CHUNK_SIZE = 500;

export class DustEventFold {
  private state: DustLedgerState | undefined;
  private readonly pending8: ledgerV8.Event[] = [];
  private readonly pending9: ledgerV9.Event[] = [];
  private ownedGenIndices: Set<bigint>;
  private frontier: bigint;
  private applied = 0;
  private lastEventId: number;
  private maxId = -1;
  private readonly chunkSize: number;

  constructor(private readonly options: DustEventFoldOptions) {
    this.state = options.initialState;
    this.ownedGenIndices = new Set((options.initialRetention?.ownedGenerationIndices ?? []).map(BigInt));
    this.frontier = BigInt(options.initialRetention?.generationFrontier ?? 0);
    this.lastEventId = options.startFromId - 1;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /** Events applied so far plus those waiting for the next chunk. */
  get eventsSeen(): number { return this.applied + this.pending8.length + this.pending9.length; }

  /** The highest Dust event id the indexer reported. */
  get maxIdSeen(): number { return this.maxId; }

  /** The fold has read every event the indexer reported holding. */
  get caughtUp(): boolean { return this.lastEventId >= this.maxId; }

  /** Take one event: decide its ledger, cross the fork if it is the first past it, and queue it. */
  push(event: RawDustEvent): void {
    // An event the indexer reports no version for is read on the state's own
    // ledger, as the SDK reads it.
    const version = event.protocolVersion ?? null;
    const ledger = version !== null ? ledgerOfProtocolVersion(version) : (this.state?.ledgerVersion ?? 9);
    if (this.state === undefined) this.state = emptyDustLedgerState(ledger);
    if (version !== null && ledger !== this.state.ledgerVersion) {
      if (ledger === 8) throw new DustEventBeforeForkError(event.id, version);
      this.crossFork(BigInt(version));
    }

    const bytes = Buffer.from(event.raw, 'hex');
    let content: unknown;
    try {
      if (ledger === 8) {
        const decoded = ledgerV8.Event.deserialize(bytes);
        content = decoded.content;
        this.pending8.push(decoded);
      } else {
        const decoded = ledgerV9.Event.deserialize(bytes);
        content = decoded.content;
        this.pending9.push(decoded);
      }
    } catch (err) {
      throw new Error(`Failed to deserialize dust event ${event.id}: ${(err as Error).message}`);
    }
    this.trackRetention(content);
    this.lastEventId = event.id;
    if (event.maxId > this.maxId) this.maxId = event.maxId;
    if (this.pending8.length + this.pending9.length >= this.chunkSize) this.flush();
  }

  /**
   * Apply the queued events, collapse foreign generations and checkpoint. The
   * cursor is the last queued event's id, so the checkpoint matches the events
   * applied.
   */
  flush(): void {
    if (this.state === undefined || this.pending8.length + this.pending9.length === 0) return;
    const count = this.pending8.length + this.pending9.length;
    try {
      this.state = this.state.ledgerVersion === 8
        ? { ledgerVersion: 8, state: this.state.state.replayEvents(this.options.keys.v8, this.pending8) }
        : { ledgerVersion: 9, state: this.state.state.replayEvents(this.options.keys.v9, this.pending9) };
    } catch (err) {
      throw new Error(`Failed applying dust events: ${(err as Error).message}`);
    }
    this.applied += count;
    this.pending8.length = 0;
    this.pending9.length = 0;
    if (this.options.collapse) this.state = this.collapsed(this.state);
    if (this.options.onCheckpoint && this.lastEventId >= 0) {
      try { this.options.onCheckpoint(this.state, this.lastEventId, this.retention()); } catch { /* best-effort */ }
    }
  }

  /** Apply what is queued and read the result. */
  finish(end: DustFoldEnd): DustFoldResult {
    this.flush();
    let state = this.state ?? emptyDustLedgerState(this.ledgerWithoutEvents(end.chainProtocolVersion));
    // The SDK's version signal: a chain whose tip is past the fork, read to its
    // last Dust event, hands a ledger-8 wallet over even with no ledger-9 event
    // to signal it. The tip was read before the events, so none is left unread.
    if (state.ledgerVersion === 8 && !end.partial && this.caughtUp
      && end.chainProtocolVersion != null && ledgerOfProtocolVersion(end.chainProtocolVersion) === 9) {
      this.state = state;
      this.crossFork(end.chainProtocolVersion);
      state = this.state;
    }
    state = processDustTtls(state, end.now);
    this.state = state;
    const utxos = state.state.utxos.length;
    return {
      balance: state.state.walletBalance(end.now),
      availableCoins: utxos,
      eventCount: this.applied,
      ownedUtxoCount: utxos,
      syncTime: state.state.syncTime,
      state,
      retention: this.retention(),
      lastAppliedEventId: this.lastEventId,
      partial: end.partial,
    };
  }

  /** The ledger of a fold that read no event and resumed nothing: the chain tip's, else ledger 9. */
  private ledgerWithoutEvents(chainProtocolVersion: bigint | null | undefined): DustLedger {
    return chainProtocolVersion != null ? ledgerOfProtocolVersion(chainProtocolVersion) : 9;
  }

  /**
   * Hand the ledger-8 state over to ledger 9: apply what is queued, then take
   * the SDK migration's state. Its generation tree starts empty, so the
   * retention data starts again with it.
   */
  private crossFork(protocolVersion: bigint): void {
    this.flush();
    this.state = crossToLedger9({
      publicKey: this.options.keys.v9.publicKey,
      networkId: this.options.networkId,
      protocolVersion,
      lastAppliedEventId: this.lastEventId,
    });
    this.ownedGenIndices = new Set();
    this.frontier = 0n;
  }

  /** A generation leaf is ours iff its owner is our Dust public key; read before replay consumes the event. */
  private trackRetention(content: unknown): void {
    const c = content as { tag?: string; generationIndex?: bigint; generation?: { owner?: bigint } } | undefined;
    if (c?.tag !== 'dustInitialUtxo' || c.generationIndex === undefined) return;
    const idx = c.generationIndex;
    if (idx + 1n > this.frontier) this.frontier = idx + 1n;
    if (c.generation?.owner === this.options.keys.v9.publicKey) this.ownedGenIndices.add(idx);
  }

  private retention(): DustRetention {
    return { ownedGenerationIndices: [...this.ownedGenIndices].map(Number), generationFrontier: Number(this.frontier) };
  }

  private collapsed(state: DustLedgerState): DustLedgerState {
    return state.ledgerVersion === 8
      ? { ledgerVersion: 8, state: collapseForeignGenerations(state.state, this.ownedGenIndices, this.frontier).state }
      : { ledgerVersion: 9, state: collapseForeignGenerations(state.state, this.ownedGenIndices, this.frontier).state };
  }
}
