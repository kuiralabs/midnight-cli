import { describe, it, expect } from 'vitest';
import { networkHasShielded, shieldedSyncEnabled, shieldedDisabledReason } from '../lib/shielded-policy.ts';

describe('shielded-policy', () => {
  it('marks localnet (undeployed) as having shielded, hosted testnets as not', () => {
    expect(networkHasShielded('undeployed')).toBe(true);
    expect(networkHasShielded('preview')).toBe(false);
    expect(networkHasShielded('preprod')).toBe(false);
  });

  it('enables shielded sync on undeployed regardless of the force flag', () => {
    expect(shieldedSyncEnabled('undeployed', false)).toBe(true);
    expect(shieldedSyncEnabled('undeployed', true)).toBe(true);
  });

  it('disables shielded sync on preview/preprod by default', () => {
    expect(shieldedSyncEnabled('preview', false)).toBe(false);
    expect(shieldedSyncEnabled('preprod', false)).toBe(false);
  });

  it('re-enables shielded sync on preview/preprod when forced', () => {
    expect(shieldedSyncEnabled('preview', true)).toBe(true);
    expect(shieldedSyncEnabled('preprod', true)).toBe(true);
  });

  // Regression: mainnet did a full shielded sync by default, a cold read of 109 s through Blockfrost.
  it('disables shielded sync on mainnet by default, and --force-shielded re-enables it', () => {
    expect(networkHasShielded('mainnet')).toBe(false);
    expect(shieldedSyncEnabled('mainnet', false)).toBe(false);
    expect(shieldedSyncEnabled('mainnet')).toBe(false);
    expect(shieldedSyncEnabled('mainnet', true)).toBe(true);
    expect(shieldedDisabledReason('mainnet')).toBe('Shielded is not read on mainnet by default (its first read takes a while), though a wallet can hold shielded tokens there. Pass --force-shielded to read it.');
  });

  it('names the network and the override in the reason', () => {
    const reason = shieldedDisabledReason('preprod');
    expect(reason).toContain('preprod');
    expect(reason).toContain('--force-shielded');
  });

  // Regression: the reason said shielded was "unavailable (no faucet)" on preview, where wallets hold minted shielded tokens.
  it('says the balance is not read, not that there is none to hold', () => {
    const reason = shieldedDisabledReason('preview');
    expect(reason).not.toMatch(/unavailable|no faucet/);
    expect(reason).toContain('a wallet can hold shielded tokens there');
  });
});
