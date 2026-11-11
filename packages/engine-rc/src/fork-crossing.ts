// Waiting for a wallet's three wallets to be past the chain's fork to ledger 9
// before a transaction is built, and saying why one isn't.
//
// The facade acts at the lowest of its wallets' protocol versions, so a write
// on a chain past the fork needs all three there. A sync that ended can still
// leave one behind for a moment: the unshielded wallet's version signal comes
// in the update after its progress, and a wallet the SDK started on ledger 8
// crosses as it reads the chain past the fork. Those cross while mn waits; one
// that doesn't within the wait is reported with its reason (a read of its
// history that failed or ran out of time, a checkpoint the SDK refused).

import * as rx from 'rxjs';
import { CancelledError, WalletBehindForkError, carriesOwnCode, throwIfCancelled, walletsBehindForkMessage, type WalletBehindFork, type WalletPart } from '@kuiralabs/midnight-cli-core';
import { FORK_SCHEDULE } from './fork-schedule.ts';

/** How long a write waits for its wallets to cross the fork after the sync. */
export const FORK_CROSSING_WAIT_MS = 60_000;

/** What reading a wallet's history first did, for the shielded and Dust wallets (absent: not read, or read in full). */
export interface PrimeReport {
  shielded?: { failure?: Error; partial?: { lastAppliedEventId: number; maxId: number } };
  dust?: { failure?: Error; partial?: boolean };
  /** The shielded checkpoint the SDK wouldn't restore, and why. */
  shieldedCheckpointRefused?: Error;
}

/** The protocol versions a facade state reports for its three wallets. */
export interface WalletVersions {
  protocolVersion: Readonly<Record<WalletPart, bigint>>;
}

const PARTS: readonly WalletPart[] = ['shielded', 'unshielded', 'dust'];

/** The wallets of `state` still below the fork. */
function behindFork(state: WalletVersions): WalletPart[] {
  return PARTS.filter((wallet) => state.protocolVersion[wallet] < FORK_SCHEDULE.v9);
}

/** Why `wallet` is still below the fork, from what reading its history first did. */
function reasonFor(wallet: WalletPart, report: PrimeReport): string {
  if (wallet === 'unshielded') return "the indexer hasn't reported a ledger-9 version to it yet";
  if (wallet === 'dust') {
    const failure = report.dust?.failure;
    if (failure) return `reading its Dust history first failed: ${failure.message}`;
    if (report.dust?.partial) return 'reading its Dust history first ran out of time; the next run resumes where it stopped';
    return "it is still replaying the chain's Dust history";
  }
  const shielded = report.shielded;
  if (shielded?.failure) return `reading its shielded history first failed: ${shielded.failure.message}`;
  if (shielded?.partial) {
    return `reading its shielded history first ran out of time at event ${shielded.partial.lastAppliedEventId} of ${shielded.partial.maxId}; the next run resumes there`;
  }
  if (report.shieldedCheckpointRefused) return `its shielded history was read, but the SDK refused the checkpoint: ${report.shieldedCheckpointRefused.message}`;
  return "it is still replaying the chain's shielded history";
}

/**
 * The failure for the wallets `behind` after `waitedMs`: a failed read of a
 * behind wallet's history that carries a code of its own (a Blockfrost id
 * refused or over its limit, a network error) as it is, since that is what to
 * fix; else WALLET_BEHIND_FORK naming each wallet, its version and its reason,
 * with the first failed read as its cause.
 */
export function forkCrossingFailure(behind: readonly WalletPart[], state: WalletVersions, report: PrimeReport, waitedMs: number): Error {
  const failures = behind.map((wallet) => (wallet === 'shielded' ? report.shielded?.failure : wallet === 'dust' ? report.dust?.failure : undefined)).filter((f): f is Error => f !== undefined);
  const coded = failures.find((failure) => carriesOwnCode(failure));
  if (coded) return coded;
  const wallets: WalletBehindFork[] = behind.map((wallet) => ({ wallet, protocolVersion: state.protocolVersion[wallet], reason: reasonFor(wallet, report) }));
  const cause = failures[0] ?? (behind.includes('shielded') ? report.shieldedCheckpointRefused : undefined);
  return new WalletBehindForkError(walletsBehindForkMessage(wallets, FORK_SCHEDULE.v9, Math.round(waitedMs / 1000)), cause === undefined ? undefined : { cause });
}

/**
 * Resolves once a state from `states` has all three wallets past the fork; the
 * first state that does ends the wait at once. While one is behind, says
 * which every second through `onStatus`; past `timeoutMs` fails with
 * forkCrossingFailure for the wallets still behind. A cancel ends it with
 * CancelledError.
 */
export function awaitWalletsPastFork(
  states: rx.Observable<WalletVersions>,
  options: { report: PrimeReport; timeoutMs?: number; onStatus?: (status: string) => void; signal?: AbortSignal },
): Promise<void> {
  const { report, timeoutMs = FORK_CROSSING_WAIT_MS, onStatus, signal } = options;
  throwIfCancelled(signal);
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    let latest: WalletVersions | undefined;
    let settled = false;
    let subscription: rx.Subscription | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      clearInterval(ticker);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve();
    };
    const onAbort = () => finish(new CancelledError());
    const check = () => {
      if (latest === undefined) return;
      const behind = behindFork(latest);
      if (behind.length === 0) return finish();
      const waited = Date.now() - started;
      if (waited >= timeoutMs) return finish(forkCrossingFailure(behind, latest, report, waited));
      onStatus?.(`Waiting for the ${behind.join(' and ')} wallet to sync past the chain's fork to ledger 9 (${Math.round(waited / 1000)} s)...`);
    };
    const ticker = setInterval(check, 1_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    subscription = states.subscribe({
      next: (state) => {
        latest = state;
        if (behindFork(state).length === 0) finish();
      },
      error: (err) => finish(err as Error),
    });
    // A state the observable had at hand ended the wait while it subscribed.
    if (settled) subscription.unsubscribe();
  });
}
