// A new wallet on a chain that forked from ledger 8 to ledger 9 (Preview,
// mainnet) restores onto the direct reader's ledger-9 Dust checkpoint instead of
// replaying the chain's whole Dust history in WASM, and `dust export` produces
// a snapshot there.
//
// The chain is stood in for at its external boundary only: an HTTP indexer that
// answers block queries with Preview's real genesis (protocol version 1000000,
// ledger 8) and tip (2001100, ledger 9), and, for the export, a WebSocket
// indexer replaying real mainnet Dust events across its fork
// (fixtures/dust-events-mainnet-fork.json). The facade, the SDK's forking Dust
// wallet and mn's reader are real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import { WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk/facade';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { getNetworkId } from '@kuiralabs/midnight-cli-core/engine';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { exportDustSnapshot } from '../dust-export.ts';
import { DustWallet } from '../dust-wallet.ts';
import { dustPublicKeyHexFromSeed, saveDustCache } from '../dust-direct-cache.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';
import fixture from './fixtures/dust-events-mainnet-fork.json';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';
import { startFakeEventIndexer, type FakeEventIndexer } from '../../../../test-support/fake-event-indexer.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';
import { testHost } from '../../../../test-support/test-host.ts';

/** Preview's blocks as its indexer reported them on 2026-11-07: the genesis (ledger 8) and the tip after the fork (ledger 9). */
const PREVIEW_GENESIS = { height: 0, hash: '3c096de209e06a1a8c52be7bda109ee8c891a42288c0a9db5495f9616dd13796', protocolVersion: 1_000_000, timestamp: 1754395200000 };
const PREVIEW_TIP = { height: 12445, hash: '0af3587e3db3017b9bd9b1da2a78bab477950c40304c20adb038f8b1bb59a8bc', protocolVersion: 2_001_100, timestamp: 1794088134000 };

/** An indexer of a forked chain: the block at height 0 is the ledger-8 genesis, any other block query the ledger-9 tip. */
function forkedChainIndexer(): Promise<LocalIndexer> {
  return startLocalIndexer(({ variables }) => {
    const offset = variables?.offset as { height?: number } | undefined;
    return JSON.stringify({ data: { block: offset?.height === 0 ? PREVIEW_GENESIS : PREVIEW_TIP } });
  });
}

const SEED = Buffer.from('11'.repeat(32), 'hex');

interface DustSnapshotFields { protocolVersion: string; writtenBy?: string; offset?: string; state: string }

/** The SDK's forking Dust wallet restores the snapshot, onto the variant its protocol version names. */
async function restoresOnLedger9(snapshot: string, network: NetworkConfig): Promise<bigint> {
  const wallet = DustWallet({
    networkId: getNetworkId(network.networkId),
    forks: FORK_SCHEDULE,
    indexerClientConnection: { indexerHttpUrl: network.indexer, indexerWsUrl: network.indexerWS },
    costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 0 },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  } as Parameters<typeof DustWallet>[0]).restore(snapshot);
  try {
    const state = await new Promise<{ progress: { appliedIndex: bigint }; protocolVersion: bigint }>((resolve) => {
      const sub = wallet.state.subscribe((s) => { resolve(s as never); queueMicrotask(() => sub.unsubscribe()); });
    });
    expect(state.protocolVersion >= FORK_SCHEDULE.v9, `restored on ledger 9, not at ${state.protocolVersion}`).toBe(true);
    return state.progress.appliedIndex;
  } finally {
    await wallet.stop();
  }
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mn-forked-restore-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('a new wallet on a chain that forked from ledger 8', () => {
  let http: LocalIndexer;
  let network: NetworkConfig;
  beforeAll(async () => {
    http = await forkedChainIndexer();
    const closed = await closedPort();
    network = { indexer: http.url, indexerWS: `ws://127.0.0.1:${closed}`, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}`, networkId: 'Preview' };
  });
  afterAll(async () => { await http.close(); });

  it('restores onto the ledger-9 Dust checkpoint, instead of being built from its keys', async () => {
    const checkpoint = ledger.DustLocalState.deserialize(Buffer.from(DUST_STATE_OWNED_HEX, 'hex'));
    saveDustCache('preview', dustPublicKeyHexFromSeed(SEED), { ledgerVersion: 9, state: checkpoint }, 395_185, root);
    const notices: string[] = [];

    const state = await new WalletDataRepository(testHost()).walletStateToRestore(SEED, network, 'preview', root, (line) => notices.push(line));

    expect(state, 'a wallet to restore: built from its keys, it would replay all Dust in WASM').not.toBeNull();
    const dust = JSON.parse(state!.dust) as DustSnapshotFields;
    expect(BigInt(dust.protocolVersion), 'the snapshot is on the checkpoint\'s ledger').toBe(BigInt(PREVIEW_TIP.protocolVersion));
    expect(dust.offset).toBe('395185');
    expect(dust.state).toBe(Buffer.from(checkpoint.serialize()).toString('hex'));
    expect(await restoresOnLedger9(state!.dust, network)).toBe(395_185n);
    expect(notices).toEqual([]);
  });
});

describe('dust export on a chain that forked from ledger 8', () => {
  type FixtureEvent = { id: number; protocolVersion: number; raw: string };
  const isLedger9 = (e: FixtureEvent) => BigInt(e.protocolVersion) >= FORK_SCHEDULE.v9;
  /** A cold read's events: the start of mainnet's timeline (ledger 8), then the timeline from the fork on (ledger 9). */
  const events = [...(fixture.start as FixtureEvent[]), ...(fixture.fork as FixtureEvent[]).filter(isLedger9)];
  const lastId = events.at(-1)!.id;

  let http: LocalIndexer;
  let ws: FakeEventIndexer;
  let network: NetworkConfig;
  beforeAll(async () => {
    http = await forkedChainIndexer();
    ws = await startFakeEventIndexer('dustLedgerEvents', events.map((e) => ({ ...e, maxId: lastId })));
    const closed = await closedPort();
    network = { indexer: http.url, indexerWS: ws.url, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}`, networkId: 'MainNet' };
  });
  afterAll(async () => { await ws.close(); await http.close(); });

  it('exports a snapshot on ledger 9 that the SDK restores at the synced event', async () => {
    const repository = new WalletDataRepository(testHost(), {
      fetchTip: async () => PREVIEW_TIP.hash,
      fetchChainId: async () => null,
      fetchEventTip: async () => lastId,
    });

    const result = await exportDustSnapshot(SEED, 'mainnet', network, { root, notice: () => {}, repository });

    expect(result.partial).toBe(false);
    expect(result.offset).toBe(lastId);
    const snapshot = JSON.parse(result.snapshot) as DustSnapshotFields;
    expect(BigInt(snapshot.protocolVersion) >= FORK_SCHEDULE.v9).toBe(true);
    expect(snapshot.offset).toBe(String(lastId));
    expect(await restoresOnLedger9(result.snapshot, network)).toBe(BigInt(lastId));
  });
});
