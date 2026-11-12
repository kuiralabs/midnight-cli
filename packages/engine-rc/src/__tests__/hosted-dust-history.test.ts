// A Dust read whose connection fails is retried from its checkpoint; and on a
// hosted network a write never leaves the chain's Dust history to the wallet
// SDK's in-process (WASM) reader, which reads 15-20k events per 120 s window
// against 1.86M on preprod and ended in SYNC_TIMEOUT after 6.5 minutes. It
// fails, saying where the read stopped and that a re-run resumes there.
//
// The indexer is an external service: a local HTTP server answers the one
// query the shielded read asks (the chain's first block is on ledger 9), the
// Dust reader is the repository's fetchDust seam, and the chain's Dust tip its
// fetchEventTip seam. The repository itself is real.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import * as ledger from '@midnightntwrk/ledger-v9';
import { NetworkError, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { WalletDataRepository, type RepoDeps } from '../wallet-data-repository.ts';
import type { DustDirectResult } from '../dust-direct.ts';
import { testHost } from '../../../../test-support/test-host.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

const SEED = Buffer.from('22'.repeat(32), 'hex');
const LEDGER9 = 2_001_000;
const PREPROD_DUST_TIP = 1_865_550;

function dustResult(overrides: Partial<DustDirectResult> = {}): DustDirectResult {
  const state = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
  return {
    balance: 0n, availableCoins: 0, eventCount: 0, ownedUtxoCount: 0, syncTime: new Date(0),
    state: { ledgerVersion: 9, state }, retention: { ownedGenerationIndices: [], generationFrontier: 0 },
    lastAppliedEventId: -1, partial: false,
    ...overrides,
  };
}

let dir: string;
let indexer: Server;
let network: NetworkConfig;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mn-hosted-dust-'));
  // Every query is answered as a ledger-9 chain's: its first block, its tip.
  indexer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { block: { protocolVersion: LEDGER9 } } })); });
  await new Promise<void>((resolve) => indexer.listen(0, '127.0.0.1', resolve));
  const { port } = indexer.address() as AddressInfo;
  const closed = await closedPort();
  network = { networkId: 'PreProd', indexer: `http://127.0.0.1:${port}/api/v0`, indexerWS: `ws://127.0.0.1:${closed}/api/v0/ws`, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}` };
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => indexer.close(() => resolve()));
});

function repoWith(fetchDust: RepoDeps['fetchDust']): WalletDataRepository {
  return new WalletDataRepository(testHost(), {
    fetchProtocolVersion: async () => BigInt(LEDGER9),
    fetchChainId: async () => null,
    fetchTip: async () => 'tip',
    fetchEventTip: async () => PREPROD_DUST_TIP,
    fetchDust,
    transientRetryDelaysMs: [10, 10],
  });
}

describe('a Dust read whose connection fails', () => {
  it('is retried after a wait, from the checkpoint, and finishes', async () => {
    const starts: number[] = [];
    const repo = repoWith(async (_seed, _network, opts) => {
      starts.push(opts.startFromId);
      if (starts.length === 1) {
        opts.onCheckpoint?.(dustResult().state, 499, { ownedGenerationIndices: [], generationFrontier: 0 });
        throw new NetworkError('WebSocket error: socket hang up');
      }
      return dustResult({ lastAppliedEventId: 999, eventCount: 500 });
    });
    const view = await repo.dust(SEED, network, { root: dir, notice: () => {} });
    expect(starts).toEqual([0, 500]);
    expect(view.lastAppliedEventId).toBe(999);
  });

  it('is not retried when the failure is not a connection', async () => {
    let calls = 0;
    const repo = repoWith(async () => { calls++; throw new Error('deserialize event 7: bad tag'); });
    await expect(repo.dust(SEED, network, { root: dir, notice: () => {} })).rejects.toThrow('deserialize event 7: bad tag');
    expect(calls).toBe(1);
  });
});

describe('a write on a hosted network whose Dust read stopped far from the tip', () => {
  it('fails with NETWORK_ERROR naming the indexer, where the read stopped, and that a re-run resumes, without starting the wallet', async () => {
    const repo = repoWith(async (_seed, _network, opts) => {
      opts.onCheckpoint?.(dustResult().state, 41_999, { ownedGenerationIndices: [], generationFrontier: 0 });
      throw new NetworkError('dust-sync exited 2: dust-sync: params query: http://127.0.0.1:47777/api/v0?project_id=***: status code 502');
    });
    let walletStarted = false;
    const write = repo.withFacade(SEED, network, async () => { walletStarted = true; return 'sent'; }, { root: dir, notice: () => {} });
    await expect(write).rejects.toBeInstanceOf(NetworkError);
    await expect(write).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(new RegExp(
        `^Reading the wallet's Dust history from the indexer at ${network.indexerWS.replace(/[.]/g, '\\.')} stopped at event 41999 of ${PREPROD_DUST_TIP}: dust-sync exited 2: .*status code 502\\n`
        + 'Run the command again: it resumes from event 42000, where this read stopped\\.',
      )),
    });
    expect(walletStarted).toBe(false);
  }, 30_000);

  it('fails with SYNC_TIMEOUT when the read ran out of windows, saying a re-run resumes', async () => {
    const repo = repoWith(async (_seed, _network, opts) => {
      opts.onCheckpoint?.(dustResult().state, 99, { ownedGenerationIndices: [], generationFrontier: 0 });
      return dustResult({ lastAppliedEventId: 99, eventCount: 0, partial: true });
    });
    await expect(repo.withFacade(SEED, network, async () => 'sent', { root: dir, notice: () => {} })).rejects.toMatchObject({
      code: 'SYNC_TIMEOUT',
      message: expect.stringContaining(`ran out of time at event 99 of ${PREPROD_DUST_TIP}. Run the command again: it resumes from event 100`),
    });
  }, 30_000);
});
