import { describe, it, expect } from 'vitest';
import { dustGenerationCap } from '../lib/dust-cap.ts';

describe('dustGenerationCap', () => {
  it('sums the caps of the coins whose NIGHT is unspent', () => {
    expect(dustGenerationCap([
      { maxCap: 5_000n, dtime: undefined },
      { maxCap: 7_000n, dtime: undefined },
      // Its NIGHT was spent: it decays, and generates no more.
      { maxCap: 9_000n, dtime: new Date(0) },
    ])).toBe(12_000n);
  });

  it('is 0 for a wallet with no Dust coin', () => {
    expect(dustGenerationCap([])).toBe(0n);
  });
});
