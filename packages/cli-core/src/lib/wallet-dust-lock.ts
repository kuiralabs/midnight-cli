// One payment at a time from a wallet's Dust, across mn processes.
//
// A wallet pays a fee with a Dust coin it picks as it balances, and the coin
// is spent once the transaction is in a block. Two mn processes paying from
// one wallet at once (a transfer and a contract call, or calls of two
// contracts) each see the coin unspent and pick it; the node takes the first
// and refuses the second after its proof is made ("Custom error: 196",
// DustDoubleSpend). A process holds the wallet's Dust lock from balancing to
// submit, so the next one balances once the first's spend is on chain.
//
// It never blocks for long: a holder holds it while it proves and submits
// (under a minute on a local chain), and a process that waited
// DUST_LOCK_WAIT_MS goes ahead without it; a spend that collides is refused
// and built again (DustDoubleSpentError past that).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireProcessLock, holderCommandOf, processIsAlive, type TakenLock } from './process-lock.ts';
import { sleep } from './sleep.ts';
import { formatWait } from './duration.ts';

/** How long a payment waits for the wallet's Dust before it goes ahead without the lock: 2 minutes, a payment ahead's proof and submit and then some. */
export const DUST_LOCK_WAIT_MS = 120_000;

/** The wallet's Dust lock, under mn's state root: one per network and wallet address. */
export function walletDustLockFile(root: string, network: string, address: string): string {
  return path.join(root, 'locks', `dust-${network}-${address}.lock`);
}

/** What a payment waiting for the wallet's Dust says: once as it starts, then how long. */
export interface DustLockSay {
  notice(line: string): void;
  progress(line: string): void;
}

/** A process's hold on a wallet's Dust: taken by `hold` when it isn't held yet, let go by `release`. */
export interface WalletDustLock {
  /** Takes the lock unless this process holds it already; waits for another process's, saying so, at most DUST_LOCK_WAIT_MS. */
  hold(say: DustLockSay, signal?: AbortSignal): Promise<void>;
  /** Lets the lock go, if this process holds it. */
  release(): void;
  /** Whether this process holds it. */
  readonly held: boolean;
}

/** The Dust lock of the wallet whose lock file is `file`, for this process. `timeoutMs` and `now` are for tests. */
export function walletDustLock(file: string, { timeoutMs = DUST_LOCK_WAIT_MS, now = () => Date.now() }: { timeoutMs?: number; now?: () => number } = {}): WalletDustLock {
  let taken: TakenLock | undefined;
  let taking: Promise<void> | undefined;
  const lock: WalletDustLock = {
    get held() { return taken?.held === true; },
    async hold(say, signal) {
      if (taken !== undefined) return;
      // Two balancings of one process at once take it once.
      taking ??= (async () => {
        taken = await acquireProcessLock(
          { fs, join: path.join, dirname: path.dirname, isAlive: processIsAlive, now, sleep },
          file,
          { pid: process.pid, command: holderCommandOf(process.argv) },
          {
            timeoutMs,
            notice: (by) => say.notice(`This wallet's Dust is in use by ${by}, which is paying a fee with it: waiting for it, so the two don't spend the same Dust.`),
            progress: (by, waited) => say.progress(`Waiting for this wallet's Dust, in use by ${by} (${Math.round(waited / 1000)} s)...`),
            timedOut: (by) => {
              say.notice(`Waited ${formatWait(timeoutMs)} for this wallet's Dust, in use by ${by}: going ahead. If both spend the same Dust, the node refuses one and mn builds it again.`);
              return undefined;
            },
            ...(signal === undefined ? {} : { signal }),
          },
        );
        // Gone ahead without it: the next payment tries to take it again.
        if (!taken.held) taken = undefined;
      })().finally(() => { taking = undefined; });
      await taking;
    },
    release() {
      taken?.release();
      taken = undefined;
    },
  };
  return lock;
}
