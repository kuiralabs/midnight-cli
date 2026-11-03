// The engine for a network: one per process, loaded on first use, and the
// same for work every set does alike.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OtherSdkSetError, anyEngine, engineFor, preferEngineOf, sdkSetOf, setEngineLoader } from '@kuiralabs/midnight-cli-core/lib/engine';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { getValidNetworkNames, sdkSetOfNetwork, type NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { rcEngine } from '@kuiralabs/midnight-engine-rc';

// A state root with no config: every network on the set the table names.
const ROOT = mkdtempSync(join(tmpdir(), 'mn-engine-test-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('the engine for a network', () => {
  it('is the rc engine for every network but stagenet, which runs the beta set', async () => {
    for (const network of getValidNetworkNames() as NetworkName[]) {
      if (network === 'stagenet') continue;
      expect(sdkSetOf(network, ROOT)).toBe('rc');
      expect(await engineFor(network, ROOT)).toBe(rcEngine);
    }
    expect(sdkSetOf('stagenet', ROOT)).toBe('beta');
  });

  it('refuses stagenet in a process that has loaded the rc engine, naming both sets', async () => {
    await engineFor('undeployed', ROOT);
    const refusal = await engineFor('stagenet', ROOT).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(OtherSdkSetError);
    expect(refusal).toMatchObject({ code: 'OTHER_SDK_SET', loadedSet: 'rc', wantedSet: 'beta' });
  });

  it('is the one loaded in this process for work every set does alike', async () => {
    expect(await anyEngine()).toBe(await engineFor('undeployed', ROOT));
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
      expect(await engineFor('preview', ROOT)).toBe(rcEngine);
      expect(await engineFor('undeployed', ROOT)).toBe(rcEngine);
      expect(asked).toStrictEqual(['rc']);
      for (const network of getValidNetworkNames() as NetworkName[]) expect(sdkSetOf(network, ROOT)).toBe(sdkSetOfNetwork(network, ROOT));
    } finally {
      setEngineLoader(loadInstalledEngine);
    }
  });

  it('loads the set of the call\'s network for work every set does alike, before any engine is loaded', async () => {
    const asked: string[] = [];
    const beta = { ...rcEngine, set: 'beta' } as unknown as typeof rcEngine;
    setEngineLoader(async (set) => { asked.push(set); return set === 'beta' ? beta : rcEngine; });
    try {
      preferEngineOf('stagenet', ROOT);
      expect(await anyEngine()).toBe(beta);
      expect(asked).toStrictEqual(['beta']);
    } finally {
      preferEngineOf('undeployed', ROOT);
      setEngineLoader(loadInstalledEngine);
    }
  });

  it('refuses a second set in a process that has loaded one', async () => {
    const other = { ...rcEngine, set: 'beta' } as unknown as typeof rcEngine;
    setEngineLoader(async () => other);
    try {
      await expect(engineFor('undeployed', ROOT)).rejects.toThrow("This process runs the beta SDK set and can't load the rc one");
    } finally {
      setEngineLoader(loadInstalledEngine);
    }
  });

});
