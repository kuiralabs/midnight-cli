// A host's engine for a network: one per host, loaded on first use, and the
// same for work every set does alike. Each host's engine keeps its own
// repository and reads its own host's settings; the process runs one SDK set,
// whichever host loaded it.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OtherSdkSetError, sdkSetOf, type Engine, type SdkSet, createHost, type Host, settingsFromEnvironment, getValidNetworkNames, sdkSetOfNetwork, type NetworkConfig, type NetworkName } from '@kuiralabs/midnight-cli-core';
import type { BalanceSummary } from '@kuiralabs/midnight-chain';
import { createRcEngine, type RcEngineOptions } from '@kuiralabs/midnight-engine-rc';

/** The seams an rc engine's wallet repository takes, as its options name them. */
type RepoDeps = NonNullable<RcEngineOptions['repository']>;
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { startRefusingEndpoint } from '../../test-support/stand-in-indexer.ts';

// A state root with no config: every network on the set the table names.
const ROOT = mkdtempSync(join(tmpdir(), 'mn-engine-test-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A host on ROOT whose engines come from `engineLoader` (the engines the CLI ships by default). */
const hostOn = (engineLoader: (set: SdkSet, host: Host) => Promise<Engine> = loadInstalledEngine, notice?: (line: string) => void) =>
  createHost({ paths: { stateRoot: ROOT, home: ROOT }, engineLoader, ...(notice ? { notice } : {}) });

describe('a host\'s engine for a network', () => {
  it('is the rc engine for every network but stagenet, which runs the beta set', async () => {
    const host = hostOn();
    const engine = await host.engines.for('undeployed');
    expect(engine.set).toBe('rc');
    for (const network of getValidNetworkNames() as NetworkName[]) {
      if (network === 'stagenet') continue;
      expect(sdkSetOf(network, ROOT)).toBe('rc');
      expect(await host.engines.for(network)).toBe(engine);
    }
    expect(sdkSetOf('stagenet', ROOT)).toBe('beta');
  });

  it('refuses stagenet in a host that has loaded the rc engine, naming both sets', async () => {
    const host = hostOn();
    await host.engines.for('undeployed');
    const refusal = await host.engines.for('stagenet').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(OtherSdkSetError);
    expect(refusal).toMatchObject({ code: 'OTHER_SDK_SET', loadedSet: 'rc', wantedSet: 'beta' });
  });

  it('refuses the other set to a new host once the process has loaded one, without asking its loader', async () => {
    await hostOn().engines.for('undeployed');
    const asked: SdkSet[] = [];
    const fresh = hostOn(async (set, host) => { asked.push(set); return createRcEngine(host); });
    const refusal = await fresh.engines.for('stagenet').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(OtherSdkSetError);
    expect(refusal).toMatchObject({ code: 'OTHER_SDK_SET', loadedSet: 'rc', wantedSet: 'beta' });
    expect(asked).toStrictEqual([]);
  });

  it('is the one the host has loaded for work every set does alike', async () => {
    const host = hostOn();
    expect(await host.engines.any()).toBe(await host.engines.for('undeployed'));
  });

  it('derives a wallet\'s addresses on every network, matching one network at a time', async () => {
    const seed = Buffer.from('ab'.repeat(32), 'hex');
    const { keys } = await hostOn().engines.any();
    const unshielded = keys.unshieldedAddresses(seed);
    const shielded = keys.shieldedAddresses(seed);
    for (const network of getValidNetworkNames() as NetworkName[]) {
      expect(unshielded[network]).toBe(keys.unshieldedAddress(seed, network));
      expect(unshielded[network]).toMatch(new RegExp(`^mn_addr_${network}1`));
      expect(shielded[network]).toBe(keys.shieldedAddress(seed, network));
      expect(shielded[network]).toMatch(new RegExp(`^mn_shield-addr_${network}1`));
    }
  });

  it('refuses without an engine loader, naming the option', async () => {
    const host = createHost({ paths: { stateRoot: ROOT, home: ROOT } });
    await expect(host.engines.for('undeployed')).rejects.toThrow("createHost's engineLoader");
  });
});

describe('the network picks the engine', () => {
  it('asks the host\'s loader for the set the network table names, once a host', async () => {
    const asked: SdkSet[] = [];
    const host = hostOn(async (set, h) => { asked.push(set); return createRcEngine(h); });
    const engine = await host.engines.for('preview');
    expect(await host.engines.for('undeployed')).toBe(engine);
    expect(asked).toStrictEqual(['rc']);
    for (const network of getValidNetworkNames() as NetworkName[]) expect(sdkSetOf(network, ROOT)).toBe(sdkSetOfNetwork(network, ROOT));
  });

  it('refuses an engine of a set other than the one asked for', async () => {
    const host = hostOn(async (_set, h) => ({ ...createRcEngine(h), set: 'beta' }));
    await expect(host.engines.for('undeployed')).rejects.toThrow("This process runs the beta SDK set and can't load the rc one");
  });
});

// The chain and the indexer stand in at the repository's seams; the rest is the engine's own.
const NETWORK: NetworkConfig = {
  indexer: 'http://test/indexer',
  indexerWS: 'ws://test/indexer/ws',
  node: 'ws://test/node',
  proofServer: 'http://test/proof',
  networkId: 'Undeployed',
};
const ADDRESS = 'mn_addr_undeployed1ugtvumxjrspvh598y6agtw3sdk06qf8sl0x0pfu6lf2080wrnprsdj8xxx';
const summary = (): BalanceSummary => ({ balances: new Map(), utxoCount: 0, txCount: 0, highestTxId: 0, registeredUtxos: 0, unregisteredUtxos: 0 });

describe('each host\'s engine', () => {
  it('is an instance of its own, with a repository of its own: a read cached in one host is fetched again in the other', async () => {
    const fetched: string[] = [];
    const deps: RepoDeps = {
      fetchTip: async () => 'tip-1',
      fetchUnshielded: async (address) => { fetched.push(address); return summary(); },
    };
    const loader = async (_set: SdkSet, h: Host) => createRcEngine(h, { repository: deps });
    const a = await hostOn(loader).engines.for('undeployed');
    const b = await hostOn(loader).engines.for('undeployed');
    expect(a).not.toBe(b);
    expect(a.wallet).not.toBe(b.wallet);

    expect((await a.wallet.unshieldedBalance(ADDRESS, NETWORK)).fromCache).toBe(false);
    expect((await a.wallet.unshieldedBalance(ADDRESS, NETWORK)).fromCache).toBe(true);
    expect((await b.wallet.unshieldedBalance(ADDRESS, NETWORK)).fromCache).toBe(false);
    expect(fetched).toStrictEqual([ADDRESS, ADDRESS]);
  });

  it('reads its own host\'s settings when it reads Dust, never another host\'s', async () => {
    const indexer = await startRefusingEndpoint();
    const root = mkdtempSync(join(tmpdir(), 'mn-engine-dust-'));
    try {
      const reads: string[] = [];
      const settingsOf = (name: string) => () => { reads.push(name); return settingsFromEnvironment({ MN_DISABLE_DUST_COLLAPSE: '1' }); };
      const deps: RepoDeps = { fetchProtocolVersion: async () => 2001000n, fetchChainId: async () => null };
      const loader = async (_set: SdkSet, h: Host) => createRcEngine(h, { repository: deps });
      const a = await createHost({ paths: { stateRoot: ROOT, home: ROOT }, settings: settingsOf('A'), engineLoader: loader }).engines.for('undeployed');
      await createHost({ paths: { stateRoot: ROOT, home: ROOT }, settings: settingsOf('B'), engineLoader: loader }).engines.for('undeployed');

      const network = { ...NETWORK, indexerWS: `ws://127.0.0.1:${indexer.port}/api/v4/graphql/ws` };
      await expect(a.wallet.dustBalance(Buffer.alloc(32, 3), network, { root, notice: () => {} })).rejects.toThrow();
      expect(reads.length).toBeGreaterThan(0);
      expect(new Set(reads)).toStrictEqual(new Set(['A']));
    } finally {
      rmSync(root, { recursive: true, force: true });
      await indexer.close();
    }
  });
});
