// The direct Dust reader on a chain that forked from ledger 8 to ledger 9, on
// real mainnet Dust events around its fork (fixtures/dust-events-mainnet-fork.json):
// ledger-8 events fold with ledger 8, the fork crosses with the SDK's migration,
// and the result equals what the wallet SDK's own forking Dust wallet machinery
// (its V1 and V2 sync capabilities and its cross-ledger migration, called here
// as the reference) makes of the same events.

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import * as sdkLedgerV8 from '@midnightntwrk/ledger-v8';
import { ProtocolVersion } from '@midnightntwrk/wallet-sdk';
import { dustVariantConfigurations } from '@midnightntwrk/wallet-sdk/dust';
import { CoreWallet as V1CoreWallet, SyncService as V1Sync } from '@midnightntwrk/wallet-sdk/dust/v1';
import { CoreWallet as V2CoreWallet, SyncService as V2Sync } from '@midnightntwrk/wallet-sdk/dust/v2';
import fixture from './fixtures/dust-events-mainnet-fork.json';
import { DustEventFold, DustEventBeforeForkError, type RawDustEvent } from '../dust-event-fold.ts';
import { readDustBalanceDirect } from '../dust-direct.ts';
import { crossToLedger9, dustKeysFromSeed, type DustLedgerState } from '../dust-ledger-state.ts';
import { loadDustCache, saveDustCache } from '../dust-direct-cache.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import { collapseForeignGenerations } from '../dust-collapse.ts';
import { startFakeEventIndexer, type FakeEventIndexer } from '../../../../test-support/fake-event-indexer.ts';

/** A throwaway Dust seed: it owns nothing on mainnet, so the states are compared whole (trees, parameters, time). */
const SEED = new Uint8Array(32).fill(7);
const KEYS = dustKeysFromSeed(SEED);
const NETWORK_ID = 'mainnet';
const NOW = new Date('2026-11-06T22:00:00Z');
/** The chain tip's protocol version on mainnet after the fork. */
const MAINNET_TIP = 2_001_100n;
const LEDGER_8_VERSION = 1_000_300n;

type FixtureEvent = { id: number; protocolVersion: number; raw: string };
const isLedger9 = (e: FixtureEvent) => BigInt(e.protocolVersion) >= FORK_SCHEDULE.v9;

/** The fixture events as the indexer serves them, `maxId` being the stream's last id. */
type ServedEvent = RawDustEvent & { protocolVersion: number };
function served(events: FixtureEvent[]): ServedEvent[] {
  const maxId = events.at(-1)!.id;
  return events.map((e) => ({ ...e, maxId }));
}

/**
 * The events a cold read of a forked chain gets, cut to what the fixture holds:
 * the start of the timeline (ledger 8), then the timeline from the fork on
 * (ledger 9). The ledger-8 events just below the fork can't follow the start
 * (their commitments sit at tree index ~1.55M), and the crossing discards the
 * ledger-8 state anyway.
 */
const START = fixture.start as FixtureEvent[];
const FORK_WINDOW = fixture.fork as FixtureEvent[];
const AFTER_FORK = FORK_WINDOW.filter(isLedger9);
const ACROSS = served([...START, ...AFTER_FORK]);

function fold(events: RawDustEvent[], options: Partial<ConstructorParameters<typeof DustEventFold>[0]> = {}, chainProtocolVersion: bigint | null = MAINNET_TIP, partial = false) {
  const f = new DustEventFold({ keys: KEYS, networkId: NETWORK_ID, startFromId: 0, collapse: false, ...options });
  for (const e of events) f.push(e);
  return f.finish({ partial, chainProtocolVersion, now: NOW });
}

/** A state's bytes, whichever ledger library (ours or the SDK's copy of ledger 8) made it. */
const hex = (state: DustLedgerState | { serialize(): Uint8Array }) =>
  Buffer.from(('ledgerVersion' in state ? state.state : state).serialize()).toString('hex');

/**
 * The SDK's forking Dust wallet on the same events, through its own machinery:
 * the V1 variant's sync capability folds the batch up to its activation range's
 * end (the fork) and records the version that ends it; the runtime then hands
 * over with the V2 variant's cross-ledger migration, valued as the facade's
 * Dust wallet values it (`dustVariantConfigurations`); the V2 variant's sync
 * capability folds the rest.
 */
function sdkForkingFold(events: ServedEvent[]) {
  const sk8 = sdkLedgerV8.DustSecretKey.fromSeed(SEED);
  const sk9 = ledgerV9.DustSecretKey.fromSeed(SEED);
  const { v1, migration } = dustVariantConfigurations({});
  const v1Range = ProtocolVersion.makeRange(ProtocolVersion.MinSupportedVersion, FORK_SCHEDULE.v9);
  const v2Range = ProtocolVersion.makeRange(FORK_SCHEDULE.v9, ProtocolVersion.MaxSupportedVersion);

  const [onV1] = V1Sync.makeDefaultSyncCapability().applyUpdate(
    V1CoreWallet.initEmpty(v1.dustParameters, sk8, NETWORK_ID),
    V1Sync.WalletSyncUpdate.create(events, sk8, NOW),
    v1Range,
  );
  if (ProtocolVersion.withinRange(onV1.protocolVersion, v1Range)) return { ledgerVersion: 8 as const, wallet: onV1 };
  const migrated = Effect.runSync(migration().migrate(onV1));
  const [onV2] = V2Sync.makeDefaultSyncCapability().applyUpdate(
    migrated,
    { _tag: 'Events', updates: events, secretKey: sk9, timestamp: NOW },
    v2Range,
  );
  return { ledgerVersion: 9 as const, wallet: onV2 as V2CoreWallet };
}

describe('the premise: ledger 9 cannot read a forked chain\'s ledger-8 Dust events', () => {
  it('refuses mainnet\'s first Dust event, a ledger-8 one (event[v9])', () => {
    expect(START[0].protocolVersion).toBeLessThan(Number(FORK_SCHEDULE.v9));
    expect(() => ledgerV9.Event.deserialize(Buffer.from(START[0].raw, 'hex'))).toThrow(/expected header tag 'midnight:event\[v14\]:'/);
  });

  it('the fixture\'s protocol versions change ledger exactly where the event format does', () => {
    for (const e of [...START, ...FORK_WINDOW]) {
      const tag = Buffer.from(e.raw.slice(0, 64), 'hex').toString('latin1');
      expect(tag.startsWith(isLedger9(e) ? 'midnight:event[v14]:' : 'midnight:event[v9]:'), `event ${e.id}`).toBe(true);
    }
    expect(FORK_WINDOW.find(isLedger9)!.id).toBe(1_623_187);
  });
});

describe('DustEventFold across the fork', () => {
  it('folds a cold read from the start of the timeline across the fork, ending on ledger 9', () => {
    const r = fold(ACROSS);
    expect(r.state.ledgerVersion).toBe(9);
    expect(r.eventCount).toBe(ACROSS.length);
    expect(r.lastAppliedEventId).toBe(AFTER_FORK.at(-1)!.id);
    expect(r.partial).toBe(false);
    expect(r.balance).toBe(0n);
  });

  it('equals what the SDK\'s forking Dust wallet machinery makes of the same events', () => {
    const ours = fold(ACROSS);
    const sdk = sdkForkingFold(ACROSS);
    expect(sdk.ledgerVersion).toBe(9);
    expect(hex(ours.state)).toBe(hex(sdk.wallet.state));
    expect(ours.balance).toBe(sdk.wallet.state.walletBalance(NOW));
    expect(ours.lastAppliedEventId).toBe(Number(sdk.wallet.progress.appliedIndex));
  });

  it('folds ledger-8 events with ledger 8, as the SDK\'s ledger-8 variant does, until the fork', () => {
    const ours = fold(served(START), {}, LEDGER_8_VERSION);
    const sdk = sdkForkingFold(served(START));
    expect(ours.state.ledgerVersion).toBe(8);
    expect(sdk.ledgerVersion).toBe(8);
    expect(hex(ours.state)).toBe(hex(sdk.wallet.state));
  });

  it('crosses with the SDK migration\'s state: the ledger-8 history carries no Dust over', () => {
    // Fold only up to the first ledger-9 event: the state is then the migration's, plus that one event.
    const justPast = served([...START, AFTER_FORK[0]]);
    const crossed = crossToLedger9({ publicKey: KEYS.v9.publicKey, networkId: NETWORK_ID, protocolVersion: BigInt(AFTER_FORK[0].protocolVersion), lastAppliedEventId: START.at(-1)!.id });
    expect(crossed.ledgerVersion).toBe(9);
    const expected = crossed.state.replayEvents(KEYS.v9, [ledgerV9.Event.deserialize(Buffer.from(AFTER_FORK[0].raw, 'hex'))]).processTtls(NOW);
    expect(hex(fold(justPast).state)).toBe(hex(expected));
  });

  it('starts the retention data again at the fork: the ledger-9 generation tree starts at index 0', () => {
    const r = fold(ACROSS);
    const ledger9InitialUtxos = AFTER_FORK.filter((e) => (ledgerV9.Event.deserialize(Buffer.from(e.raw, 'hex')).content as { tag: string }).tag === 'dustInitialUtxo');
    expect(r.retention.generationFrontier).toBe(ledger9InitialUtxos.length);
    expect(r.retention.ownedGenerationIndices).toEqual([]);
  });

  it('collapses foreign generations on both ledgers without changing the balance or the tree roots', () => {
    const ledger8Plain = fold(served(START), {}, LEDGER_8_VERSION);
    const ledger8Collapsed = fold(served(START), { collapse: true }, LEDGER_8_VERSION);
    expect(ledger8Collapsed.state.ledgerVersion).toBe(8);
    expect(ledger8Collapsed.state.state.generatingTreeRoot()).toBe(ledger8Plain.state.state.generatingTreeRoot());
    // The collapse runs on a ledger-8 state (rather than skipping it), and passes its guard.
    const owned = new Set<bigint>();
    if (ledger8Plain.state.ledgerVersion !== 8) throw new Error('expected a ledger-8 state');
    const outcome = collapseForeignGenerations(ledger8Plain.state.state, owned, BigInt(ledger8Plain.retention.generationFrontier));
    expect(outcome).toMatchObject({ collapsed: true, rangesCollapsed: 1 });

    const plain = fold(ACROSS);
    const collapsed = fold(ACROSS, { collapse: true });
    expect(collapsed.balance).toBe(plain.balance);
    expect(collapsed.state.state.generatingTreeRoot()).toBe(plain.state.state.generatingTreeRoot());
  });

  it('refuses a ledger-8 event after the fold has crossed to ledger 9', () => {
    const f = new DustEventFold({ keys: KEYS, networkId: NETWORK_ID, startFromId: 0, collapse: false });
    for (const e of served(AFTER_FORK.slice(0, 3))) f.push(e);
    const late = served(FORK_WINDOW.filter((e) => !isLedger9(e)))[0];
    expect(() => f.push(late)).toThrow(DustEventBeforeForkError);
  });

  it('reads an event the indexer gives no version for on the state\'s own ledger', () => {
    // The first event's version sets the state's ledger; the ledger-8 ones after it say nothing.
    const unversioned = ACROSS.map((e, i) => (i > 0 && !isLedger9(e as FixtureEvent) ? { ...e, protocolVersion: null } : e));
    expect(hex(fold(unversioned).state)).toBe(hex(fold(ACROSS).state));
  });
});

describe('DustEventFold: a chain past the fork whose Dust timeline is all ledger 8 (Preview\'s indexer at its fork block)', () => {
  const ledger8Only = served(START);
  const emptyLedger9 = crossToLedger9({ publicKey: KEYS.v9.publicKey, networkId: NETWORK_ID, protocolVersion: MAINNET_TIP, lastAppliedEventId: START.at(-1)!.id });

  it('crosses at the end of a caught-up read, as the SDK\'s version signal hands over', () => {
    const r = fold(ledger8Only, {}, MAINNET_TIP);
    expect(r.state.ledgerVersion).toBe(9);
    expect(hex(r.state)).toBe(hex(emptyLedger9.state.processTtls(NOW)));
    expect(r.lastAppliedEventId).toBe(START.at(-1)!.id);
  });

  it('stays on ledger 8 when the read stopped short (partial), so the next read resumes the ledger-8 events', () => {
    expect(fold(ledger8Only, {}, MAINNET_TIP, true).state.ledgerVersion).toBe(8);
  });

  it('stays on ledger 8 when the read has not reached the indexer\'s last event', () => {
    const notCaughtUp = ledger8Only.map((e) => ({ ...e, maxId: e.maxId + 1 }));
    expect(fold(notCaughtUp, {}, MAINNET_TIP).state.ledgerVersion).toBe(8);
  });

  it('stays on ledger 8 when the chain is below the fork or its version is unknown', () => {
    expect(fold(ledger8Only, {}, LEDGER_8_VERSION).state.ledgerVersion).toBe(8);
    expect(fold(ledger8Only, {}, null).state.ledgerVersion).toBe(8);
  });
});

describe('resuming a forked chain\'s Dust sync from a cached checkpoint', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mn-dust-fork-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** Fold `events` from the start, checkpointing each chunk to the cache as the repository does. */
  function foldCheckpointing(events: RawDustEvent[], chunkSize: number) {
    const f = new DustEventFold({
      keys: KEYS, networkId: NETWORK_ID, startFromId: 0, collapse: true, chunkSize,
      onCheckpoint: (state, lastAppliedEventId, retention) => saveDustCache('mainnet', 'aa'.repeat(32), state, lastAppliedEventId, root, undefined, retention),
    });
    for (const e of events) f.push(e);
    return f;
  }

  function resume(events: RawDustEvent[]) {
    const cached = loadDustCache('mainnet', 'aa'.repeat(32), root)!;
    const rest = events.filter((e) => e.id > cached.lastAppliedEventId);
    return { cached, result: fold(rest, { initialState: cached.state, initialRetention: cached.retention, startFromId: cached.lastAppliedEventId + 1, collapse: true }) };
  }

  it('resumes from a ledger-8 checkpoint (saved before the fork) and crosses as a cold read does', () => {
    foldCheckpointing(ACROSS.slice(0, 100), 50); // a read killed mid-way through the ledger-8 history
    const { cached, result } = resume(ACROSS);
    expect(cached.state.ledgerVersion).toBe(8);
    expect(cached.lastAppliedEventId).toBe(ACROSS[99].id);
    expect(result.state.ledgerVersion).toBe(9);
    expect(hex(result.state)).toBe(hex(fold(ACROSS, { collapse: true }).state));
  });

  it('resumes from a ledger-9 checkpoint (saved after the fork) and matches a cold read', () => {
    foldCheckpointing(ACROSS.slice(0, START.length + 20), 10);
    const { cached, result } = resume(ACROSS);
    expect(cached.state.ledgerVersion).toBe(9);
    expect(cached.lastAppliedEventId).toBe(AFTER_FORK[19].id);
    expect(result.state.ledgerVersion).toBe(9);
    expect(hex(result.state)).toBe(hex(fold(ACROSS, { collapse: true }).state));
    expect(result.retention).toEqual(fold(ACROSS, { collapse: true }).retention);
  });

  it('checkpoints the ledger-8 state up to the last ledger-8 event when the fold crosses mid-chunk', () => {
    foldCheckpointing(served([...START, ...AFTER_FORK.slice(0, 2)]), 1000);
    // No chunk filled, so the only checkpoint is the one the crossing flushed.
    const cached = loadDustCache('mainnet', 'aa'.repeat(32), root)!;
    expect(cached.state.ledgerVersion).toBe(8);
    expect(cached.lastAppliedEventId).toBe(START.at(-1)!.id);
  });
});

describe('readDustBalanceDirect on a forked chain (regression: "Failed to deserialize dust event 1")', () => {
  let indexer: FakeEventIndexer;
  beforeAll(async () => { indexer = await startFakeEventIndexer('dustLedgerEvents', ACROSS); });
  afterAll(async () => { await indexer.close(); });

  it('reads a forked chain cold from its first (ledger-8) event and ends on ledger 9, as the fold does', async () => {
    const r = await readDustBalanceDirect(KEYS, indexer.url, { networkId: NETWORK_ID, chainProtocolVersion: MAINNET_TIP, collapse: false, idleMs: 200 });
    expect(r.state.ledgerVersion).toBe(9);
    expect(r.eventCount).toBe(ACROSS.length);
    expect(r.lastAppliedEventId).toBe(AFTER_FORK.at(-1)!.id);
    expect(r.partial).toBe(false);
    expect(r.balance).toBe(0n);
    expect(r.state.state.generatingTreeRoot()).toBe(fold(ACROSS).state.state.generatingTreeRoot());
  });

  it('asks the indexer for each event\'s protocol version', () => {
    expect(indexer.subscriptions[0].query).toMatch(/dustLedgerEvents\(id: \$id\)\s*{[^}]*protocolVersion/);
  });
});
