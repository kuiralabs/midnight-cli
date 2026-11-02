// The engine for a network: one per process, loaded on first use, and the
// same for work every set does alike.

import { describe, expect, it } from 'vitest';
import { anyEngine, engineFor, sdkSetOf, setEngineLoader } from '@kuiralabs/midnight-cli-core/lib/engine';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { getValidNetworkNames, sdkSetOfNetwork, type NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { rcEngine } from '@kuiralabs/midnight-engine-rc';

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

describe('the network picks the engine', () => {
  it('asks the host\'s loader for the set the network table names, once a process', async () => {
    const asked: string[] = [];
    setEngineLoader(async (set) => { asked.push(set); return rcEngine; });
    try {
      expect(await engineFor('preview')).toBe(rcEngine);
      expect(await engineFor('undeployed')).toBe(rcEngine);
      expect(asked).toStrictEqual(['rc']);
      for (const network of getValidNetworkNames() as NetworkName[]) expect(sdkSetOf(network)).toBe(sdkSetOfNetwork(network));
    } finally {
      setEngineLoader(loadInstalledEngine);
    }
  });

  it('refuses a second set in a process that has loaded one', async () => {
    const other = { ...rcEngine, set: 'beta' } as unknown as typeof rcEngine;
    setEngineLoader(async () => other);
    try {
      await expect(engineFor('undeployed')).rejects.toThrow("This process runs the beta SDK set and can't load the rc one");
    } finally {
      setEngineLoader(loadInstalledEngine);
    }
  });

});
