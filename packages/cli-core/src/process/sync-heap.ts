// The heap a cold wallet sync needs, for a host to start its process with.
//
// The first shielded or Dust sync against a hosted network streams the whole
// chain's history through the wallet SDK. Its live working set is small (about
// 300 MB), but the scan allocates a stream of short-lived objects (about
// 8.4 GB on preprod); under Node's default old-space limit (about 4 GB) the
// collector can't keep pace and the process dies with "JavaScript heap out of
// memory" before it writes the cache that makes every later sync cheap.
//
// The limit is fixed when the runtime starts, so a host either starts with it
// (NODE_OPTIONS) or re-runs itself with it before loading the SDK, as mn's
// shell does. This module only says what limit to ask for; it starts nothing.

import v8 from 'node:v8';
import os from 'node:os';
import { SYNC_HEAP_MIN_GAIN_MB, SYNC_HEAP_RAM_FRACTION, SYNC_HEAP_TARGET_MB } from '../lib/constants.ts';

const MB = 1024 * 1024;

export interface SyncHeapTargetOptions {
  /** The machine's memory, in MB. */
  readonly totalMb: number;
  /** The runtime's old-space limit now, in MB. */
  readonly currentLimitMb: number;
  /** The limit wanted, in MB; SYNC_HEAP_TARGET_MB when not given. */
  readonly desiredMb?: number;
  /** The share of the machine's memory the limit may take; SYNC_HEAP_RAM_FRACTION when not given. */
  readonly ramFraction?: number;
  /** How far above the current limit a new one has to be to be worth a restart, in MB; SYNC_HEAP_MIN_GAIN_MB when not given. */
  readonly minGainMb?: number;
}

/**
 * The old-space limit (MB) to start a syncing process with, or null when the
 * current one will do: never more than `ramFraction` of the machine's memory,
 * and never a limit only `minGainMb` or less above the current one.
 */
export function syncHeapTargetMb(opts: SyncHeapTargetOptions): number | null {
  const desired = opts.desiredMb ?? SYNC_HEAP_TARGET_MB;
  const ramFraction = opts.ramFraction ?? SYNC_HEAP_RAM_FRACTION;
  const minGain = opts.minGainMb ?? SYNC_HEAP_MIN_GAIN_MB;

  if (!Number.isFinite(desired) || desired <= 0) return null;
  if (!Number.isFinite(opts.totalMb) || opts.totalMb <= 0) return null;

  const ramCap = Math.floor(opts.totalMb * ramFraction);
  const target = Math.min(Math.floor(desired), ramCap);
  if (target <= opts.currentLimitMb + minGain) return null;
  return target;
}

/** The limit to start a syncing process with, and the NODE_OPTIONS that set it. */
export interface SyncHeapAdvice {
  /** The old-space limit, in MB. */
  readonly maxOldSpaceMb: number;
  /** The flag that sets it, for NODE_OPTIONS or the runtime's arguments: `--max-old-space-size=<MB>`. */
  readonly nodeOptions: string;
}

/**
 * Whether this process's heap is too small for a cold wallet sync on this
 * machine, and if so the limit to start it with; null when it will do.
 * `desiredMb` replaces SYNC_HEAP_TARGET_MB (on a small machine, say).
 *
 * Null under bun: its heap is JavaScriptCore's, which neither NODE_OPTIONS nor
 * --max-old-space-size sets (bun 1.3 reports the same V8 statistics with or
 * without them), so there is no flag to advise.
 */
export function syncHeapAdvice(options: { readonly desiredMb?: number } = {}): SyncHeapAdvice | null {
  if (process.versions.bun !== undefined) return null;
  const target = syncHeapTargetMb({
    totalMb: Math.floor(os.totalmem() / MB),
    currentLimitMb: Math.floor(v8.getHeapStatistics().heap_size_limit / MB),
    desiredMb: options.desiredMb,
  });
  return target === null ? null : { maxOldSpaceMb: target, nodeOptions: `--max-old-space-size=${target}` };
}
