// Dev wallet provisioning order. A ledger-9 registration waits for its NIGHT
// to generate the fee, and generation starts at the airdrop, so every new
// wallet is funded before any registers. The steps are injected (the real
// ones run mn's commands against a chain); HOME is a temporary directory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nightAmountText, nightToMicro } from '@kuiralabs/midnight-cli-core';
import { DEFAULT_DEV_AIRDROP_AMOUNT, provisionDevWallets, type ProvisionSteps } from '../lib/dev/provision-wallets.ts';
import { stateRootIn } from '../../../../test-support/state-root-in.ts';

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mn-provision-'));
  process.env.HOME = home;
  mkdirSync(join(home, '.midnight', 'wallets'), { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

/**
 * Records each step (amounts in NIGHT); `unregistered` lists existing wallets
 * that still need Dust, `held` the NIGHT an existing wallet holds (else 50,000).
 */
function recordingSteps(calls: string[], unregistered: string[] = [], held: Record<string, number> = {}): ProvisionSteps {
  return {
    generate: async (name) => { calls.push(`generate ${name}`); },
    airdrop: async (name, amount) => { calls.push(`airdrop ${name} ${nightAmountText(amount)}`); },
    registerDust: async (name) => { calls.push(`register ${name}`); },
    inspect: async (name) => {
      calls.push(`check ${name}`);
      return { needsDust: unregistered.includes(name), night: nightToMicro(held[name] ?? 50_000) };
    },
  };
}

describe('provisionDevWallets', () => {
  it("funds mn dev's wallets with 50,000 NIGHT, so their first transactions don't wait for Dust", () => {
    // 0.41 DUST a second: a deploy's 1.08 DUST fee comes back in 3 s (LOCAL_WALLET_FUNDING_NIGHT has the arithmetic).
    expect(DEFAULT_DEV_AIRDROP_AMOUNT).toBe(50_000);
  });

  it('funds every new wallet before registering any, and leaves existing ones alone', async () => {
    writeFileSync(join(home, '.midnight', 'wallets', 'dev-bob.json'), '{}');
    const calls: string[] = [];
    const progress: string[] = [];

    const result = await provisionDevWallets({
      root: stateRootIn(home),
      names: ['dev-alice', 'dev-bob', 'dev-carol'],
      amountNight: 1000,
      steps: recordingSteps(calls),
      onProgress: (wallet, phase) => progress.push(`${wallet}:${phase}`),
    });

    expect(calls).toEqual([
      'generate dev-alice', 'airdrop dev-alice 1000',
      'check dev-bob',
      'generate dev-carol', 'airdrop dev-carol 1000',
      'register dev-alice', 'register dev-carol',
    ]);
    expect(result).toEqual([
      { name: 'dev-alice', state: 'created' },
      { name: 'dev-bob', state: 'reused' },
      { name: 'dev-carol', state: 'created' },
    ]);
    expect(progress).toEqual([
      'dev-alice:creating', 'dev-alice:funding', 'dev-bob:done', 'dev-carol:creating', 'dev-carol:funding',
      'dev-alice:dust', 'dev-alice:done', 'dev-carol:dust', 'dev-carol:done',
    ]);
  });

  it('finishes an existing wallet whose setup stopped after funding: registers it, without funding it again', async () => {
    writeFileSync(join(home, '.midnight', 'wallets', 'dev-alice.json'), '{}');
    const calls: string[] = [];

    const result = await provisionDevWallets({ root: stateRootIn(home), names: ['dev-alice'], amountNight: 1000, steps: recordingSteps(calls, ['dev-alice']) });

    expect(calls).toEqual(['check dev-alice', 'register dev-alice']);
    expect(result).toEqual([{ name: 'dev-alice', state: 'created' }]);
  });

  it('tops up an existing wallet holding less than the amount to it, from genesis, and says by how much', async () => {
    writeFileSync(join(home, '.midnight', 'wallets', 'dev-alice.json'), '{}');
    writeFileSync(join(home, '.midnight', 'wallets', 'dev-bob.json'), '{}');
    const calls: string[] = [];
    const progress: string[] = [];

    // dev-alice was funded with the 1000 NIGHT mn dev gave before; dev-bob already has the amount.
    const result = await provisionDevWallets({
      root: stateRootIn(home),
      names: ['dev-alice', 'dev-bob'],
      amountNight: 50_000,
      steps: recordingSteps(calls, [], { 'dev-alice': 1000.5, 'dev-bob': 50_000 }),
      onProgress: (wallet, phase, state) => progress.push(`${wallet}:${phase}:${state}`),
    });

    expect(calls).toEqual(['check dev-alice', 'airdrop dev-alice 48999.5', 'check dev-bob']);
    expect(result).toEqual([
      { name: 'dev-alice', state: 'reused', toppedUp: nightToMicro(48_999.5) },
      { name: 'dev-bob', state: 'reused' },
    ]);
    expect(progress).toEqual(['dev-alice:topping-up:reused', 'dev-alice:done:reused', 'dev-bob:done:reused']);
  });

  it('tops up an unregistered existing wallet before registering it', async () => {
    writeFileSync(join(home, '.midnight', 'wallets', 'dev-alice.json'), '{}');
    const calls: string[] = [];

    const result = await provisionDevWallets({ root: stateRootIn(home), names: ['dev-alice'], amountNight: 50_000, steps: recordingSteps(calls, ['dev-alice'], { 'dev-alice': 1000 }) });

    expect(calls).toEqual(['check dev-alice', 'airdrop dev-alice 49000', 'register dev-alice']);
    expect(result).toEqual([{ name: 'dev-alice', state: 'created', toppedUp: nightToMicro(49_000) }]);
  });

  it('stops before registering when cancelled after funding, as CANCELLED', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const steps = recordingSteps(calls);
    const airdrop = steps.airdrop;
    steps.airdrop = async (name, amount, signal) => { await airdrop(name, amount, signal); controller.abort(); };

    // Regression: it failed with the signal's own AbortError, which mn's error codes don't read as CANCELLED.
    await expect(provisionDevWallets({ root: stateRootIn(home), names: ['dev-alice'], amountNight: 1000, steps, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toEqual(['generate dev-alice', 'airdrop dev-alice 1000']);
  });
});
