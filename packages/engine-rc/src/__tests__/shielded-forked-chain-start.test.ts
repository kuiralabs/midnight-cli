// A wallet on a chain that forked from ledger 8 to ledger 9 (preprod) starts
// its shielded wallet on ledger 9, on the direct shielded reader's checkpoint.
//
// Regression: `mn dust register --network preprod` for a wallet with no saved
// state failed with "This transaction was built for protocol version 2000000,
// ... The caller acts at protocol versions 0 up to (but not including)
// 2000000". The SDK started the wallet's shielded wallet at preprod's genesis
// version (22000, ledger 8), lite sync doesn't wait for it, and the facade acts
// at the lowest of its three wallets' versions, so it refused the ledger-9
// registration the unshielded and Dust wallets built.
//
// The chain is stood in for at its external boundary only: an HTTP indexer
// answering block queries with preprod's real genesis (ledger 8) and tip
// (ledger 9), and a WebSocket indexer replaying a real ledger-8 zswap timeline
// (fixtures/zswap-events-localnet-ledger8.json, where the seed 0x01 owns
// shielded NIGHT and tokens) under preprod's ledger-8 version. The facade, the
// SDK's shielded wallet and mn's reader are real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as rx from 'rxjs';
import * as ledger from '@midnightntwrk/ledger-v9';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { saveWalletCache } from '@kuiralabs/midnight-cli-core/engine';
import { deriveUnshieldedAddress } from '../derive-address.ts';
import { buildFacade, stopFacade, type FacadeBundle } from '../facade.ts';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { loadShieldedCache, shieldedCoinPublicKeyHexFromSeed } from '../shielded-direct-cache.ts';
import { shieldedSnapshotLedger } from '../shielded-snapshot.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import localnetFixture from './fixtures/zswap-events-localnet-ledger8.json';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';
import { startFakeEventIndexer, type FakeEventIndexer } from '../../../../test-support/fake-event-indexer.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';
import { testHost } from '../../../../test-support/test-host.ts';

/** Preprod's blocks as its indexer reported them on 2026-11-11: the genesis (ledger 8) and the tip after the fork (ledger 9). */
const PREPROD_GENESIS = { height: 0, hash: 'df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b', protocolVersion: 22_000, timestamp: 1754395200000 };
const PREPROD_TIP = { height: 3381851, hash: '1d61ff96f1fb14cb8a8e7e01a3f4e1082ec1b02e5bda81500775d681c877c4eb', protocolVersion: 2_001_100, timestamp: 1794433500000 };
/** A localnet born on ledger 9: its first block is already past the fork. */
const LEDGER9_GENESIS = { ...PREPROD_GENESIS, protocolVersion: 2_001_000 };

/** The wallet seed whose shielded keys the localnet genesis funded: 150M NIGHT in 3 coins after its transfer, and 50M of each of two tokens. */
const SEED = Buffer.from('00'.repeat(31) + '01', 'hex');
const NIGHT_150M = 150_000_000_000_000n;
const ZSWAP_EVENTS = (localnetFixture.events as { id: number; raw: string }[]);
const LAST_EVENT = ZSWAP_EVENTS.at(-1)!.id;

/** An indexer whose block at height 0 is `genesis`, and any other block query the ledger-9 tip. */
function chainIndexer(genesis: typeof PREPROD_GENESIS): Promise<LocalIndexer> {
  return startLocalIndexer(({ variables, query }) => {
    const offset = variables?.offset as { height?: number } | undefined;
    const atGenesis = offset?.height === 0 || /height:\s*0/.test(query);
    return JSON.stringify({ data: { block: atGenesis ? genesis : PREPROD_TIP } });
  });
}

/** What the facade's shielded wallet is on, and holds, before it syncs anything. */
async function shieldedOf(bundle: FacadeBundle) {
  const state = await rx.firstValueFrom(bundle.facade.state());
  return {
    protocolVersion: state.shielded.protocolVersion,
    appliedIndex: state.shielded.progress.appliedIndex,
    night: state.shielded.balances[ledger.unshieldedToken().raw] ?? 0n,
  };
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mn-shielded-start-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('a wallet on a chain that forked from ledger 8 (preprod)', () => {
  let http: LocalIndexer;
  let ws: FakeEventIndexer;
  let network: NetworkConfig;
  const notices: string[] = [];
  beforeAll(async () => {
    http = await chainIndexer(PREPROD_GENESIS);
    ws = await startFakeEventIndexer('zswapLedgerEvents', ZSWAP_EVENTS.map((e) => ({ ...e, protocolVersion: PREPROD_GENESIS.protocolVersion, maxId: LAST_EVENT })));
    const closed = await closedPort();
    network = { indexer: http.url, indexerWS: ws.url, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}`, networkId: 'PreProd' };
  });
  afterAll(async () => { await ws.close(); await http.close(); });

  async function built(cache: Parameters<typeof buildFacade>[4] = null): Promise<FacadeBundle> {
    return buildFacade(SEED, network, root, (line) => notices.push(line), cache);
  }

  it('the premise: built from its keys, its shielded wallet starts at the genesis version, below the fork', async () => {
    const bundle = await built();
    try {
      expect((await shieldedOf(bundle)).protocolVersion).toBe(BigInt(PREPROD_GENESIS.protocolVersion));
    } finally {
      await stopFacade(bundle);
    }
  });

  it('a new wallet starts its shielded wallet on ledger 9, on the shielded history read first', async () => {
    await new WalletDataRepository(testHost()).primeShielded(SEED, network, { root });
    const checkpoint = loadShieldedCache('preprod', shieldedCoinPublicKeyHexFromSeed(SEED), root);
    expect(checkpoint?.state.ledgerVersion, 'the read crossed to ledger 9 at the chain tip').toBe(9);

    const bundle = await built();
    try {
      const shielded = await shieldedOf(bundle);
      expect(shielded.protocolVersion >= FORK_SCHEDULE.v9, `shielded wallet at ${shielded.protocolVersion}`).toBe(true);
      expect(shielded.protocolVersion).toBe(BigInt(PREPROD_TIP.protocolVersion));
      expect(shielded.appliedIndex, 'it resumes after the checkpoint').toBe(BigInt(LAST_EVENT));
      expect(shielded.night, 'with the coins the history gave it').toBe(NIGHT_150M);
    } finally {
      await stopFacade(bundle);
    }
  });

  it('a saved wallet whose shielded wallet is still on ledger 8 starts it on the checkpoint', async () => {
    const fresh = await built();
    let saved: { shielded: string; unshielded: string; dust: string };
    try {
      const { shielded, unshielded, dust } = fresh.facade;
      saved = { shielded: await shielded.serializeState(), unshielded: await unshielded.serializeState(), dust: await dust.serializeState() };
    } finally {
      await stopFacade(fresh);
    }
    expect(shieldedSnapshotLedger(saved.shielded)).toBe(8);

    await new WalletDataRepository(testHost()).primeShielded(SEED, network, { root });
    const bundle = await built(saved);
    try {
      expect(bundle.restoredFromCache).toBe(true);
      const shielded = await shieldedOf(bundle);
      expect(shielded.protocolVersion).toBe(BigInt(PREPROD_TIP.protocolVersion));
      expect(shielded.night).toBe(NIGHT_150M);
    } finally {
      await stopFacade(bundle);
    }
  });

  it('mn serve\'s connector and a test\'s preparation build a new wallet with its shielded wallet on ledger 9', async () => {
    // Both build through primedFacade (wallet.ts: openConnector, syncedPrepWallet); the test preparation built from
    // its saved state alone, so on preprod a new wallet's shielded wallet started at 22000 and its Dust registration was refused.
    // The Dust read finds no Dust stream here and is skipped, as a failed read is.
    const bundle = await new WalletDataRepository(testHost()).primedFacade(SEED, network, { root, notice: (line) => notices.push(line) });
    try {
      const shielded = await shieldedOf(bundle);
      expect(shielded.protocolVersion).toBe(BigInt(PREPROD_TIP.protocolVersion));
      expect(shielded.night).toBe(NIGHT_150M);
    } finally {
      await stopFacade(bundle);
    }
  });

  it('reads nothing when the saved shielded wallet is past the fork already', async () => {
    await new WalletDataRepository(testHost()).primeShielded(SEED, network, { root });
    const bundle = await built();
    const before = ws.subscriptions.length;
    try {
      await saveWalletCache(deriveUnshieldedAddress(SEED, 'preprod'), 'preprod', bundle.facade, root);
    } finally {
      await stopFacade(bundle);
    }
    await new WalletDataRepository(testHost()).primeShielded(SEED, network, { root });
    expect(ws.subscriptions.length).toBe(before);
  });
});

describe('a wallet on a chain born on ledger 9 (a localnet)', () => {
  let http: LocalIndexer;
  let ws: FakeEventIndexer;
  let network: NetworkConfig;
  beforeAll(async () => {
    http = await chainIndexer(LEDGER9_GENESIS);
    ws = await startFakeEventIndexer('zswapLedgerEvents', []);
    const closed = await closedPort();
    network = { indexer: http.url, indexerWS: ws.url, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}`, networkId: 'Undeployed' };
  });
  afterAll(async () => { await ws.close(); await http.close(); });

  it('reads no shielded history first: a new shielded wallet starts on ledger 9 already', async () => {
    await new WalletDataRepository(testHost()).primeShielded(SEED, network, { root });
    expect(ws.subscriptions).toEqual([]);
    const bundle = await buildFacade(SEED, network, root, () => {}, null);
    try {
      expect((await shieldedOf(bundle)).protocolVersion).toBe(BigInt(LEDGER9_GENESIS.protocolVersion));
    } finally {
      await stopFacade(bundle);
    }
  });
});
