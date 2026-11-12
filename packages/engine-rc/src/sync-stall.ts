// A wallet sync that has stopped moving: no wallet's progress changed, and
// none of them is connected to the indexer. Against an indexer that is down
// (a gateway answering 502, a socket closed on every connection) the SDK
// retries for as long as it is let, and a write waited out three 120 s sync
// windows before failing with a bare SYNC_TIMEOUT. The watch says when a sync
// has been stalled long enough to ask the indexer whether it serves at all.

import type { FacadeState } from '@midnightntwrk/wallet-sdk/facade';
import type { SyncMode } from './facade.ts';

/** How long a sync may go with no progress and no connection before mn asks the indexer whether it serves. */
export const SYNC_STALL_MS = 30_000;

/** Where a sync stands: its wallets' progress, as one comparable text, and whether any of them is connected. */
export interface SyncPoint {
  readonly progress: string;
  readonly connected: boolean;
}

/** The point the wallets this sync mode reads have reached. */
export function syncPointOf(state: FacadeState, syncMode: SyncMode): SyncPoint {
  const unshielded = state.unshielded.progress;
  const parts = [`u${unshielded.appliedId}/${unshielded.highestTransactionId}`];
  let connected = unshielded.isConnected;
  if (syncMode !== 'no-dust') {
    const dust = state.dust.progress;
    parts.push(`d${dust.appliedIndex}/${dust.highestRelevantWalletIndex}`);
    connected ||= dust.isConnected;
  }
  if (syncMode !== 'lite') {
    const shielded = state.shielded.progress;
    parts.push(`s${shielded.appliedIndex}/${shielded.highestRelevantWalletIndex}`);
    connected ||= shielded.isConnected;
  }
  return { progress: parts.join(' '), connected };
}

/**
 * How long a sync has gone without moving: since the last change of its
 * progress, or since it was last connected, whichever is later. A sync with a
 * wallet connected is not stalled, however long it waits for its next event.
 */
export class SyncStallWatch {
  private lastProgress: string | undefined;
  private movedAt: number;
  private connected = false;

  constructor(startedAt: number) {
    this.movedAt = startedAt;
  }

  /** The sync reached `point` at `at`. */
  observe(point: SyncPoint, at: number): void {
    if (point.progress !== this.lastProgress || point.connected) this.movedAt = at;
    this.lastProgress = point.progress;
    this.connected = point.connected;
  }

  /** Start counting again from `at` (the indexer was asked, and answers). */
  restart(at: number): void {
    this.movedAt = at;
  }

  /** How long, at `at`, the sync has been stalled; 0 while a wallet is connected. */
  stalledFor(at: number): number {
    return this.connected ? 0 : Math.max(0, at - this.movedAt);
  }
}
