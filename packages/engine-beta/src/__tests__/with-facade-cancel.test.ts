// The beta engine's wallet sync honours the call's cancellation, as the rc
// engine's does (its wallet-data-repository.test.ts): in a file of its own,
// since one process loads one SDK set. Against an indexer and a node that take
// connections and never answer, so the sync never completes by itself.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancelledError, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { testHost } from '../../../../test-support/test-host.ts';
import { startSilentNetwork } from '../../../../test-support/stand-in-indexer.ts';

const SEED = Buffer.from('11'.repeat(32), 'hex');
let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'mn-beta-cancel-')); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

describe("the beta engine's withFacade, cancelled", () => {
  it('stops the sync with CancelledError when the call is cancelled, instead of waiting it out', async () => {
    const silent = await startSilentNetwork();
    try {
      const repo = new WalletDataRepository(testHost(), { fetchProtocolVersion: async () => 2_001_000n, fetchChainId: async () => null });
      const network: NetworkConfig = { networkId: 'Undeployed', indexer: silent.indexer, indexerWS: silent.indexerWS, node: silent.node, proofServer: 'http://127.0.0.1:9' };
      const controller = new AbortController();
      const started = Date.now();
      const cancelled = repo.withFacade(SEED, network, async () => 'never reached', { root: TMP, notice: () => {}, noPrime: true, signal: controller.signal });
      setTimeout(() => controller.abort(), 1_500);
      await expect(cancelled).rejects.toBeInstanceOf(CancelledError);
      // The sync's own deadline is 30 s on a local network: cancelled, it ends long before.
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await silent.close();
    }
  }, 60_000);
});
