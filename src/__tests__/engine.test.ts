// The engine for a network: one per process, loaded on first use, and the
// same for work every set does alike.

import { describe, expect, it } from 'vitest';
import { anyEngine, engineFor, sdkSetOf } from '../lib/engine.ts';
import { getValidNetworkNames, type NetworkName } from '../lib/network.ts';
import { rcEngine } from '../engine/rc/index.ts';

describe('the engine for a network', () => {
  it('is the rc engine for every network mn knows today', async () => {
    for (const network of getValidNetworkNames() as NetworkName[]) {
      expect(sdkSetOf(network)).toBe('rc');
      expect(await engineFor(network)).toBe(rcEngine);
    }
  });

  it('is the one loaded in this process for work every set does alike', async () => {
    expect(await anyEngine()).toBe(await engineFor('undeployed'));
  });

  it('derives a wallet\'s addresses on every network, matching one network at a time', async () => {
    const seed = Buffer.from('ab'.repeat(32), 'hex');
    const { keys } = await anyEngine();
    const unshielded = keys.unshieldedAddresses(seed);
    const shielded = keys.shieldedAddresses(seed);
    for (const network of getValidNetworkNames() as NetworkName[]) {
      expect(unshielded[network]).toBe(keys.unshieldedAddress(seed, network));
      expect(unshielded[network]).toMatch(new RegExp(`^mn_addr_${network}1`));
      expect(shielded[network]).toBe(keys.shieldedAddress(seed, network));
      expect(shielded[network]).toMatch(new RegExp(`^mn_shield-addr_${network}1`));
    }
  });
});
