// The heap a cold wallet sync needs: the limit to ask for (pure), and the
// advice for this process, which names the flag that sets it.

import v8 from 'node:v8';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { syncHeapAdvice, syncHeapTargetMb } from '../process/sync-heap.ts';
import { SYNC_HEAP_TARGET_MB, SYNC_HEAP_RAM_FRACTION, SYNC_HEAP_MIN_GAIN_MB } from '../lib/constants.ts';

describe('syncHeapTargetMb', () => {
  // The OOM repro: a 128 GB box with Node's default ~4.3 GB old-space cap.
  it('bumps to the desired target when RAM and current limit allow', () => {
    expect(syncHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288 }))
      .toBe(SYNC_HEAP_TARGET_MB);
  });

  it('returns null when the current limit already has enough headroom', () => {
    // e.g. the user already raised the heap via NODE_OPTIONS — don't re-exec.
    expect(syncHeapTargetMb({ totalMb: 131072, currentLimitMb: 16384 })).toBeNull();
  });

  it('caps the target at the RAM fraction on small machines', () => {
    // 8 GB machine: 70% = 5734 MB, below the 12 GB desired.
    expect(syncHeapTargetMb({ totalMb: 8192, currentLimitMb: 4288 }))
      .toBe(Math.floor(8192 * SYNC_HEAP_RAM_FRACTION));
  });

  it('returns null when the RAM-capped target is not a worthwhile gain', () => {
    // 6 GB machine: 70% = 4300 MB, only ~12 MB over the current 4288 — below the
    // min-gain threshold, so re-exec isn't worth it.
    expect(syncHeapTargetMb({ totalMb: 6144, currentLimitMb: 4288 })).toBeNull();
  });

  it('respects the min-gain threshold exactly at the boundary', () => {
    const current = 4288;
    // target would be current + minGain exactly → not a *worthwhile* gain (<=).
    const totalMb = Math.ceil((current + SYNC_HEAP_MIN_GAIN_MB) / SYNC_HEAP_RAM_FRACTION);
    expect(syncHeapTargetMb({ totalMb, currentLimitMb: current })).toBeNull();
    // one MB more of RAM tips it over.
    expect(syncHeapTargetMb({ totalMb: totalMb + 2, currentLimitMb: current })).not.toBeNull();
  });

  it('honors an explicit desired override', () => {
    expect(syncHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288, desiredMb: 8192 }))
      .toBe(8192);
  });

  it('rejects a non-positive or NaN desired override', () => {
    expect(syncHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288, desiredMb: 0 })).toBeNull();
    expect(syncHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288, desiredMb: NaN })).toBeNull();
  });

  it('returns null for bogus total memory', () => {
    expect(syncHeapTargetMb({ totalMb: 0, currentLimitMb: 4288 })).toBeNull();
    expect(syncHeapTargetMb({ totalMb: NaN, currentLimitMb: 4288 })).toBeNull();
  });
});

describe('syncHeapAdvice', () => {
  const MB = 1024 * 1024;
  const totalMb = Math.floor(os.totalmem() / MB);
  const currentLimitMb = Math.floor(v8.getHeapStatistics().heap_size_limit / MB);

  it("reads this machine's memory and this process's heap, and names the flag that sets the limit", () => {
    // Just above the gain that is worth a restart: advised as asked wherever the machine's memory allows it.
    const desiredMb = currentLimitMb + SYNC_HEAP_MIN_GAIN_MB + 1;
    const fits = desiredMb <= Math.floor(totalMb * SYNC_HEAP_RAM_FRACTION);
    expect(syncHeapAdvice({ desiredMb })).toEqual(fits ? { maxOldSpaceMb: desiredMb, nodeOptions: `--max-old-space-size=${desiredMb}` } : null);
  });

  it('advises nothing when the heap this process has will do', () => {
    expect(syncHeapAdvice({ desiredMb: currentLimitMb })).toBeNull();
  });
});
