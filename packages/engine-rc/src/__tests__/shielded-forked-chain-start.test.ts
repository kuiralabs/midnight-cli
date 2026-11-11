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
// answering block queries with a real genesis (ledger 8) and tip (ledger 9),
// and a WebSocket indexer replaying real zswap timelines (a ledger-8 localnet
// one where the seed 0x01 owns shielded NIGHT and tokens; Preview's across its
// fork), real Dust events across mainnet's fork, and the unshielded progress
// the indexer reports. The facade, the SDK's wallets and mn's readers are real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as rx from 'rxjs';
import * as ledger from '@midnightntwrk/ledger-v9';
import { settingsFromEnvironment, WalletBehindForkError, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { bindCachesToIndexer, saveWalletCache } from '@kuiralabs/midnight-cli-core/engine';
import { buildFacade, stopFacade, type FacadeBundle } from '../facade.ts';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { createRcWallet } from '../wallet.ts';
import { deriveUnshieldedAddress } from '../derive-address.ts';
import { loadShieldedCache, saveShieldedCache, shieldedCoinPublicKeyHexFromSeed } from '../shielded-direct-cache.ts';
import { ShieldedEventFold, type RawZswapEvent } from '../shielded-event-fold.ts';
import { shieldedKeysFromSeed } from '../shielded-ledger-state.ts';
import { deriveShieldedSeed } from '../derivation.ts';
import { dustPublicKeyHexFromSeed, saveDustCache } from '../dust-direct-cache.ts';
import { shieldedSnapshotLedger, type ShieldedCheckpoint } from '../shielded-snapshot.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';
import localnetFixture from './fixtures/zswap-events-localnet-ledger8.json';
import previewFixture from './fixtures/zswap-events-preview-fork.json';
import dustFixture from './fixtures/dust-events-mainnet-fork.json';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';
import { startFakeChainIndexer, type FakeEventIndexer, type FakeStreams } from '../../../../test-support/fake-event-indexer.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';
import { testHost } from '../../../../test-support/test-host.ts';

/** Preprod's blocks as its indexer reported them on 2026-11-11: the genesis (ledger 8) and the tip after the fork (ledger 9). */
const PREPROD_GENESIS = { height: 0, hash: 'df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b', protocolVersion: 22_000, timestamp: 1754395200000 };
const PREPROD_TIP = { height: 3381851, hash: '1d61ff96f1fb14cb8a8e7e01a3f4e1082ec1b02e5bda81500775d681c877c4eb', protocolVersion: 2_001_100, timestamp: 1794433500000, zswapEndIndex: 66 };
/** Preview's genesis (ledger 8), as its indexer reported it on 2026-11-07. */
const PREVIEW_GENESIS = { height: 0, hash: '3c096de209e06a1a8c52be7bda109ee8c891a42288c0a9db5495f9616dd13796', protocolVersion: 1_000_000, timestamp: 1754395200000 };
/** A localnet born on ledger 9: its first block is already past the fork. */
const LEDGER9_GENESIS = { ...PREPROD_GENESIS, protocolVersion: 2_001_000 };

/** The wallet seed whose shielded keys the localnet genesis funded: 150M NIGHT in 3 coins after its transfer, and 50M of each of two tokens. */
const SEED = Buffer.from('00'.repeat(31) + '01', 'hex');
const NIGHT_150M = 150_000_000_000_000n;
const LOCALNET_EVENTS = (localnetFixture.events as { id: number; raw: string }[]);
const LOCALNET_LAST = LOCALNET_EVENTS.at(-1)!.id;
const served = <E extends { id: number }>(events: E[]) => events.map((e) => ({ ...e, maxId: events.at(-1)!.id }));
/** The localnet's ledger-8 zswap timeline, served under preprod's ledger-8 version. */
const LOCALNET_ZSWAP = served(LOCALNET_EVENTS.map((e) => ({ ...e, protocolVersion: PREPROD_GENESIS.protocolVersion })));
/** Preview's zswap timeline across its fork. */
const PREVIEW_ZSWAP = served(previewFixture.events as { id: number; raw: string; protocolVersion: number }[]);
const PREVIEW_LAST = PREVIEW_ZSWAP.at(-1)!.id;
/** Mainnet's Dust timeline: its start (ledger 8), then from its fork on (ledger 9). */
type DustEvent = { id: number; protocolVersion: number; raw: string };
const MAINNET_DUST = served([...(dustFixture.start as DustEvent[]), ...(dustFixture.fork as DustEvent[]).filter((e) => BigInt(e.protocolVersion) >= FORK_SCHEDULE.v9)]);
/** What the indexer tells an unshielded wallet with no transactions: nothing to apply, at the chain's version. */
const UNSHIELDED_PROGRESS = [{ type: 'UnshieldedTransactionsProgress', highestTransactionId: 0, protocolVersion: PREPROD_TIP.protocolVersion }];

/** An indexer whose block at height 0 is `genesis`, and any other block query the ledger-9 tip. */
function chainIndexer(genesis: typeof PREPROD_GENESIS): Promise<LocalIndexer> {
  return startLocalIndexer(({ variables, query }) => {
    const offset = variables?.offset as { height?: number } | undefined;
    const atGenesis = offset?.height === 0 || /height:\s*0/.test(query);
    return JSON.stringify({ data: { block: atGenesis ? genesis : PREPROD_TIP } });
  });
}

/** What the facade's shielded wallet is on, and holds. */
async function shieldedOf(bundle: FacadeBundle) {
  const state = await rx.firstValueFrom(bundle.facade.state());
  return {
    protocolVersion: state.shielded.protocolVersion,
    appliedIndex: state.shielded.progress.appliedIndex,
    night: state.shielded.balances[ledger.unshieldedToken().raw] ?? 0n,
  };
}

/** A repository whose Dust reads run in-process (the sidecar would read the fake indexer too, but needs no testing here). */
const repository = () => new WalletDataRepository(testHost({ settings: () => settingsFromEnvironment({ ...process.env, MN_DISABLE_NATIVE_DUST: '1' }) }));

/** The wallet's shielded checkpoint under `root`, as buildFacade is given it. */
const checkpointIn = (root: string, network: string): ShieldedCheckpoint | null => loadShieldedCache(network, shieldedCoinPublicKeyHexFromSeed(SEED), root);

// Every indexer is started once for the file: the genesis version is read once per indexer URL for the process.
const indexers: Array<{ close(): Promise<void> }> = [];
async function chain(genesis: typeof PREPROD_GENESIS, streams: FakeStreams, networkId: string): Promise<{ network: NetworkConfig; ws: FakeEventIndexer }> {
  const http = await chainIndexer(genesis);
  const ws = await startFakeChainIndexer(streams);
  indexers.push(http, ws);
  const closed = await closedPort();
  return { ws, network: { indexer: http.url, indexerWS: ws.url, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}`, networkId } };
}
afterAll(async () => { await Promise.all(indexers.map((i) => i.close())); });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mn-shielded-start-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('a wallet on a chain that forked from ledger 8 (preprod)', () => {
  let network: NetworkConfig;
  let ws: FakeEventIndexer;
  const notices: string[] = [];
  // No Dust events: a Dust read resumes the Dust checkpoint (savedDustCheckpoint) and finds nothing new.
  beforeAll(async () => { ({ network, ws } = await chain(PREPROD_GENESIS, { zswapLedgerEvents: LOCALNET_ZSWAP, dustLedgerEvents: [] }, 'PreProd')); });
  // Caches are kept per indexer: these were read from this one.
  const savedDustCheckpoint = () => {
    bindCachesToIndexer('preprod', network.indexerWS, root);
    saveDustCache('preprod', dustPublicKeyHexFromSeed(SEED), { ledgerVersion: 9, state: ledger.DustLocalState.deserialize(Buffer.from(DUST_STATE_OWNED_HEX, 'hex')) }, 395_185, root);
  };

  const built = (cache: Parameters<typeof buildFacade>[4] = null, checkpoint: ShieldedCheckpoint | null = null) =>
    buildFacade(SEED, network, root, (line) => notices.push(line), cache, undefined, undefined, checkpoint);

  it('the premise: built from its keys, its shielded wallet starts at the genesis version, below the fork', async () => {
    const bundle = await built();
    try {
      expect((await shieldedOf(bundle)).protocolVersion).toBe(BigInt(PREPROD_GENESIS.protocolVersion));
    } finally {
      await stopFacade(bundle);
    }
  });

  it('a new wallet starts its shielded wallet on ledger 9, on the shielded history read first', async () => {
    const primed = await repository().primeShielded(SEED, network, { root });
    expect(primed).toEqual({ read: true });
    const checkpoint = checkpointIn(root, 'preprod');
    expect(checkpoint?.state.ledgerVersion, 'the read crossed to ledger 9 at the chain tip').toBe(9);

    const bundle = await built(null, checkpoint);
    try {
      const shielded = await shieldedOf(bundle);
      expect(shielded.protocolVersion).toBe(BigInt(PREPROD_TIP.protocolVersion));
      expect(shielded.appliedIndex, 'it resumes after the checkpoint').toBe(BigInt(LOCALNET_LAST));
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

    await repository().primeShielded(SEED, network, { root });
    const bundle = await built(saved, checkpointIn(root, 'preprod'));
    try {
      expect(bundle.restoredFromCache).toBe(true);
      const shielded = await shieldedOf(bundle);
      expect(shielded.protocolVersion).toBe(BigInt(PREPROD_TIP.protocolVersion));
      expect(shielded.night).toBe(NIGHT_150M);
    } finally {
      await stopFacade(bundle);
    }
  });

  it('a checkpoint the SDK won\'t restore is set aside, with why, and the wallet starts as the SDK starts it', async () => {
    // A state whose bytes are not a zswap state: the SDK's restore refuses the snapshot.
    const unreadable = { coins: new Set(), pendingOutputs: new Map(), serialize: () => new Uint8Array([1, 2, 3]) } as unknown as ledger.ZswapLocalState;
    const bundle = await built(null, { state: { ledgerVersion: 9, state: unreadable }, lastAppliedEventId: LOCALNET_LAST });
    try {
      expect((await shieldedOf(bundle)).protocolVersion).toBe(BigInt(PREPROD_GENESIS.protocolVersion));
      expect(bundle.shieldedCheckpointRefused).toBeInstanceOf(Error);
    } finally {
      await stopFacade(bundle);
    }
  });

  it('reads nothing when the saved shielded wallet is past the fork already', async () => {
    const repo = repository();
    await repo.primeShielded(SEED, network, { root });
    const bundle = await built(null, checkpointIn(root, 'preprod'));
    try {
      await saveWalletCache(deriveUnshieldedAddress(SEED, 'preprod'), 'preprod', bundle.facade, root);
    } finally {
      await stopFacade(bundle);
    }
    const before = ws.subscriptions.length;
    expect(await repo.primeShielded(SEED, network, { root })).toEqual({ read: false });
    expect(ws.subscriptions.length).toBe(before);
  });

  it('mn serve\'s connector and a test\'s preparation (primedFacade) start a new wallet\'s shielded wallet on ledger 9, and its Dust wallet on its checkpoint', async () => {
    // The Dust read resumes the checkpoint already on disk; the wallet is new, so its Dust wallet starts on it.
    savedDustCheckpoint();
    const bundle = await repository().primedFacade(SEED, network, { root, notice: (line) => notices.push(line) });
    try {
      const state = await rx.firstValueFrom(bundle.facade.state());
      expect(state.shielded.protocolVersion).toBe(BigInt(PREPROD_TIP.protocolVersion));
      expect(state.shielded.balances[ledger.unshieldedToken().raw]).toBe(NIGHT_150M);
      expect(state.dust.protocolVersion >= FORK_SCHEDULE.v9, `Dust wallet at ${state.dust.protocolVersion}`).toBe(true);
      expect(state.dust.progress.appliedIndex).toBe(395_185n);
      expect(bundle.primeReport).toEqual({});
      expect(ws.subscriptions.some((s) => s.query.includes('dustLedgerEvents(')), 'the Dust history was read').toBe(true);
    } finally {
      await stopFacade(bundle);
    }
  });

  it('discards a shielded checkpoint past the indexer\'s last event (a reset chain), so it is not laid over the wallet', async () => {
    const keys = shieldedKeysFromSeed(deriveShieldedSeed(SEED));
    const fold = new ShieldedEventFold({ keys, startFromId: 0 });
    for (const e of LOCALNET_ZSWAP) fold.push(e as RawZswapEvent);
    const { state } = fold.finish({ partial: false, chainProtocolVersion: BigInt(PREPROD_TIP.protocolVersion) });
    bindCachesToIndexer('preprod', network.indexerWS, root);
    saveShieldedCache('preprod', shieldedCoinPublicKeyHexFromSeed(SEED), state, LOCALNET_LAST + 1_000, root);
    // The saved wallet is past the fork, so nothing is read first and the checkpoint is checked against the indexer.
    const fresh = await built(null, { state, lastAppliedEventId: LOCALNET_LAST });
    try {
      await saveWalletCache(deriveUnshieldedAddress(SEED, 'preprod'), 'preprod', fresh.facade, root);
    } finally {
      await stopFacade(fresh);
    }
    savedDustCheckpoint();
    const bundle = await repository().primedFacade(SEED, network, { root, notice: () => {} });
    await stopFacade(bundle);
    expect(checkpointIn(root, 'preprod'), 'deleted').toBeNull();
  });
});

describe('a failed shielded read on a forked chain', () => {
  let network: NetworkConfig;
  // An indexer that serves no event stream: the shielded read (and the Dust one) fail.
  beforeAll(async () => { ({ network } = await chain(PREPROD_GENESIS, {}, 'PreProd')); });

  it('is kept by primedFacade, and the fork check names it as the reason and the cause', async () => {
    const repo = repository();
    const bundle = await repo.primedFacade(SEED, network, { root, notice: () => {} });
    try {
      const failure = bundle.primeReport?.shielded?.failure;
      expect(failure).toBeInstanceOf(Error);
      const err = await repo.awaitPastFork(bundle, { timeoutMs: 1_100 }).catch((e: unknown) => e) as Error;
      expect(err).toBeInstanceOf(WalletBehindForkError);
      expect(err.cause).toBe(failure);
      expect(err.message).toContain(`the shielded wallet is at protocol version 22000 (reading its shielded history first failed: ${failure!.message})`);
    } finally {
      await stopFacade(bundle);
    }
  });
});

describe('a restored shielded wallet syncs on from its checkpoint (Preview\'s timeline across its fork)', () => {
  let network: NetworkConfig;
  beforeAll(async () => { ({ network } = await chain(PREVIEW_GENESIS, { zswapLedgerEvents: PREVIEW_ZSWAP }, 'Preview')); });

  it('applies each event after the checkpoint once, ending where a cold read of the whole timeline does', async () => {
    const keys = shieldedKeysFromSeed(deriveShieldedSeed(SEED));
    const fold = (events: typeof PREVIEW_ZSWAP) => {
      const f = new ShieldedEventFold({ keys, startFromId: 0 });
      for (const e of events) f.push(e);
      return f.finish({ partial: true, chainProtocolVersion: BigInt(PREPROD_TIP.protocolVersion) });
    };
    // The checkpoint: read to a ledger-9 event in the middle of the timeline after the fork.
    const afterFork = PREVIEW_ZSWAP.filter((e) => BigInt(e.protocolVersion) >= FORK_SCHEDULE.v9);
    const middle = afterFork[Math.floor(afterFork.length / 2)]!.id;
    const head = fold(PREVIEW_ZSWAP.filter((e) => e.id <= middle));
    expect(head.state.ledgerVersion).toBe(9);
    const whole = fold(PREVIEW_ZSWAP);

    const bundle = await buildFacade(SEED, network, root, () => {}, null, undefined, undefined, { state: head.state, lastAppliedEventId: middle });
    try {
      expect((await shieldedOf(bundle)).appliedIndex).toBe(BigInt(middle));
      await bundle.facade.start(bundle.seeds);
      await rx.firstValueFrom(bundle.facade.state().pipe(rx.filter((s) => s.shielded.progress.appliedIndex === BigInt(PREVIEW_LAST)), rx.timeout(20_000)));
      const synced = JSON.parse(await bundle.facade.shielded.serializeState()) as { state: string; offset: string };
      expect(synced.offset).toBe(String(PREVIEW_LAST));
      expect(synced.state, 'the same commitment tree and coins as a cold read: nothing applied twice, nothing lost').toBe(Buffer.from(whole.state.state.serialize()).toString('hex'));
    } finally {
      await stopFacade(bundle);
    }
  }, 30_000);
});

describe('a test\'s preparation, end to end on a forked chain', () => {
  let network: NetworkConfig;
  beforeAll(async () => {
    ({ network } = await chain(PREVIEW_GENESIS, { zswapLedgerEvents: PREVIEW_ZSWAP, dustLedgerEvents: MAINNET_DUST, unshieldedTransactions: UNSHIELDED_PROGRESS }, 'Preview'));
  });

  it('reads the Dust and shielded histories first, syncs, and has all three wallets past the fork', async () => {
    const messages: string[] = [];
    const balance = await createRcWallet(repository()).prepNightBalance({
      seed: SEED, root, notice: () => {}, network: 'preview', networkConfig: network, address: deriveUnshieldedAddress(SEED, 'preview'), onMessage: (m) => messages.push(m),
    });
    expect(balance).toBe(0n);
    expect(checkpointIn(root, 'preview')?.lastAppliedEventId).toBe(PREVIEW_LAST);
    expect(messages.some((m) => m.startsWith('Reading shielded events'))).toBe(true);
  }, 60_000);
});

describe('a wallet on a chain born on ledger 9 (a localnet)', () => {
  let network: NetworkConfig;
  let ws: FakeEventIndexer;
  beforeAll(async () => { ({ network, ws } = await chain(LEDGER9_GENESIS, { zswapLedgerEvents: [] }, 'Undeployed')); });

  it('reads no shielded history first: a new shielded wallet starts on ledger 9 already', async () => {
    expect(await repository().primeShielded(SEED, network, { root })).toEqual({ read: false });
    expect(ws.subscriptions).toEqual([]);
    const bundle = await buildFacade(SEED, network, root, () => {}, null);
    try {
      expect((await shieldedOf(bundle)).protocolVersion).toBe(BigInt(LEDGER9_GENESIS.protocolVersion));
    } finally {
      await stopFacade(bundle);
    }
  });
});
