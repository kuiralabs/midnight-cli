// Hosts on the beta set, in a process of its own: the set a call's network
// runs loads first, each host's beta engine tells its own host that it reads
// Dust in WASM (once per engine), and the process then refuses the rc set to
// any host.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OtherSdkSetError, type SdkSet, createHost, type Host, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { createBetaEngine } from '../index.ts';
import type { RepoDeps } from '../wallet-data-repository.ts';
import { startRefusingEndpoint } from '../../../../test-support/stand-in-indexer.ts';

// A state root with no config: stagenet runs the beta set, the rest the rc set.
const ROOT = mkdtempSync(join(tmpdir(), 'mn-engine-beta-host-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// The chain answers as a ledger-9 one with no genesis hash; the indexer refuses every connection.
const deps: RepoDeps = { fetchProtocolVersion: async () => 2001000n, fetchChainId: async () => null };
const asked: SdkSet[] = [];
const loader = async (set: SdkSet, host: Host) => { asked.push(set); return createBetaEngine(host, { repository: deps }); };
const hostWith = (notices: string[]) => createHost({ paths: { stateRoot: ROOT, home: ROOT }, notice: (line) => notices.push(line), engineLoader: loader });

describe('hosts on the beta set', () => {
  // First in this file: nothing in the process has loaded a set yet.
  it('load the set of the call\'s network for work every set does alike', async () => {
    const host = hostWith([]);
    host.engines.prefer('stagenet');
    expect((await host.engines.any()).set).toBe('beta');
    expect(asked).toStrictEqual(['beta']);
  });

  it('each tell their own host, once per engine, that the engine reads Dust in WASM', async () => {
    const indexer = await startRefusingEndpoint();
    const root = mkdtempSync(join(tmpdir(), 'mn-engine-beta-dust-'));
    try {
      const network: NetworkConfig = {
        indexer: 'http://test/indexer',
        indexerWS: `ws://127.0.0.1:${indexer.port}/api/v4/graphql/ws`,
        node: 'ws://test/node',
        proofServer: 'http://test/proof',
        networkId: 'StageNet',
      };
      const toA: string[] = [];
      const toB: string[] = [];
      const toCalls: string[] = [];
      const a = await hostWith(toA).engines.for('stagenet');
      const b = await hostWith(toB).engines.for('stagenet');
      const read = (engine: typeof a, seed: number) => engine.wallet.dustBalance(Buffer.alloc(32, seed), network, { root, notice: (line) => toCalls.push(line) });

      await expect(read(a, 1)).rejects.toThrow();
      await expect(read(a, 2)).rejects.toThrow();
      expect(toA).toStrictEqual(["  Reading StageNet's Dust history in WASM: no native sidecar runs ledger 9 yet, so a first sync takes a few minutes (about 2.5 on stagenet), then it is cached."]);
      expect(toB).toStrictEqual([]);

      await expect(read(b, 1)).rejects.toThrow();
      expect(toB).toStrictEqual(toA);
      expect(toCalls).toStrictEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await indexer.close();
    }
  });

  it('leave the process refusing the rc set to a new host', async () => {
    const refusal = await hostWith([]).engines.for('undeployed').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(OtherSdkSetError);
    expect(refusal).toMatchObject({ code: 'OTHER_SDK_SET', loadedSet: 'beta', wantedSet: 'rc' });
  });
});
