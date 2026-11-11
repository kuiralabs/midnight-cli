// Wallet data repository — single owner of cache + tip-aware invalidation.
//
// What this hides from callers:
//   • In-memory layer (the engine's, so one per host; matters for the long-lived MCP server)
//   • On-disk layer (shared across `mn` shell invocations)
//   • Tip-aware invalidation (cache valid iff chain tip unchanged)
//   • Force-fresh override
//   • Chain-id (genesis hash) validation on chain reset
//   • Auto-invalidation of dependent reads after a write
//
// Four constructor seams (`now`, `fetchTip`, `fetchUnshielded`, `fetchDust`)
// make the cache + tip + invalidation logic unit-testable without spinning up
// the SDK, Docker, or the indexer. Production defaults wire to the existing
// `chain_getBlockHash` / `checkBalance` / `readDustBalanceDirect` paths.
//
// `withFacade` deliberately leaks the SDK's `FacadeBundle` so callers can
// build/sign/submit transactions. Tests of the write path remain integration
// tests against localnet — accepted scope per architecture-deepening.md.

import { Buffer } from 'node:buffer';
import { isColdStartRace, loadWalletCache, saveWalletCache, clearWalletCache, validateWalletCacheChainId, type WalletCacheData, bindCachesToIndexer, describeIndexerChange, type CachedReadOptions, type DustBalance, type EngineHost, type ReadOptions, type UnshieldedView } from '@kuiralabs/midnight-cli-core/engine';
import { throwIfCancelled, type NetworkConfig, type NetworkName, isValidNetworkName, clearDustDirectCache, type VerboseLog, type NoticeSink, LEDGER_9_FORK_VERSION, WalletBehindForkError, walletsBehindForkMessage } from '@kuiralabs/midnight-cli-core';

import { type FacadeState } from '@midnightntwrk/wallet-sdk/facade';
import {
  buildFacade,
  startAndSyncFacade,
  stopFacade,
  StaleCacheError,
  type FacadeBundle,
  type SyncMode,
  overlayDustDirectSnapshot,
  DustSnapshotLedgerMismatchError,
} from './facade.ts';
import { loadDustCache, saveDustCache, dustPublicKeyHexFromSeed, validateDustCacheChainId } from './dust-direct-cache.ts';
import { getChainGenesisHash, checkLedgerSupported, fetchGenesisProtocolVersion, fetchProtocolVersion, walletsBelowLedger9, checkBalance, type BalanceSummary, callNodeRpc, fetchEventTip, isCursorBeyondTip, type LedgerEventStream } from '@kuiralabs/midnight-chain';
import { readDustBalanceDirect, type DustDirectResult, type DustRetention } from './dust-direct.ts';
import { dustKeysFromSeed, type DustLedgerState } from './dust-ledger-state.ts';
import { isHostedNetwork, runDustSyncNative, sidecarSkipReason, sidecarUnavailableReason, wasmDustNotice } from './dust-sync-native.ts';
import { deriveDustSeed } from './derivation.ts';
import { deriveUnshieldedAddress } from './derive-address.ts';
import { readShieldedBalanceCached } from './shielded-direct-cache.ts';
import { shieldedSnapshotLedger } from './shielded-snapshot.ts';
import { ledgerOfProtocolVersion } from './fork-schedule.ts';
export type { CachedReadOptions, DustBalance, ReadOptions, UnshieldedView } from '@kuiralabs/midnight-cli-core/engine';

// ── Public types ──────────────────────────────────────────

export interface DustView extends DustBalance {
  /** Ledger 9 once the read is past the chain's fork; a partial read that stopped before it is still ledger 8. */
  state: DustLedgerState;
}


/** What the caller borrows during withFacade. SDK type leak is intentional. */
export interface FacadeLease {
  bundle: FacadeBundle;
  state: FacadeState;
}

export interface InvalidationScope {
  network: NetworkConfig;
  /** The state root whose saved wallet state the facade kind clears. */
  root: string;
  /** If set, scope invalidations to this seed's derived caches. */
  seed?: Buffer;
  /** If set, scope unshielded invalidation to this address. */
  address?: string;
  /** Which kinds to invalidate. Default: all. */
  kinds?: ReadonlyArray<'dust' | 'unshielded' | 'facade'>;
}


export interface FacadeOptions extends CachedReadOptions {
  syncMode?: SyncMode;
  requireStrictSync?: boolean;
  /** If true, skip the post-resolve invalidation (read-only borrowers). */
  readOnly?: boolean;
  /**
   * If true, skip the automatic post-resolve `saveWalletCache`. For callers
   * that have nuanced save logic — e.g. `mn serve` skips the save if there
   * are pending in-flight transactions, because the SDK drops `pendingDustTokens`
   * on serialization and persisting that state corrupts the dust balance.
   */
  skipAutoSave?: boolean;
  /** Per-attempt sync deadline. Default: SYNC_ATTEMPT_TIMEOUT_MS (local) or SYNC_ATTEMPT_REMOTE_TIMEOUT_MS (remote). */
  syncTimeoutMs?: number;
  /** Per-emission sync progress hook (forwards startAndSyncFacade onProgress). */
  onSyncProgress?: (applied: number, highest: number) => void;
  /** Per-emission detail hook (which wallets are still syncing). */
  onSyncDetail?: (detail: string) => void;
  /** Suppressed-but-relayed SDK transient warnings (Wallet.Sync, etc). */
  onSyncWarning?: (tag: string, message: string) => void;
  /** Suppress the dust pre-prime even in write mode (used by tests / debug). */
  noPrime?: boolean;
}

export type TipFingerprint = string;

export interface RepoDeps {
  /** Wall-clock source. Default: Date.now. */
  now?: () => number;
  /** Tip fetcher. Default: substrate `chain_getBlockHash`. */
  fetchTip?: (network: NetworkConfig, signal?: AbortSignal) => Promise<TipFingerprint>;
  /** Unshielded balance fetcher. Default: existing `checkBalance` over indexer WS. `signal` cancels it. */
  fetchUnshielded?: (
    address: string,
    network: NetworkConfig,
    onProgress?: (current: number, highest: number) => void,
    signal?: AbortSignal,
  ) => Promise<BalanceSummary>;
  /** Dust state fetcher. Default: existing `readDustBalanceDirect` over indexer WS. */
  fetchDust?: (
    seed: Buffer,
    network: NetworkConfig,
    opts: {
      startFromId: number;
      initialState?: DustLedgerState;
      initialRetention?: DustRetention;
      /** The chain tip's protocol version, read before the sync; null when unknown. */
      chainProtocolVersion: bigint | null;
      signal?: AbortSignal;
      onProgress?: (applied: number, max: number) => void;
      /** Repo passes a callback to persist incremental progress during long syncs. */
      onCheckpoint?: (state: DustLedgerState, lastAppliedEventId: number, retention: DustRetention) => void;
      /** The state root of the caches; the native sidecar keeps its checkpoint beside them. */
      root: string;
      /** The call's verbose lines. */
      log?: VerboseLog;
    },
  ) => Promise<DustDirectResult>;
  /** Chain genesis-hash fetcher (cache chain-reset guard). Default: `getChainGenesisHash`. */
  fetchChainId?: (nodeWsUrl: string) => Promise<string | null>;
  /** A ledger event stream's latest id, for the chain-reset check. Default: indexer subscription. */
  fetchEventTip?: (indexerWS: string, stream: LedgerEventStream) => Promise<number | null>;
  /** Chain protocol-version fetcher (ledger-9-only guard). Default: indexer `block { protocolVersion }`. */
  fetchProtocolVersion?: (indexerHttpUrl: string, signal?: AbortSignal) => Promise<bigint | null>;
  /** The protocol version of the chain's first block, where a new wallet starts. Default: indexer `block(offset: { height: 0 })`. */
  fetchGenesisProtocolVersion?: (indexerHttpUrl: string, signal?: AbortSignal) => Promise<bigint | null>;
  /** The direct shielded reader, read into its checkpoint under `root`. Default: `readShieldedBalanceCached`. */
  readShielded?: typeof readShieldedBalanceCached;
}

// ── Implementation ────────────────────────────────────────

interface MemoEntry<T> {
  value: T;
  fetchedAt: number;
  tipAtFetch: TipFingerprint;
}

/** Re-fetching the chain tip on every cache check is overkill; memo it briefly. */
const TIP_PROBE_TTL_MS = 5_000;

/**
 * Wall-time ceiling of the partial-resume loop in `dust()`: enough to fully
 * cold-sync any preprod wallet from event 0, and an indexer that streams
 * events forever still terminates. The bound is time, not a count of
 * windows, because a window can be short: Blockfrost drops a reader slower
 * than its stream after about 80 s (some 80k events for the WASM reader), so
 * a cold preprod sync is twenty windows or more, each resumed from the last.
 */
const DUST_SYNC_BUDGET_MS = 60 * 60_000;

/** Windows in a row that apply no event before the loop gives up: the sync is stuck, not slow. */
const DUST_STALLED_WINDOWS = 3;

/** Default per-sync-attempt deadline (local). */
const SYNC_ATTEMPT_LOCAL_MS = 30_000;
/** Default per-sync-attempt deadline (remote — preprod/preview Day 0). */
const SYNC_ATTEMPT_REMOTE_MS = 120_000;
/** Sync-retry budget: number of build+sync attempts before giving up on transient sync errors. */
const SYNC_MAX_ATTEMPTS = 3;
/** Cold-start race retry budget: how many times to stop+rebuild+re-sync when the SDK reports InsufficientFunds despite a synced state with coins. */
const COLD_START_MAX_ATTEMPTS = 5;
/** Backoff between cold-start retries — gives the indexer time to settle. */
const COLD_START_DELAY_MS = 5_000;

export class WalletDataRepository {
  private readonly now: () => number;
  private readonly fetchTip: NonNullable<RepoDeps['fetchTip']>;
  private readonly fetchUnshielded: NonNullable<RepoDeps['fetchUnshielded']>;
  private readonly fetchDust: NonNullable<RepoDeps['fetchDust']>;
  private readonly fetchChainId: NonNullable<RepoDeps['fetchChainId']>;
  private readonly fetchEventTip: NonNullable<RepoDeps['fetchEventTip']>;
  private readonly fetchProtocolVersion: NonNullable<RepoDeps['fetchProtocolVersion']>;
  private readonly fetchGenesisProtocolVersion: NonNullable<RepoDeps['fetchGenesisProtocolVersion']>;
  private readonly readShielded: NonNullable<RepoDeps['readShielded']>;

  private readonly dustMemo = new Map<string, MemoEntry<DustView>>();
  private readonly unshieldedMemo = new Map<string, MemoEntry<UnshieldedView>>();
  private readonly tipMemo = new Map<string, { tip: TipFingerprint; fetchedAt: number }>();

  /** A repository for an engine: its host's settings choose how Dust is read, and its notices go to the host. */
  constructor(host: EngineHost, deps: RepoDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.fetchTip = deps.fetchTip ?? defaultTipFetcher;
    this.fetchUnshielded = deps.fetchUnshielded ?? defaultUnshieldedFetcher;
    this.fetchDust = deps.fetchDust ?? nativeOrWasmDustFetcher(host);
    this.fetchChainId = deps.fetchChainId ?? getChainGenesisHash;
    this.fetchEventTip = deps.fetchEventTip ?? fetchEventTip;
    this.fetchProtocolVersion = deps.fetchProtocolVersion ?? fetchProtocolVersion;
    this.fetchGenesisProtocolVersion = deps.fetchGenesisProtocolVersion ?? fetchGenesisProtocolVersion;
    this.readShielded = deps.readShielded ?? readShieldedBalanceCached;
  }

  /**
   * Indexer guard: cached sync state resumes from the indexer's own ids, so
   * state read from another indexer is dropped before it is loaded, and the
   * caller is told why this sync is a full one.
   */
  private keepCachesOfThisIndexer(networkName: string, network: NetworkConfig, root: string, onStatus?: (s: string) => void): void {
    const change = bindCachesToIndexer(networkName, network.indexerWS, root);
    if (change) onStatus?.(describeIndexerChange(networkName, change));
  }

  /**
   * What a wallet with no saved state restores from: a new wallet's state,
   * with the Dust checkpoint the direct reader already holds in place of its
   * empty Dust state. Without it the SDK replays the chain's whole Dust history
   * itself, slowly enough that the first sync attempt of a first `serve` or
   * transfer on a hosted network always timed out. Null when there is no
   * checkpoint to start from: the wallet is then built from its keys.
   */
  /**
   * The saved state a wallet restores from: its own, else a new wallet's on
   * the Dust checkpoint (see freshWalletOnDustCheckpoint). Null builds it from
   * its keys. Every facade mn starts for writing starts from this; both are
   * read under the state root `root`. Building that new wallet's diagnostics
   * go to `log`.
   */
  async walletStateToRestore(seed: Buffer, network: NetworkConfig, networkName: NetworkName, root: string, notice: NoticeSink, log?: VerboseLog): Promise<WalletCacheData | null> {
    return loadWalletCache(deriveUnshieldedAddress(seed, networkName), networkName, root)
      ?? await this.freshWalletOnDustCheckpoint(seed, network, networkName, root, notice, log);
  }

  private async freshWalletOnDustCheckpoint(seed: Buffer, network: NetworkConfig, networkName: NetworkName, root: string, notice: NoticeSink, log?: VerboseLog): Promise<WalletCacheData | null> {
    const checkpoint = loadDustCache(networkName, dustPublicKeyHexFromSeed(seed), root);
    if (!checkpoint || checkpoint.lastAppliedEventId < 0) return null;
    // The new wallet's Dust starts on the checkpoint's ledger, so the checkpoint
    // fits it: on a chain that forked from ledger 8 a wallet built from keys
    // starts on ledger 8, where a ledger-9 checkpoint can't go.
    const fresh = await buildFacade(seed, network, root, notice, null, log, checkpoint.state.ledgerVersion);
    try {
      const { shielded, unshielded, dust } = fresh.facade as unknown as Record<'shielded' | 'unshielded' | 'dust', { serializeState(): Promise<string> }>;
      const [shieldedState, unshieldedState, dustState] = await Promise.all([shielded.serializeState(), unshielded.serializeState(), dust.serializeState()]);
      return { shielded: shieldedState, unshielded: unshieldedState, dust: overlayDustDirectSnapshot(dustState, checkpoint) };
    } catch (err) {
      // The wallet is built from its keys instead, and replays the chain's
      // whole Dust history itself: said, never silent, on a hosted network.
      if (err instanceof DustSnapshotLedgerMismatchError) {
        if (isHostedNetwork(network)) notice(wasmDustNotice(networkName, `the Dust checkpoint doesn't fit a new wallet (${err.message})`));
        return null;
      }
      throw err;
    } finally {
      await stopFacade(fresh).catch(() => {});
    }
  }

  /**
   * Reads the wallet's shielded history into the direct reader's checkpoint
   * under `root`, when the facade would otherwise start its shielded wallet
   * below the ledger-9 fork: on a chain that forked from ledger 8 (its first
   * block is), unless the wallet's saved shielded state is past the fork
   * already. buildFacade then starts the shielded wallet on that checkpoint
   * (see shielded-snapshot.ts). Resumes from the checkpoint it left; the first
   * read of preprod took 216 s, once.
   */
  async primeShielded(seed: Buffer, network: NetworkConfig, opts: { root: string; signal?: AbortSignal; onStatus?: (status: string) => void; log?: VerboseLog }): Promise<void> {
    const networkName = networkNameOf(network);
    const saved = loadWalletCache(deriveUnshieldedAddress(seed, networkName), networkName, opts.root);
    if (saved && shieldedSnapshotLedger(saved.shielded) === 9) return;
    const start = await this.fetchGenesisProtocolVersion(network.indexer, opts.signal);
    if (start !== null && ledgerOfProtocolVersion(start) === 9) return;
    const chainProtocolVersion = await this.fetchProtocolVersion(network.indexer, opts.signal);
    const chainId = (await this.fetchChainId(network.node).catch(() => null)) ?? undefined;
    opts.log?.('shielded', `The chain's first block is at protocol version ${start ?? 'unknown'}: reading the shielded history past the fork first`);
    opts.onStatus?.('Reading shielded events…');
    const read = await this.readShielded(seed, networkName, network.indexerWS, {
      root: opts.root,
      signal: opts.signal,
      chainId,
      chainProtocolVersion,
      onProgress: (applied, max) => opts.onStatus?.(`Reading shielded events… ${applied} (to event ${max})`),
    });
    opts.log?.('shielded', `Shielded checkpoint at event ${read.lastAppliedEventId}${read.partial ? ' (partial)' : ''}`);
  }

  // ── Reads ─────────────────────────────────────────

  async dust(seed: Buffer, network: NetworkConfig, opts: CachedReadOptions): Promise<DustView> {
    const networkName = networkNameOf(network);
    // The tip's version is read before any Dust event: a caught-up read on a
    // chain past the fork then ends on ledger 9 (see dust-event-fold.ts).
    const chainProtocolVersion = await this.fetchProtocolVersion(network.indexer, opts.signal);
    checkLedgerSupported(networkName, chainProtocolVersion);
    const pubkeyHex = dustPublicKeyHexFromSeed(seed);
    const memoKey = `${networkName}:${pubkeyHex}`;

    if (!opts.forceFresh) {
      const hit = await this.tryMemo(memoKey, network, this.dustMemo, opts.signal);
      // `partial` rides through from the memoized view — a short state stays short.
      if (hit) return { ...hit, fromCache: true, eventsApplied: 0 };
    }

    // Chain-reset guard: fetch the chain's genesis hash once, wipe any
    // stale-chain dust files, and persist the same hash on every save so the
    // guard has something to compare on the next run.
    const currentChainId = await this.fetchChainId(network.node).catch(() => null);
    validateDustCacheChainId(networkName, currentChainId, opts.root);
    this.keepCachesOfThisIndexer(networkName, network, opts.root, opts.onStatus);
    const chainId = currentChainId ?? undefined;

    let cached = opts.forceFresh ? null : loadDustCache(networkName, pubkeyHex, opts.root);
    // A cursor past the chain's latest event: the chain was reset under the
    // cache (the genesis check above can't tell when the hash is reused).
    if (cached && isCursorBeyondTip(cached.lastAppliedEventId, await this.fetchEventTip(network.indexerWS, 'dust'))) {
      clearDustDirectCache(networkName, pubkeyHex, opts.root);
      cached = null;
    }
    const startedFromCache = cached !== null;
    let totalEventsApplied = 0;
    let lastAppliedEventId = cached?.lastAppliedEventId ?? -1;
    let result: DustDirectResult | null = null;

    // Auto-resume on `partial: true`. The underlying fetcher resolves with
    // `partial` when its window ends before the tip (its soft timeout, or the
    // indexer dropping the connection) instead of throwing. Each call's
    // `onCheckpoint` saves intermediate state to disk, so the next window
    // resumes from where the last one stopped and never re-processes events.
    // Bounded by time and by progress, so a broken indexer doesn't loop forever.
    const startedAt = this.now();
    let stalledWindows = 0;
    for (let attempt = 0; ; attempt++) {
      throwIfCancelled(opts.signal);
      const startFromId = cached ? cached.lastAppliedEventId + 1 : 0;
      opts.onStatus?.(
        attempt > 0
          ? `Resuming dust from event ${startFromId} (continuation ${attempt + 1})…`
          : (cached ? `Resuming dust from event ${startFromId}…` : 'Reading dust events…'),
      );

      result = await this.fetchDust(seed, network, {
        root: opts.root,
        startFromId,
        initialState: cached?.state,
        initialRetention: cached?.retention,
        chainProtocolVersion,
        signal: opts.signal,
        log: opts.log,
        onProgress: (applied, max) => {
          const target = Math.max(1, max + 1 - startFromId);
          opts.onStatus?.(`Reading dust events… ${applied}/${target}`);
          // Also forward the raw counts, as ReadOptions.onProgress documents.
          // Callers that render their own progress (e.g. `dust export`'s spinner)
          // have no other signal — without this they show a frozen spinner for
          // the whole cold sync.
          opts.onProgress?.(applied, max);
        },
        // Persist after each chunk so a Ctrl+C / process kill / SIGTERM
        // doesn't lose 100k events of work.
        onCheckpoint: (state, lastAppliedEventId, retention) => {
          try { saveDustCache(networkName, pubkeyHex, state, lastAppliedEventId, opts.root, chainId, retention); } catch { /* best-effort */ }
        },
      });

      // Final save (covers the last sub-chunk that didn't trip onCheckpoint).
      // A run that applied no events keeps the prior checkpoint's id rather than
      // regressing to -1 — the state is still valid as far as that id.
      lastAppliedEventId = result.lastAppliedEventId >= 0
        ? result.lastAppliedEventId
        : (cached?.lastAppliedEventId ?? -1);
      // A window that applied nothing over no cache is kept only when it is
      // complete (an empty Dust timeline). A cut-short one holds no position:
      // on a forked chain its state is the tip's ledger 9 while the timeline
      // starts with ledger-8 events, which the next window would refuse.
      if (result.lastAppliedEventId >= 0 || (!cached && !result.partial)) {
        try { saveDustCache(networkName, pubkeyHex, result.state, lastAppliedEventId, opts.root, chainId, result.retention); } catch { /* best-effort */ }
      }

      totalEventsApplied += result.eventCount;
      if (!result.partial) break;
      stalledWindows = result.eventCount > 0 ? 0 : stalledWindows + 1;
      if (stalledWindows >= DUST_STALLED_WINDOWS || this.now() - startedAt >= DUST_SYNC_BUDGET_MS) break;

      // Reload for the next iteration so cached.state is the latest checkpoint.
      cached = loadDustCache(networkName, pubkeyHex, opts.root);
    }

    if (!result) throw new Error('Dust sync exhausted retries without producing a result');
    const view: DustView = {
      state: result.state,
      balance: result.balance,
      availableCoins: result.availableCoins,
      ownedUtxoCount: result.ownedUtxoCount,
      syncTime: result.syncTime,
      fromCache: startedFromCache,
      eventsApplied: totalEventsApplied,
      lastAppliedEventId,
      partial: result.partial,
      fetchedAt: this.now(),
    };
    await this.memoize(this.dustMemo, memoKey, view, network, opts.signal, opts.log);
    return view;
  }

  async unshielded(
    identity: string | Buffer,
    network: NetworkConfig,
    opts: ReadOptions = {},
  ): Promise<UnshieldedView> {
    const networkName = networkNameOf(network);
    const address = typeof identity === 'string'
      ? identity
      : deriveUnshieldedAddress(identity, networkName);
    const memoKey = `${networkName}:${address}`;

    if (!opts.forceFresh) {
      const hit = await this.tryMemo(memoKey, network, this.unshieldedMemo, opts.signal);
      if (hit) return { ...hit, fromCache: true };
    }

    const summary = await this.fetchUnshielded(address, network, opts.onProgress, opts.signal);
    const view: UnshieldedView = { ...summary, fromCache: false, fetchedAt: this.now() };
    await this.memoize(this.unshieldedMemo, memoKey, view, network, opts.signal, opts.log);
    return view;
  }

  // ── Borrow pattern (writes) ───────────────────────

  /**
   * Borrow a synced WalletFacade for a write or facade-bound read. Owns the
   * full lifecycle plus the recovery loops every write path used to
   * re-implement:
   *
   *   1. Optional dust pre-prime (skipped when `noPrime: true` or when in
   *      read-only mode). Warms the dust-direct cache so the facade's dust
   *      wallet restores from a near-tip checkpoint instead of cold-syncing
   *      via the SDK's `isConnected` path.
   *   2. Sync-retry on `StaleCacheError` (chain reset / re-index): wipe both
   *      caches, re-prime, rebuild from a clean cache, re-sync.
   *   3. Sync-retry on timeout: persist whatever progress the facade made,
   *      reload from disk so the next attempt resumes from the checkpoint.
   *   4. Cold-start race retry around `fn`: when the SDK throws
   *      `Wallet.InsufficientFunds` despite the synced state showing coins
   *      (the SDK's internal coin index hadn't caught up to the state
   *      snapshot), stop+rebuild+re-sync and call fn again. Bounded.
   *   5. Save wallet cache on success.
   *   6. Auto-invalidate the dust+unshielded memo entries for this seed
   *      (writes mutate state), keeping the wallet cache just saved.
   *      Read-only borrowers pass `readOnly: true`.
   *   7. stopFacade in `finally`.
   *
   * The SDK's `FacadeBundle` is intentionally exposed via `lease.bundle` so
   * callers can build/sign/submit transactions. Tests of write paths through
   * this method are integration tests against a real network.
   */
  async withFacade<T>(
    seed: Buffer,
    network: NetworkConfig,
    fn: (lease: FacadeLease) => Promise<T>,
    opts: FacadeOptions,
  ): Promise<T> {
    const syncMode = opts.syncMode ?? 'full';
    const requireStrictSync = opts.requireStrictSync ?? true;
    const writeMode = requireStrictSync && !opts.readOnly;
    const networkName = networkNameOf(network);
    const address = deriveUnshieldedAddress(seed, networkName);
    const syncTimeoutMs = opts.syncTimeoutMs
      ?? (isHostedNetwork(network) ? SYNC_ATTEMPT_REMOTE_MS : SYNC_ATTEMPT_LOCAL_MS);

    // On a ledger-8 chain the SDK's sync retries forever; refuse up front.
    const chainProtocolVersion = await this.fetchProtocolVersion(network.indexer, opts.signal);
    checkLedgerSupported(networkName, chainProtocolVersion);

    const currentChainId = await this.fetchChainId(network.node).catch(() => null);
    validateWalletCacheChainId(networkName, currentChainId, opts.root);
    this.keepCachesOfThisIndexer(networkName, network, opts.root, opts.onStatus);
    const chainId = currentChainId ?? undefined;

    // ── Pre-prime the dust-direct cache for write-mode borrowers ──
    // Equivalent to the legacy `primeDustCacheWithFeedback` step: warms the
    // dust state to chain tip on disk so buildFacade's dust bridge starts
    // near-tip. Read-only borrowers skip it.
    if (writeMode && !opts.noPrime && !opts.forceFresh) {
      try {
        await this.dust(seed, network, { root: opts.root, notice: opts.notice, signal: opts.signal, onStatus: opts.onStatus, log: opts.log });
      } catch (err) {
        // Pre-prime is best-effort — the actual sync below will re-attempt
        // anyway. Surface the error only via onSyncWarning if anyone cares.
        opts.onSyncWarning?.('PrePrime', (err as Error).message);
      }
      // The shielded wallet too, on a chain that forked from ledger 8: built
      // from its keys it would start below the fork, and no transaction could
      // be built until it had replayed the chain's shielded history.
      try {
        await this.primeShielded(seed, network, { root: opts.root, signal: opts.signal, onStatus: opts.onStatus, log: opts.log });
      } catch (err) {
        throwIfCancelled(opts.signal);
        opts.onSyncWarning?.('PrePrime', (err as Error).message);
      }
    }

    let bundle: FacadeBundle | undefined;
    let syncedState: FacadeState | undefined;
    let cleanupDone = false;
    const cleanup = async () => {
      if (cleanupDone || !bundle) return;
      cleanupDone = true;
      try { await stopFacade(bundle); } catch { /* best-effort */ }
    };

    try {
      // ── Sync-retry loop (build + start) ────────────────────
      for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt++) {
        throwIfCancelled(opts.signal);
        const cacheBeforeBuild = opts.forceFresh
          ? null
          : await this.walletStateToRestore(seed, network, networkName, opts.root, opts.notice, opts.log);
        bundle = await buildFacade(seed, network, opts.root, opts.notice, cacheBeforeBuild, opts.log);
        try {
          syncedState = await startAndSyncFacade(bundle, {
            onProgress: opts.onSyncProgress,
            onSyncDetail: opts.onSyncDetail,
            timeoutMs: syncTimeoutMs,
            syncMode,
            requireStrictSync,
            log: opts.log,
            signal: opts.signal,
          });
          break;
        } catch (err: any) {
          throwIfCancelled(opts.signal);

          if (err instanceof StaleCacheError && attempt < SYNC_MAX_ATTEMPTS && writeMode) {
            opts.onStatus?.(`Cache is stale, clearing and rebuilding (attempt ${attempt + 1}/${SYNC_MAX_ATTEMPTS})...`);
            await stopFacade(bundle).catch(() => {});
            bundle = undefined;
            clearWalletCache(address, networkName, opts.root);
            clearDustDirectCache(networkName, dustPublicKeyHexFromSeed(seed), opts.root);
            // Re-prime the dust cache so the next attempt restores from a
            // current checkpoint instead of a full SDK resync.
            try {
              await this.dust(seed, network, { root: opts.root, notice: opts.notice, signal: opts.signal, onStatus: opts.onStatus, log: opts.log });
            } catch { /* best-effort */ }
            continue;
          }

          if (attempt < SYNC_MAX_ATTEMPTS && String(err?.message ?? '').includes('timed out')) {
            // Save partial sync progress to cache before retrying so the next
            // attempt resumes from the latest event id.
            try { await saveWalletCache(address, networkName, bundle.facade, opts.root, chainId); } catch { /* best-effort */ }
            opts.onStatus?.(`Sync timed out, retrying (attempt ${attempt + 1}/${SYNC_MAX_ATTEMPTS})...`);
            await stopFacade(bundle).catch(() => {});
            bundle = undefined;
            continue;
          }

          throw err;
        }
      }

      if (!bundle || !syncedState) throw new Error('Sync failed: no facade state after retries');

      // A wallet below the fork on a chain past it builds nothing the facade
      // will take (it acts at the lowest of its wallets' versions): said now,
      // not after a Dust wait and a proof.
      if (writeMode && chainProtocolVersion !== null && chainProtocolVersion >= LEDGER_9_FORK_VERSION) {
        const versions = syncedState.protocolVersion;
        const behind = walletsBelowLedger9(versions);
        if (behind.length > 0) throw new WalletBehindForkError(walletsBehindForkMessage(behind.map((wallet) => ({ wallet, protocolVersion: versions[wallet] })), LEDGER_9_FORK_VERSION));
      }

      // ── Cold-start race retry around fn ───────────────────
      // The SDK's state observable can emit a snapshot with coins populated
      // BEFORE the internal #balanceSegment coin index is built. fn's call
      // to transferTransaction then throws Wallet.InsufficientFunds. Recovery
      // is a full facade restart, not in-place quick-sync. Bounded.
      let result: T;
      let attempt = 0;
      while (true) {
        attempt++;
        throwIfCancelled(opts.signal);
        try {
          result = await fn({ bundle, state: syncedState });
          break;
        } catch (err) {
          // A Dust shortage is real, not the cold-start race: rebuilding the
          // facade can't fix it (and repeated rebuilds crashed the ledger WASM).
          const canRetry = writeMode && attempt < COLD_START_MAX_ATTEMPTS && isColdStartRace(err);
          if (!canRetry) throw err;
          opts.onStatus?.(`Refreshing wallet state (attempt ${attempt + 1}/${COLD_START_MAX_ATTEMPTS})...`);
          await stopFacade(bundle).catch(() => {});
          bundle = undefined;
          await new Promise((r) => setTimeout(r, COLD_START_DELAY_MS));
          throwIfCancelled(opts.signal);
          const retryCache = loadWalletCache(address, networkName, opts.root);
          bundle = await buildFacade(seed, network, opts.root, opts.notice, retryCache, opts.log);
          syncedState = await startAndSyncFacade(bundle, {
            onProgress: opts.onSyncProgress,
            onSyncDetail: opts.onSyncDetail,
            timeoutMs: syncTimeoutMs,
            syncMode,
            requireStrictSync,
            log: opts.log,
            signal: opts.signal,
          });
        }
      }

      if (!opts.skipAutoSave) {
        try { await saveWalletCache(address, networkName, bundle.facade, opts.root, chainId); } catch { /* best-effort */ }
      }
      // A write changed what the chain holds for this wallet, so the balances
      // read before it are dropped. The saved wallet state stays: it was synced
      // just now, and the next write resumes from it (its sync then picks up
      // this write's transaction) instead of rebuilding the wallet.
      if (!opts.readOnly) this.invalidate({ network, root: opts.root, seed, kinds: ['dust', 'unshielded'] });
      return result;
    } finally {
      await cleanup();
    }
  }

  // ── Invalidation ──────────────────────────────────

  invalidate(scope: InvalidationScope): void {
    const networkName = networkNameOf(scope.network);
    const kinds = scope.kinds ?? ['dust', 'unshielded', 'facade'];

    if (kinds.includes('dust')) {
      if (scope.seed) {
        const pubkeyHex = dustPublicKeyHexFromSeed(scope.seed);
        this.dustMemo.delete(`${networkName}:${pubkeyHex}`);
      } else {
        this.deleteByPrefix(this.dustMemo, `${networkName}:`);
      }
    }

    if (kinds.includes('unshielded')) {
      const addr = scope.address
        ?? (scope.seed ? deriveUnshieldedAddress(scope.seed, networkName) : null);
      if (addr) this.unshieldedMemo.delete(`${networkName}:${addr}`);
      else this.deleteByPrefix(this.unshieldedMemo, `${networkName}:`);
    }

    if (kinds.includes('facade') && scope.seed) {
      const address = deriveUnshieldedAddress(scope.seed, networkName);
      try { clearWalletCache(address, networkName, scope.root); } catch { /* best-effort */ }
    }
  }

  /** Drop the chain-tip memo so the next read re-checks. Test/diagnostic helper. */
  resetTipMemo(): void {
    this.tipMemo.clear();
  }

  // ── Internals ─────────────────────────────────────

  private async tryMemo<T>(
    key: string,
    network: NetworkConfig,
    memo: Map<string, MemoEntry<T>>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const entry = memo.get(key);
    if (!entry) return null;
    let tip: TipFingerprint;
    try {
      tip = await this.getTip(network, signal);
    } catch {
      // A cancelled call stops here rather than being served the cache.
      throwIfCancelled(signal);
      // Network down on the tip-check → serve cache. Caller can pass forceFresh
      // if they need certainty over availability.
      return entry.value;
    }
    if (tip === entry.tipAtFetch) return entry.value;
    memo.delete(key);
    return null;
  }

  /**
   * Record a freshly-fetched view in a memo, stamped with the current chain tip.
   *
   * The tip fetch is best-effort: `tryMemo` already treats an unreachable node as
   * "serve the cache" rather than an error, and the same has to hold here. A cold
   * dust sync can be 5-22 minutes of work, and letting a 3s RPC timeout throw it
   * away — after it completed and was written to disk — would be absurd. Skipping
   * the memo just means the next read re-checks.
   */
  private async memoize<T>(
    memo: Map<string, MemoEntry<T>>,
    key: string,
    value: T,
    network: NetworkConfig,
    signal?: AbortSignal,
    log?: VerboseLog,
  ): Promise<void> {
    try {
      const tip = await this.getTip(network, signal);
      memo.set(key, { value, fetchedAt: this.now(), tipAtFetch: tip });
    } catch {
      // Also swallows an abort landing on this final tip probe — fine: the sync
      // already completed and was persisted, so there is no work left to cancel.
      log?.('repo', `tip unavailable; skipping memo for ${key}`);
    }
  }

  private async getTip(network: NetworkConfig, signal?: AbortSignal): Promise<TipFingerprint> {
    const cached = this.tipMemo.get(network.networkId);
    if (cached && this.now() - cached.fetchedAt < TIP_PROBE_TTL_MS) return cached.tip;
    const tip = await this.fetchTip(network, signal);
    this.tipMemo.set(network.networkId, { tip, fetchedAt: this.now() });
    return tip;
  }

  private deleteByPrefix(memo: Map<string, unknown>, prefix: string): void {
    for (const k of memo.keys()) {
      if (k.startsWith(prefix)) memo.delete(k);
    }
  }
}

// ── Default seam implementations ──────────────────────────

function defaultTipFetcher(network: NetworkConfig, signal?: AbortSignal): Promise<TipFingerprint> {
  return callNodeRpc<string>({ url: network.node, timeoutMs: 3_000, signal }, 'chain_getBlockHash', []);
}

function defaultUnshieldedFetcher(
  address: string,
  network: NetworkConfig,
  onProgress?: (current: number, highest: number) => void,
  signal?: AbortSignal,
): Promise<BalanceSummary> {
  return checkBalance(address, network.indexerWS, onProgress, signal);
}

function defaultDustFetcher(
  seed: Buffer,
  network: NetworkConfig,
  opts: {
    startFromId: number;
    initialState?: DustLedgerState;
    initialRetention?: DustRetention;
    chainProtocolVersion: bigint | null;
    signal?: AbortSignal;
    onProgress?: (applied: number, max: number) => void;
    onCheckpoint?: (state: DustLedgerState, lastAppliedEventId: number, retention: DustRetention) => void;
    root: string;
    log?: VerboseLog;
  },
  collapse: boolean,
): Promise<DustDirectResult> {
  return readDustBalanceDirect(dustKeysFromSeed(deriveDustSeed(seed)), network.indexerWS, { ...opts, collapse, networkId: network.networkId });
}

/**
 * Prefer the native sidecar (faster on a cold dust sync) when
 * it's available and serves this sync (a chain past the fork, no ledger-8
 * checkpoint to resume); fall back to the WASM reader on a missing binary or
 * any failure. The sidecar is an optional accelerator, so a fallback is a
 * slowdown, never a break. On a hosted network the fallback is said through
 * the host's notices, with why; on the localnet only in the verbose lines.
 * Each sync reads the host's settings: the sidecar to run, whether to run it,
 * and whether to collapse the generation tree.
 */
function nativeOrWasmDustFetcher(host: EngineHost): NonNullable<RepoDeps['fetchDust']> {
  return async (seed, network, opts) => {
    const settings = host.settings();
    let why = sidecarSkipReason(opts) ?? sidecarUnavailableReason(settings);
    if (why === null) {
      try {
        return await runDustSyncNative(seed, network, { ...opts, settings });
      } catch (err) {
        why = `the dust-sync sidecar failed: ${(err as Error).message}`;
      }
    }
    if (isHostedNetwork(network)) host.notice(wasmDustNotice(networkNameOf(network), why));
    else opts.log?.('dust', `reading Dust with the WASM reader: ${why}`);
    return defaultDustFetcher(seed, network, opts, !settings.isDustCollapseOff);
  };
}


// ── Helpers ───────────────────────────────────────────────

function networkNameOf(network: NetworkConfig): NetworkName {
  const lower = network.networkId.toLowerCase();
  if (isValidNetworkName(lower)) return lower;
  throw new Error(`Unsupported network: ${network.networkId}`);
}
