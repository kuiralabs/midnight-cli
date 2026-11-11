// A cold Dust read on a chain with no Dust events at all ends at once, on the
// empty Dust state. Regression: it waited for a first event that never came,
// for the reader's whole 600 s window (resumed up to three times).
//
// The chain is stood in for at its external boundary only: an HTTP indexer
// whose tip block reports Dust trees that never grew (or ones that did), and a
// WebSocket indexer whose Dust stream is empty. The repository and its reader
// are real; each test runs with the native sidecar on and off.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsFromEnvironment, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { isDustTimelineEmpty } from '@kuiralabs/midnight-chain';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { dustPublicKeyHexFromSeed, loadDustCache } from '../dust-direct-cache.ts';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';
import { startFakeChainIndexer, type FakeEventIndexer } from '../../../../test-support/fake-event-indexer.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';
import { testHost } from '../../../../test-support/test-host.ts';

const SEED = Buffer.from('22'.repeat(32), 'hex');
/** A localnet's tip on ledger 9, with its Dust trees' end indices as given. */
const tip = (dustEnd: number) => ({ height: 12, hash: 'ab'.repeat(32), protocolVersion: 2_001_000, timestamp: 1794433500000, dustCommitmentEndIndex: dustEnd, dustGenerationEndIndex: dustEnd });

let ws: FakeEventIndexer;
let emptyChain: LocalIndexer;
let dustChain: LocalIndexer;
let closed: number;
beforeAll(async () => {
  ws = await startFakeChainIndexer({ dustLedgerEvents: [] });
  emptyChain = await startLocalIndexer(() => JSON.stringify({ data: { block: tip(0) } }));
  dustChain = await startLocalIndexer(() => JSON.stringify({ data: { block: tip(7) } }));
  closed = await closedPort();
});
afterAll(async () => { await Promise.all([ws.close(), emptyChain.close(), dustChain.close()]); });

const networkOn = (http: LocalIndexer): NetworkConfig => ({ indexer: http.url, indexerWS: ws.url, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}`, networkId: 'Undeployed' });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mn-dust-empty-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('a cold Dust read on a chain with no Dust events', () => {
  for (const [reader, env] of [['the in-process reader', { MN_DISABLE_NATIVE_DUST: '1' }], ['the native sidecar', {}]] as const) {
    it(`ends in seconds on the empty Dust state, with ${reader} chosen`, async () => {
      const repo = new WalletDataRepository(testHost({ settings: () => settingsFromEnvironment({ ...process.env, ...env }) }));
      const started = Date.now();
      const view = await repo.dust(SEED, networkOn(emptyChain), { root, notice: () => {} });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(view.balance).toBe(0n);
      expect(view.partial).toBe(false);
      expect(view.lastAppliedEventId).toBe(-1);
      expect(view.state.ledgerVersion, 'the chain is on ledger 9').toBe(9);
      // Kept, so the next read resumes from the start with a state in hand.
      expect(loadDustCache('undeployed', dustPublicKeyHexFromSeed(SEED), root)?.lastAppliedEventId).toBe(-1);
    }, 30_000);
  }
});

describe('isDustTimelineEmpty', () => {
  it('is true only when the Dust trees never grew and the stream sends nothing', async () => {
    expect(await isDustTimelineEmpty(emptyChain.url, ws.url)).toBe(true);
  });

  it('is false on a chain whose Dust trees grew, however silent its stream (a slow first event)', async () => {
    expect(await isDustTimelineEmpty(dustChain.url, ws.url)).toBe(false);
  });

  it('is false when the indexer can\'t say', async () => {
    expect(await isDustTimelineEmpty(`http://127.0.0.1:${closed}/api/v4/graphql`, ws.url)).toBe(false);
  });
});
