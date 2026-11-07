// The direct shielded reader on a chain that forked from ledger 8 to ledger 9,
// on Preview's real zswap events (fixtures/zswap-events-preview-fork.json, its
// whole timeline since the reset: ledger-8 events, then ledger-9 ones):
// ledger-8 events replay with ledger 8, the state crosses to ledger 9 whole at
// the fork, and the result equals what the wallet SDK's own shielded wallet
// machinery (its V1 and V2 sync capabilities and its cross-ledger migration,
// called here as the reference) makes of the same events.
//
// Preview's ledger-8 history holds no coin a known seed owns, so the crossing of
// owned coins is shown on a real ledger-8 localnet timeline
// (fixtures/zswap-events-localnet-ledger8.json) where the dev-preset genesis
// seeds own shielded NIGHT and tokens, crossed by the chain tip's version.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import * as sdkLedgerV8 from '@midnightntwrk/ledger-v8';
import { ProtocolVersion } from '@midnightntwrk/wallet-sdk';
import { CoreWallet as V1CoreWallet, Sync as V1Sync } from '@midnightntwrk/wallet-sdk/shielded/v1';
import { Migration as V2Migration, Sync as V2Sync, type CoreWallet as V2CoreWallet } from '@midnightntwrk/wallet-sdk/shielded/v2';
import previewFixture from './fixtures/zswap-events-preview-fork.json';
import localnetFixture from './fixtures/zswap-events-localnet-ledger8.json';
import { ShieldedEventFold, ZswapEventBeforeForkError, type RawZswapEvent } from '../shielded-event-fold.ts';
import { readShieldedBalanceDirect } from '../shielded-direct.ts';
import { loadShieldedCache, readShieldedBalanceCached, saveShieldedCache, shieldedCoinPublicKeyHexFromSeed } from '../shielded-direct-cache.ts';
import { crossShieldedToLedger9, shieldedKeysFromSeed, type ShieldedLedgerState } from '../shielded-ledger-state.ts';
import { deriveShieldedSeed } from '../derivation.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import { startFakeEventIndexer, type FakeEventIndexer } from '../../../../test-support/fake-event-indexer.ts';

/** A throwaway shielded seed: it owns nothing on Preview. */
const SEED = new Uint8Array(32).fill(7);
const KEYS = shieldedKeysFromSeed(SEED);
const NETWORK_ID = 'preview';
const NOW = new Date('2026-11-07T12:00:00Z');
/** The chain tip's protocol version on Preview after the fork. */
const PREVIEW_TIP = 2_001_100n;
/** The protocol version Preview's ledger-8 events are reported under. */
const LEDGER_8_VERSION = 1_000_000;
/** The commitment tree's next free index at Preview's tip when the fixture was read (the indexer's `zswapEndIndex`). */
const PREVIEW_ZSWAP_END_INDEX = 66n;

type FixtureEvent = { id: number; protocolVersion: number; raw: string };
const isLedger9 = (e: { protocolVersion: number }) => BigInt(e.protocolVersion) >= FORK_SCHEDULE.v9;

/** Events as the indexer serves them, `maxId` being the stream's last id. */
type ServedEvent = RawZswapEvent & { protocolVersion: number };
function served(events: FixtureEvent[]): ServedEvent[] {
  const maxId = events.at(-1)!.id;
  return events.map((e) => ({ ...e, maxId }));
}

const PREVIEW = served(previewFixture.events as FixtureEvent[]);
const BEFORE_FORK = PREVIEW.filter((e) => !isLedger9(e));
const AFTER_FORK = PREVIEW.filter(isLedger9);

function fold(events: RawZswapEvent[], options: Partial<ConstructorParameters<typeof ShieldedEventFold>[0]> = {}, chainProtocolVersion: bigint | null = PREVIEW_TIP, partial = false) {
  const f = new ShieldedEventFold({ keys: KEYS, startFromId: 0, ...options });
  for (const e of events) f.push(e);
  return f.finish({ partial, chainProtocolVersion });
}

/** A state's bytes, whichever ledger library (ours or the SDK's copy of ledger 8) made it. */
const hex = (state: ShieldedLedgerState | { serialize(): Uint8Array }) =>
  Buffer.from(('ledgerVersion' in state ? state.state : state).serialize()).toString('hex');

const v1Range = ProtocolVersion.makeRange(ProtocolVersion.MinSupportedVersion, FORK_SCHEDULE.v9);
const v2Range = ProtocolVersion.makeRange(FORK_SCHEDULE.v9, ProtocolVersion.MaxSupportedVersion);
const sdkUpdates = (events: ServedEvent[]) => events.map((e) => ({ _tag: 'EventsSyncUpdate' as const, id: e.id, protocolVersion: e.protocolVersion, maxId: e.maxId, raw: e.raw }));

/**
 * The SDK's shielded wallet on the same events, through its own machinery: the
 * V1 variant's sync capability replays the batch up to its activation range's
 * end (the fork) and records the version that ends it, or a version signal from
 * the chain tip does; the runtime then hands over with the V2 variant's
 * cross-ledger migration (the one the SDK's shielded wallet registers); the V2
 * variant's sync capability completes the crossing and replays the rest.
 */
function sdkShieldedFold(shieldedSeed: Uint8Array, events: ServedEvent[], tipSignal?: { version: number; highestEventId: number }) {
  const sk8 = sdkLedgerV8.ZswapSecretKeys.fromSeed(shieldedSeed);
  const sk9 = ledgerV9.ZswapSecretKeys.fromSeed(shieldedSeed);
  const v1 = V1Sync.makeEventsSyncCapability();
  let [onV1] = v1.applyUpdate(V1CoreWallet.initEmpty(sk8, NETWORK_ID), V1Sync.WalletSyncUpdate.create(sdkUpdates(events), sk8, NOW), v1Range);
  if (tipSignal) [onV1] = v1.applyUpdate(onV1, V1Sync.VersionSignalSyncUpdate.create(tipSignal.version, tipSignal.highestEventId), v1Range);
  if (ProtocolVersion.withinRange(onV1.protocolVersion, v1Range)) return { ledgerVersion: 8 as const, wallet: onV1 };
  const migrated = Effect.runSync(V2Migration.makeCrossLedgerMigration().migrate(onV1));
  const [onV2] = V2Sync.makeEventsSyncCapability().applyUpdate(migrated, V2Sync.WalletSyncUpdate.create(sdkUpdates(events), sk9, NOW), v2Range);
  return { ledgerVersion: 9 as const, wallet: onV2 as V2CoreWallet };
}

describe('the premise: ledger 9 cannot read a forked chain\'s ledger-8 zswap events', () => {
  it('refuses Preview\'s first zswap event, a ledger-8 one (event[v9]), as mn did on Preview', () => {
    expect(PREVIEW[0].id).toBe(2);
    expect(PREVIEW[0].protocolVersion).toBeLessThan(Number(FORK_SCHEDULE.v9));
    expect(() => ledgerV9.Event.deserialize(Buffer.from(PREVIEW[0].raw, 'hex'))).toThrow(/expected header tag 'midnight:event\[v14\]:'/);
  });

  it('the fixture\'s protocol versions change ledger exactly where the event format does', () => {
    for (const e of PREVIEW) {
      const tag = Buffer.from(e.raw.slice(0, 64), 'hex').toString('latin1');
      expect(tag.startsWith(isLedger9(e) ? 'midnight:event[v14]:' : 'midnight:event[v9]:'), `event ${e.id}`).toBe(true);
    }
    expect(AFTER_FORK[0].id).toBe(4709);
    expect(BEFORE_FORK.length).toBe(28);
  });
});

describe('ShieldedEventFold across Preview\'s fork', () => {
  it('folds a cold read of the whole timeline across the fork, ending on ledger 9 with the chain\'s commitment tree', () => {
    const r = fold(PREVIEW);
    expect(r.state.ledgerVersion).toBe(9);
    expect(r.eventCount).toBe(PREVIEW.length);
    expect(r.lastAppliedEventId).toBe(4970);
    expect(r.partial).toBe(false);
    expect(r.balance).toBe(0n);
    // The ledger-9 events continue the tree the ledger-8 ones started, up to the indexer's own end index.
    expect(r.state.state.firstFree).toBe(PREVIEW_ZSWAP_END_INDEX);
  });

  it('equals what the SDK\'s shielded wallet machinery makes of the same events', () => {
    const ours = fold(PREVIEW);
    const sdk = sdkShieldedFold(SEED, PREVIEW);
    expect(sdk.ledgerVersion).toBe(9);
    expect(hex(ours.state)).toBe(hex(sdk.wallet.state));
    expect(ours.lastAppliedEventId).toBe(Number(sdk.wallet.progress.appliedIndex));
  });

  it('replays ledger-8 events with ledger 8, as the SDK\'s ledger-8 variant does, until the fork', () => {
    const ours = fold(served(BEFORE_FORK), {}, BigInt(LEDGER_8_VERSION));
    const sdk = sdkShieldedFold(SEED, served(BEFORE_FORK));
    expect(ours.state.ledgerVersion).toBe(8);
    expect(sdk.ledgerVersion).toBe(8);
    expect(hex(ours.state)).toBe(hex(sdk.wallet.state));
  });

  it('crosses the ledger-8 state whole: its bytes become the ledger-9 state, then the ledger-9 events replay on it', () => {
    const ledger8 = fold(served(BEFORE_FORK), {}, BigInt(LEDGER_8_VERSION));
    const crossed = crossShieldedToLedger9(ledger8.state);
    if (crossed.ledgerVersion !== 9) throw new Error('expected a ledger-9 state');
    expect(hex(crossed)).toBe(hex(ledger8.state));
    const events = AFTER_FORK.map((e) => ledgerV9.Event.deserialize(Buffer.from(e.raw, 'hex')));
    expect(hex(crossed.state.replayEventsWithChanges(KEYS.v9, events).state)).toBe(hex(fold(PREVIEW).state));
  });

  it('refuses a ledger-8 event after the fold has crossed to ledger 9', () => {
    const f = new ShieldedEventFold({ keys: KEYS, startFromId: 0 });
    for (const e of PREVIEW.slice(0, BEFORE_FORK.length + 2)) f.push(e);
    expect(() => f.push(BEFORE_FORK.at(-1)!)).toThrow(ZswapEventBeforeForkError);
  });

  it('reads an event the indexer gives no version for on the state\'s own ledger', () => {
    // The first event's version sets the state's ledger; the ledger-8 ones after it say nothing.
    const unversioned = PREVIEW.map((e, i) => (i > 0 && !isLedger9(e) ? { ...e, protocolVersion: null } : e));
    expect(hex(fold(unversioned).state)).toBe(hex(fold(PREVIEW).state));
  });
});

describe('ShieldedEventFold: a chain past the fork whose zswap timeline is all ledger 8', () => {
  const ledger8Only = served(BEFORE_FORK);

  it('crosses at the end of a caught-up read, as the SDK\'s version signal hands over', () => {
    const r = fold(ledger8Only, {}, PREVIEW_TIP);
    expect(r.state.ledgerVersion).toBe(9);
    expect(hex(r.state)).toBe(hex(fold(ledger8Only, {}, BigInt(LEDGER_8_VERSION)).state));
    expect(r.lastAppliedEventId).toBe(BEFORE_FORK.at(-1)!.id);
    const sdk = sdkShieldedFold(SEED, ledger8Only, { version: Number(PREVIEW_TIP), highestEventId: BEFORE_FORK.at(-1)!.id });
    expect(sdk.ledgerVersion).toBe(9);
    expect(hex(r.state)).toBe(hex(sdk.wallet.state));
  });

  it('stays on ledger 8 when the read stopped short (partial), so the next read resumes the ledger-8 events', () => {
    expect(fold(ledger8Only, {}, PREVIEW_TIP, true).state.ledgerVersion).toBe(8);
  });

  it('stays on ledger 8 when the read has not reached the indexer\'s last event', () => {
    const notCaughtUp = ledger8Only.map((e) => ({ ...e, maxId: e.maxId + 1 }));
    expect(fold(notCaughtUp, {}, PREVIEW_TIP).state.ledgerVersion).toBe(8);
  });

  it('stays on ledger 8 when the chain is below the fork or its version is unknown', () => {
    expect(fold(ledger8Only, {}, BigInt(LEDGER_8_VERSION)).state.ledgerVersion).toBe(8);
    expect(fold(ledger8Only, {}, null).state.ledgerVersion).toBe(8);
  });
});

describe('a wallet that owns shielded coins before the fork keeps them across it (real ledger-8 localnet events)', () => {
  // The capture predates protocol versions on the indexer, so the events are
  // served under Preview's ledger-8 version, to both our fold and the SDK's.
  const LOCALNET = served((localnetFixture.events as { id: number; raw: string }[]).map((e) => ({ ...e, protocolVersion: LEDGER_8_VERSION })));
  const lastId = LOCALNET.at(-1)!.id;
  const genesis = deriveShieldedSeed(Buffer.from('00'.repeat(31) + '01', 'hex'));
  const genesis2 = deriveShieldedSeed(Buffer.from('00'.repeat(31) + '02', 'hex'));
  const NIGHT_150M = 150_000_000_000_000n;
  const NIGHT_350M = 350_000_000_000_000n;
  const TOKENS = [['00'.repeat(31) + '01', 50_000_000_000_000n], ['00'.repeat(31) + '02', 50_000_000_000_000n]];

  function foldOwned(shieldedSeed: Uint8Array, events: RawZswapEvent[], options: Partial<ConstructorParameters<typeof ShieldedEventFold>[0]> = {}) {
    const f = new ShieldedEventFold({ keys: shieldedKeysFromSeed(shieldedSeed), startFromId: 0, ...options });
    for (const e of events) f.push(e);
    return f.finish({ partial: false, chainProtocolVersion: PREVIEW_TIP });
  }

  it('crosses the spender\'s coins (received and spent on ledger 8) to ledger 9 with the same balances', () => {
    const r = foldOwned(genesis, LOCALNET);
    expect(r.state.ledgerVersion).toBe(9);
    expect(r.balance).toBe(NIGHT_150M);
    expect(r.availableCoins).toBe(3);
    expect([...r.tokens]).toEqual(TOKENS);
    expect(foldOwned(genesis2, LOCALNET).balance).toBe(NIGHT_350M);
  });

  it('equals the SDK\'s crossing of the same wallet (V1 sync, version signal, migration, V2\'s completed crossing)', () => {
    const ours = foldOwned(genesis, LOCALNET);
    const sdk = sdkShieldedFold(genesis, LOCALNET, { version: Number(PREVIEW_TIP), highestEventId: lastId });
    expect(sdk.ledgerVersion).toBe(9);
    expect(hex(ours.state)).toBe(hex(sdk.wallet.state));
    // The SDK computed the coin hashes the crossing left pending: one per coin the state holds (3 NIGHT, 2 tokens).
    expect(ours.state.state.coins.size).toBe(5);
    expect(Object.keys(sdk.wallet.coinHashes).length).toBe(5);
  });

  it('holds no pending spend to release, and every crossed coin is spendable with the ledger-9 keys', () => {
    const r = foldOwned(genesis, LOCALNET);
    if (r.state.ledgerVersion !== 9) throw new Error('expected a ledger-9 state');
    const ledger9State = r.state.state;
    expect(ledger9State.pendingSpends.size).toBe(0);
    const keys9 = ledgerV9.ZswapSecretKeys.fromSeed(genesis);
    for (const coin of ledger9State.coins) {
      const [booked] = ledger9State.spend(keys9, coin, 0);
      expect(booked.pendingSpends.size).toBe(1);
    }
  });

  it('resumes the owner\'s ledger-8 checkpoint and ends where a cold read does', () => {
    let root: string | undefined;
    try {
      root = mkdtempSync(join(tmpdir(), 'mn-shielded-fork-owned-'));
      const dir = root;
      const keys = shieldedKeysFromSeed(genesis);
      const f = new ShieldedEventFold({
        keys, startFromId: 0, chunkSize: 10,
        onCheckpoint: (state, last) => saveShieldedCache('preview', 'aa'.repeat(32), state, last, dir),
      });
      for (const e of LOCALNET.slice(0, 20)) f.push(e);
      const cached = loadShieldedCache('preview', 'aa'.repeat(32), dir)!;
      expect(cached.state.ledgerVersion).toBe(8);
      const rest = LOCALNET.filter((e) => e.id > cached.lastAppliedEventId);
      const resumed = foldOwned(genesis, rest, { initialState: cached.state, startFromId: cached.lastAppliedEventId + 1 });
      expect(resumed.state.ledgerVersion).toBe(9);
      expect(resumed.balance).toBe(NIGHT_150M);
      expect(hex(resumed.state)).toBe(hex(foldOwned(genesis, LOCALNET).state));
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resuming a forked chain\'s shielded sync from a cached checkpoint', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mn-shielded-fork-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** Fold `events` from the start, checkpointing each chunk to the cache as the cached reader does. */
  function foldCheckpointing(events: RawZswapEvent[], chunkSize: number) {
    const f = new ShieldedEventFold({
      keys: KEYS, startFromId: 0, chunkSize,
      onCheckpoint: (state, lastAppliedEventId) => saveShieldedCache('preview', 'aa'.repeat(32), state, lastAppliedEventId, root),
    });
    for (const e of events) f.push(e);
    return f;
  }

  function resume(events: RawZswapEvent[]) {
    const cached = loadShieldedCache('preview', 'aa'.repeat(32), root)!;
    const rest = events.filter((e) => e.id > cached.lastAppliedEventId);
    return { cached, result: fold(rest, { initialState: cached.state, startFromId: cached.lastAppliedEventId + 1 }) };
  }

  it('resumes from a ledger-8 checkpoint (saved before the fork) and crosses as a cold read does', () => {
    foldCheckpointing(PREVIEW.slice(0, 20), 10); // a read killed mid-way through the ledger-8 history
    const { cached, result } = resume(PREVIEW);
    expect(cached.state.ledgerVersion).toBe(8);
    expect(cached.lastAppliedEventId).toBe(PREVIEW[19].id);
    expect(result.state.ledgerVersion).toBe(9);
    expect(hex(result.state)).toBe(hex(fold(PREVIEW).state));
  });

  it('resumes from a ledger-9 checkpoint (saved after the fork) and matches a cold read', () => {
    foldCheckpointing(PREVIEW.slice(0, BEFORE_FORK.length + 20), 10);
    const { cached, result } = resume(PREVIEW);
    expect(cached.state.ledgerVersion).toBe(9);
    expect(cached.lastAppliedEventId).toBe(AFTER_FORK[19].id);
    expect(hex(result.state)).toBe(hex(fold(PREVIEW).state));
  });

  it('checkpoints the ledger-8 state up to the last ledger-8 event when the fold crosses mid-chunk', () => {
    foldCheckpointing(PREVIEW.slice(0, BEFORE_FORK.length + 2), 1000);
    // No chunk filled, so the only checkpoint is the one the crossing flushed.
    const cached = loadShieldedCache('preview', 'aa'.repeat(32), root)!;
    expect(cached.state.ledgerVersion).toBe(8);
    expect(cached.lastAppliedEventId).toBe(BEFORE_FORK.at(-1)!.id);
  });
});

describe('readShieldedBalanceDirect on Preview (regression: "Failed to deserialize zswap event 2")', () => {
  let indexer: FakeEventIndexer;
  beforeAll(async () => { indexer = await startFakeEventIndexer('zswapLedgerEvents', PREVIEW); });
  afterAll(async () => { await indexer.close(); });

  it('reads Preview cold from its first (ledger-8) event and ends on ledger 9, as the fold does', async () => {
    const r = await readShieldedBalanceDirect(KEYS, indexer.url, { chainProtocolVersion: PREVIEW_TIP, idleMs: 200 });
    expect(r.state.ledgerVersion).toBe(9);
    expect(r.eventCount).toBe(PREVIEW.length);
    expect(r.lastAppliedEventId).toBe(4970);
    expect(r.partial).toBe(false);
    expect(hex(r.state)).toBe(hex(fold(PREVIEW).state));
  });

  it('asks the indexer for each event\'s protocol version', () => {
    expect(indexer.subscriptions[0].query).toMatch(/zswapLedgerEvents\(id: \$id\)\s*{[^}]*protocolVersion/);
  });
});

describe('readShieldedBalanceCached on Preview', () => {
  let root: string;
  /** The events the indexer serves; it reads this list at each subscription, so a test can start it empty. */
  let served: ServedEvent[];
  let indexer: FakeEventIndexer;
  const WALLET_SEED = Buffer.from('00'.repeat(31) + 'aa', 'hex');
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mn-shielded-fork-cached-'));
    served = [...PREVIEW];
    indexer = await startFakeEventIndexer('zswapLedgerEvents', served);
  });
  afterEach(async () => {
    await indexer.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps nothing from a cold read cut short before its first event, so the next read starts at the ledger-8 events', async () => {
    // Cut short with no event, the state is the tip's ledger 9 at cursor -1; kept, the next read would refuse event 2.
    served.length = 0;
    const cut = await readShieldedBalanceCached(WALLET_SEED, 'preview', indexer.url, { root, chainProtocolVersion: PREVIEW_TIP, timeoutMs: 300 });
    expect(cut.partial).toBe(true);
    expect(loadShieldedCache('preview', shieldedCoinPublicKeyHexFromSeed(WALLET_SEED), root)).toBeNull();
    served.push(...PREVIEW);
    const next = await readShieldedBalanceCached(WALLET_SEED, 'preview', indexer.url, { root, chainProtocolVersion: PREVIEW_TIP });
    expect(next.partial).toBe(false);
    expect(next.fromCache).toBe(false);
    expect(next.lastAppliedEventId).toBe(4970);
  });

  it('saves the crossed state as ledger 9 and resumes it', async () => {
    await readShieldedBalanceCached(WALLET_SEED, 'preview', indexer.url, { root, chainProtocolVersion: PREVIEW_TIP });
    const saved = loadShieldedCache('preview', shieldedCoinPublicKeyHexFromSeed(WALLET_SEED), root)!;
    expect(saved.state.ledgerVersion).toBe(9);
    expect(saved.lastAppliedEventId).toBe(4970);
    const again = await readShieldedBalanceCached(WALLET_SEED, 'preview', indexer.url, { root, chainProtocolVersion: PREVIEW_TIP });
    expect(again.fromCache).toBe(true);
    expect(again.eventCount).toBe(0);
    expect(again.lastAppliedEventId).toBe(4970);
  });
});
