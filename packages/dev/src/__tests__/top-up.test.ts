// Topping up a wallet mn's local flows reuse, and mn test's balance:<N> step:
// on the local network a wallet is brought up to the amount (never past what a
// test file names); on any other network nothing is airdropped.

import { describe, expect, it } from 'vitest';
import { nightToMicro } from '@kuiralabs/midnight-cli-core';
import { planBalanceStep, topUpShortfall } from '../lib/dev/top-up.ts';

describe('topUpShortfall', () => {
  it('is the difference to the amount, to the micro-NIGHT', () => {
    expect(topUpShortfall(nightToMicro(1000), 50_000)).toBe(nightToMicro(49_000));
    expect(topUpShortfall(nightToMicro(0.000001), 1)).toBe(999_999n);
    expect(topUpShortfall(0n, 50_000)).toBe(nightToMicro(50_000));
  });

  it('is 0 for a wallet that has the amount or more', () => {
    expect(topUpShortfall(nightToMicro(50_000), 50_000)).toBe(0n);
    expect(topUpShortfall(nightToMicro(80_000), 50_000)).toBe(0n);
  });
});

describe('planBalanceStep', () => {
  it('on the local network, tops a 1000 NIGHT wallet up to the 50000 a new test file names', () => {
    expect(planBalanceStep('undeployed', nightToMicro(1000), 50_000)).toEqual({ kind: 'top-up', amount: nightToMicro(49_000) });
  });

  it('keeps an explicit balance:1000 as written: a 1000 NIGHT wallet is enough, a richer one is never touched', () => {
    expect(planBalanceStep('undeployed', nightToMicro(1000), 1000)).toEqual({ kind: 'enough' });
    expect(planBalanceStep('undeployed', nightToMicro(40_000), 1000)).toEqual({ kind: 'enough' });
    expect(planBalanceStep('undeployed', nightToMicro(400), 1000)).toEqual({ kind: 'top-up', amount: nightToMicro(600) });
  });

  it('airdrops the whole amount to an empty local wallet', () => {
    expect(planBalanceStep('undeployed', 0n, 50_000)).toEqual({ kind: 'top-up', amount: nightToMicro(50_000) });
  });

  it.each(['preview', 'preprod', 'mainnet'] as const)('never airdrops on %s: any NIGHT is enough, none is for the person to fund', (network) => {
    expect(planBalanceStep(network, nightToMicro(1), 50_000)).toEqual({ kind: 'enough' });
    expect(planBalanceStep(network, 0n, 50_000)).toEqual({ kind: 'unfunded' });
  });
});
