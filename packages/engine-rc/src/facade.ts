import { getNetworkId, type WalletCacheData, type FeePricing, newFeePricing, SYNC_TIMEOUT_MS, PRE_SEND_SYNC_TIMEOUT_MS } from '@kuiralabs/midnight-cli-core/engine';
import { type NoticeSink, type NetworkConfig, type VerboseLog, CancelledError, SyncTimeoutError, throwIfCancelled } from '@kuiralabs/midnight-cli-core';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
} from '@midnightntwrk/wallet-sdk/unshielded';
import { DustWallet } from './dust-wallet.ts';
import {
  WalletFacade,
  WalletEntrySchema,
  mergeWalletEntries,
  type FacadeState,
} from '@midnightntwrk/wallet-sdk/facade';
import { type WalletSeeds } from '@midnightntwrk/wallet-sdk/hd';
import * as ledger from '@midnightntwrk/ledger-v9';
import { InMemoryTransactionHistoryStorage, ProtocolVersion } from '@midnightntwrk/wallet-sdk';
import * as rx from 'rxjs';
import { makeDefaultSubmissionService } from '@midnightntwrk/wallet-sdk/capabilities/submission';

import { FORK_SCHEDULE } from './fork-schedule.ts';
import { deriveShieldedSeed, deriveUnshieldedSeed, deriveDustSeed } from './derivation.ts';
import { loadDustCache, dustPublicKeyHex, type DustCacheEntry } from './dust-direct-cache.ts';
import { ledgerOfProtocolVersion, serializeDustLedgerState, type DustLedger } from './dust-ledger-state.ts';
import { isHostedNetwork, wasmDustNotice } from './dust-sync-native.ts';
import { assertNetworkAnswers, fetchProtocolVersion, isStreamEmpty } from '@kuiralabs/midnight-chain';
import { readOpenOffers, type NetworkName } from '@kuiralabs/midnight-cli-core';
import type { CoinPicking } from '@kuiralabs/midnight-cli-core/engine';
import { PickingShieldedWallet, shieldedCoinPicking, type ShieldedCoin } from './shielded-wallet.ts';
import { deriveUnshieldedAddress } from './derive-address.ts';

export type SyncMode = 'full' | 'lite' | 'no-dust';
// full    = shielded + unshielded + dust
// lite    = unshielded + dust (skip shielded — used by dust register/status)
// no-dust = shielded + unshielded (skip dust — used by balance; dust isn't needed
//           to read NIGHT balances and avoids the dust `isConnected` SDK hang)

export interface FacadeBundle {
  facade: WalletFacade;
  keystore: UnshieldedKeystore;
  /** Per-role seeds: the material the wallets are started with. */
  seeds: WalletSeeds;
  /** How the shielded wallet picks the coins a spend uses: never an open offer's, except in its cancel. */
  coinPicking: CoinPicking<ShieldedCoin>;
  /** Active subscription that keeps shareReplay buffers alive. Cleaned up by stopFacade. */
  keepAlive?: rx.Subscription;
  /** Whether the facade was restored from cached state (vs built from scratch). */
  restoredFromCache?: boolean;
  /** The network's indexer (HTTP), for reads the facade doesn't offer, like the chain's clock. */
  indexerHttpUrl?: string;
  /** The node the facade submits to: a submit's wait asks whether it still answers. */
  nodeUrl?: string;
  /** The network's indexer (WebSocket), asked which event streams are empty when a sync starts. */
  indexerWsUrl?: string;
  /** The streams the chain has no events in, as read when the sync started. */
  emptyStreams?: EmptyStreams;
  /** The fee settings this wallet's Dust wallet prices with: the SDK reads the margin from it at every price, so a refused fee is priced again by raising it. */
  feePricing: FeePricing;
}

/**
 * The configuration WalletFacade.init() takes, which all wallet types and
 * services draw from. `feePricing` goes in by reference: the Dust wallet's
 * transacting keeps the object and reads it at every price.
 */
export function facadeConfiguration(networkId: NetworkName, networkConfig: Pick<NetworkConfig, 'indexer' | 'indexerWS' | 'proofServer' | 'node'>, feePricing: FeePricing) {
  return {
    networkId,
    forks: FORK_SCHEDULE,
    indexerClientConnection: {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    },
    costParameters: feePricing,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    provingServerUrl: new URL(networkConfig.proofServer),
    relayURL: new URL(networkConfig.node),
  };
}

/**
 * Build a complete WalletFacade from a seed and network config.
 * Returns the facade plus all keys needed for signing and proving.
 *
 * When `cache` is provided, wallets are restored from serialized state
 * instead of starting fresh — the SDK then only syncs new transactions
 * since the last checkpoint, with the Dust checkpoint kept under the state
 * root `root` bridged in when it is ahead.
 *
 * Its diagnostics go to `log`, the call's verbose lines; a cache it can't
 * restore from is said through `notice` before it builds from scratch.
 *
 * `dustLedger` puts a fresh build's Dust wallet on that ledger, for a caller
 * that hands it a Dust state of that ledger (a checkpoint of the direct reader
 * or the sidecar, see overlayDustDirectSnapshot). Without it the SDK starts the
 * wallet where the chain's history starts, which on a chain that forked from
 * ledger 8 is ledger 8.
 */
export async function buildFacade(
  seedBuffer: Buffer,
  networkConfig: NetworkConfig,
  root: string,
  notice: NoticeSink,
  cache?: WalletCacheData | null,
  log?: VerboseLog,
  dustLedger?: DustLedger,
): Promise<FacadeBundle> {
  const networkId = getNetworkId(networkConfig.networkId);

  await assertNetworkAnswers(networkConfig);

  log?.('facade', `Building facade for network ${networkConfig.networkId}`);
  log?.('facade', `Node: ${networkConfig.node}`);
  log?.('facade', `Indexer: ${networkConfig.indexerWS}`);
  log?.('facade', `Proof server: ${networkConfig.proofServer}`);

  const seeds: WalletSeeds = {
    shielded: deriveShieldedSeed(seedBuffer),
    unshielded: deriveUnshieldedSeed(seedBuffer),
    dust: deriveDustSeed(seedBuffer),
  };
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId);
  // The wallet's open swap offers, as mn's record under the root keeps them (the network id is the network's name).
  const network = networkId as NetworkName;
  const walletAddress = deriveUnshieldedAddress(seedBuffer, network);
  const coinPicking = shieldedCoinPicking(seeds.shielded, () => readOpenOffers(root, network, walletAddress));

  const feePricing = newFeePricing();
  const configuration = facadeConfiguration(networkId, networkConfig, feePricing);

  // Fresh build. The class-level startWithSeed probes which side of the fork
  // the chain is on and builds the wallet there. It doesn't start syncing;
  // startFacade does that. A Dust wallet asked onto a ledger answers that probe
  // itself, with a version read before the build: the SDK gives its probe 5 s
  // and on no answer starts on ledger 8.
  const dustStart = dustLedger === undefined ? undefined : await dustStartVersion(dustLedger, networkConfig.indexer);
  const initFresh = () => WalletFacade.init({
    configuration,
    submissionService: (config) => submissionOnDemand(config.relayURL),
    shielded: (cfg) => PickingShieldedWallet(cfg, coinPicking).startWithSeed(seeds.shielded),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (cfg) => DustWallet(dustStart === undefined ? cfg : { ...cfg, chainVersionProbe: () => Promise.resolve(dustStart) }).startWithSeed(seeds.dust),
  });

  // Bridge: if the dust-direct cache has a more recent DustLocalState than the
  // facade cache, overlay it into the facade cache's dust snapshot before
  // restore. This lets commands that use the facade (transfer, airdrop, dust
  // register) benefit from the indexer-direct reader's checkpoint without
  // re-implementing the whole transaction flow.
  const dustPublicKey = ledger.DustSecretKey.fromSeed(seeds.dust).publicKey;
  const effectiveCache = cache ? maybeBridgeDustCache(cache, networkConfig, dustPublicKey, root, notice, log) : null;

  // Attempt cache restore — fall back to fresh build on any deserialization error.
  let restoredFromCache = false;
  let facade: WalletFacade;

  if (effectiveCache) {
    log?.('facade', 'Restoring from cache...');
    try {
      facade = await WalletFacade.init({
        configuration,
        submissionService: (config) => submissionOnDemand(config.relayURL),
        shielded: (cfg) => PickingShieldedWallet(cfg, coinPicking).restore(effectiveCache.shielded),
        unshielded: (cfg) => UnshieldedWallet(cfg).restore(effectiveCache.unshielded),
        dust: (cfg) => DustWallet(cfg).restore(effectiveCache.dust),
      });
      restoredFromCache = true;
      log?.('facade', 'Cache restore successful');
    } catch (err) {
      log?.('facade', `Cache restore failed: ${(err as Error).message}`);
      notice(`  Cache restore failed, building from scratch: ${(err as Error).message}`);
      facade = await initFresh();
    }
  } else {
    log?.('facade', 'No cache, building fresh');
    facade = await initFresh();
  }

  return { facade, keystore, seeds, coinPicking, feePricing, restoredFromCache, indexerHttpUrl: networkConfig.indexer, indexerWsUrl: networkConfig.indexerWS, nodeUrl: networkConfig.node };
}

/**
 * The protocol version a new Dust wallet starts at to be on `ledger`. Ledger 9:
 * the chain tip's version when the indexer says it is on ledger 9 (what the
 * SDK records for a wallet it starts on the chain's current ledger), else the
 * fork version, the first of ledger 9's. Ledger 8: the lowest version, which
 * the SDK's ledger-8 variant owns.
 */
export async function dustStartVersion(ledger: DustLedger, indexerHttpUrl: string): Promise<ProtocolVersion.ProtocolVersion> {
  if (ledger === 8) return ProtocolVersion.MinSupportedVersion;
  const tip = await fetchProtocolVersion(indexerHttpUrl).catch(() => null);
  return ProtocolVersion.ProtocolVersion(tip !== null && ledgerOfProtocolVersion(tip) === 9 ? tip : FORK_SCHEDULE.v9);
}

/** What the facade submits through, as WalletFacade.init takes it. */
type FacadeSubmission = Awaited<ReturnType<NonNullable<Parameters<typeof WalletFacade.init>[0]['submissionService']>>>;

/**
 * The SDK's submission service, made on the first submit instead of when the
 * facade is built. The SDK's own opens its node client at once, and its close()
 * waits for that client to be ready: against a node that doesn't answer (down,
 * or a wrong URL) close() never returns and polkadot-js reconnects every 2.5 s
 * for good, so a program that closed its wallet never exits. Made on demand, a
 * facade that submitted nothing holds no node connection, and closes at once.
 */
export function submissionOnDemand(relayURL: URL): FacadeSubmission {
  let service: FacadeSubmission | undefined;
  const submitting = (): FacadeSubmission => (service ??= makeDefaultSubmissionService({ relayURL }));
  const submitTransaction = (transaction: Parameters<FacadeSubmission['submitTransaction']>[0], waitForStatus?: 'Submitted' | 'InBlock' | 'Finalized') =>
    submitting().submitTransaction(transaction, waitForStatus);
  return {
    submitTransaction: submitTransaction as FacadeSubmission['submitTransaction'],
    close: async () => { await service?.close(); },
  };
}

/**
 * Start the facade's wallets and background sync, exactly once. From seeds,
 * `facade.start` gives the shielded and dust wallets both ledger versions'
 * keys, so a wallet restored onto either side of the fork can sync, fresh or
 * restored alike.
 */
async function startFacade(bundle: FacadeBundle): Promise<void> {
  await bundle.facade.start(bundle.seeds);
}

/**
 * If our indexer-direct cache has a NEWER DustLocalState than the facade
 * cache, overlay it into the facade cache's dust snapshot. Keeps publicKey,
 * protocolVersion, networkId from the existing snapshot; only state + offset
 * change. Returns the cache unchanged if:
 *   - no dust-direct entry exists
 *   - facade cache's own offset is already >= dust-direct's offset (prior
 *     transfer already advanced it past our indexer-direct snapshot)
 *   - parsing fails
 */
// Shape of the facade's serialized dust-wallet snapshot. See
// dust-wallet/src/v2/Serialization.ts `SnapshotSchema` — JSON on disk with
// BigInts rendered as decimal strings. The `state` field is a hex-encoded
// `DustLocalState.serialize()` of the ledger its `protocolVersion` falls in
// (ledger 8 below the fork, ledger 9 from it) — the same blob the dust-direct
// cache stores, which is why the two are interchangeable via the overlay below.
export interface FacadeDustSnapshot {
  publicKey: { publicKey: string };
  state: string;
  protocolVersion: string;
  networkId: string;
  offset?: string;
}

/**
 * A Dust state that can't go into a facade snapshot: the wallet restores a
 * snapshot onto the variant its protocol version names, and that variant reads
 * only its own ledger's state.
 */
export class DustSnapshotLedgerMismatchError extends Error {
  constructor(readonly stateLedger: DustLedger, readonly snapshotLedger: DustLedger, readonly lastAppliedEventId: number, snapshotProtocolVersion: string) {
    super(
      stateLedger === 8
        ? `The Dust state read to event ${lastAppliedEventId} is still on ledger 8 (its sync stopped before the chain's fork to ledger 9), ` +
          `and the wallet reads ledger 9 (protocol version ${snapshotProtocolVersion}). Run the command again to finish the Dust sync.`
        : `Can't put a ledger-9 Dust state into a snapshot at protocol version ${snapshotProtocolVersion}: ` +
          `the wallet would read it as ledger 8 (fork at ${FORK_SCHEDULE.v9}).`,
    );
    this.name = 'DustSnapshotLedgerMismatchError';
    Object.setPrototypeOf(this, DustSnapshotLedgerMismatchError.prototype);
  }
}

/**
 * Overlay a dust-direct checkpoint onto a facade dust snapshot: swap in the
 * Dust state from the indexer-direct reader and set the offset to its last
 * applied event id. Keeps publicKey/protocolVersion/networkId from the base
 * snapshot untouched. This is an UNCONDITIONAL overlay — whether the dust-direct
 * state is the one you want is the caller's policy (see `maybeBridgeDustCache`'s
 * freshness guard, and `dust export`'s "any events applied?" check). Overlaying
 * must not itself decide to skip: a base facade snapshot always carries
 * `offset:"0"`, which would otherwise collide with a genuine checkpoint at id 0.
 * The one refusal is a state of the other ledger than the snapshot's
 * (DustSnapshotLedgerMismatchError).
 *
 * This is the seam that lets a facade restore from the fast dust-direct sync:
 * `maybeBridgeDustCache` uses it to speed up write commands, and `dust export`
 * uses it to hand a restorable snapshot to other wallets (e.g. a dApp operator).
 */
export function overlayDustDirectSnapshot(
  dustSnapshotJson: string,
  direct: Pick<DustCacheEntry, 'state' | 'lastAppliedEventId'>,
): string {
  const snapshot: FacadeDustSnapshot = JSON.parse(dustSnapshotJson);
  // The wallet restores a snapshot onto the variant its protocolVersion names
  // (e.g. a facade that started on V1 when the probe failed reads ledger 8).
  const snapshotLedger = ledgerOfProtocolVersion(BigInt(snapshot.protocolVersion));
  if (direct.state.ledgerVersion !== snapshotLedger) {
    throw new DustSnapshotLedgerMismatchError(direct.state.ledgerVersion, snapshotLedger, direct.lastAppliedEventId, snapshot.protocolVersion);
  }
  snapshot.state = Buffer.from(serializeDustLedgerState(direct.state)).toString('hex');
  snapshot.offset = direct.lastAppliedEventId.toString();
  return JSON.stringify(snapshot);
}

function maybeBridgeDustCache(
  cache: WalletCacheData,
  networkConfig: NetworkConfig,
  dustPublicKey: ledger.DustPublicKey,
  root: string,
  notice: NoticeSink,
  log?: VerboseLog,
): WalletCacheData {
  try {
    const networkName = networkConfig.networkId.toLowerCase();
    const pubkeyHex = dustPublicKeyHex(dustPublicKey);
    const direct = loadDustCache(networkName, pubkeyHex, root);
    if (!direct) return cache;

    // Only overlay when dust-direct is AHEAD of the facade cache's own offset — a prior
    // write may have advanced the facade past our indexer-direct checkpoint, and we must
    // not roll it back.
    const snapshot: FacadeDustSnapshot = JSON.parse(cache.dust);
    const facadeOffset = snapshot.offset !== undefined ? Number(snapshot.offset) : -1;
    if (facadeOffset >= direct.lastAppliedEventId) {
      log?.('facade', `Facade dust offset=${facadeOffset} >= dust-direct offset=${direct.lastAppliedEventId}; skipping bridge`);
      return cache;
    }
    log?.('facade', `Bridged dust-direct cache (facade offset ${facadeOffset} → dust-direct offset ${direct.lastAppliedEventId})`);
    return { ...cache, dust: overlayDustDirectSnapshot(cache.dust, direct) };
  } catch (err) {
    log?.('facade', `Dust-direct bridge skipped: ${(err as Error).message}`);
    // The wallet then reads the Dust events past its own saved position itself.
    if (err instanceof DustSnapshotLedgerMismatchError && isHostedNetwork(networkConfig)) {
      notice(wasmDustNotice(networkConfig.networkId.toLowerCase(), `the Dust checkpoint doesn't fit the saved wallet (${err.message})`));
    }
    return cache;
  }
}

/**
 * SDK bug workaround: the dust wallet's `isStrictlyComplete()` requires
 * `isConnected === true`, but `isConnected` only becomes true when a non-empty
 * batch of DustLedgerEvents arrives from the indexer. On an idle chain (no new
 * dust transactions), empty batches don't set `isConnected`, so
 * `isStrictlyComplete()` stays false forever and `isSynced` never becomes true.
 *
 * This predicate bypasses the `isConnected` check for dust by verifying the
 * actual sync index values directly: if `appliedIndex >= highestRelevantWalletIndex`,
 * the dust wallet is caught up regardless of `isConnected`.
 *
 * Shielded and unshielded wallets don't have this issue because the indexer
 * sends progress messages (unshielded) or zswap events (shielded) on every block.
 */
/** The index fields of a shielded or dust wallet's sync progress (bigints in the SDK). */
interface IndexProgress {
  isStrictlyComplete(): boolean;
  readonly appliedIndex: bigint;
  readonly highestRelevantWalletIndex: bigint;
}

/**
 * The event streams the chain has nothing in. A wallet reading one never hears
 * from the indexer, so its progress stays at 0/0 for good: there, and only
 * there, "nothing applied" is the wallet's final state. On a chain that has
 * events, 0/0 only means the wallet hasn't heard yet, and the unshielded
 * wallet often finishes first: a shielded balance read then is 0 whatever the
 * wallet holds.
 */
export interface EmptyStreams {
  readonly zswap: boolean;
  readonly dust: boolean;
}

/** Nothing known to be empty: every wallet has to hear from the indexer before it counts as synced. */
export const NO_EMPTY_STREAMS: EmptyStreams = { zswap: false, dust: false };

/**
 * Dust is caught up when it's strictly complete, or when its indices show it
 * is despite the `isConnected` bug above. Nothing applied (0/0) counts only on
 * a chain with no dust events, once unshielded is synced.
 */
function isDustCaughtUp(dust: IndexProgress, unshieldedOk: boolean, streamEmpty: boolean): boolean {
  if (dust.isStrictlyComplete()) return true;
  if (dust.highestRelevantWalletIndex > 0n && dust.appliedIndex >= dust.highestRelevantWalletIndex) return true;
  return streamEmpty && isUntouched(dust) && unshieldedOk;
}

/** No events have reached this wallet yet: nothing applied, nothing relevant. */
function isUntouched(progress: IndexProgress): boolean {
  return progress.highestRelevantWalletIndex === 0n && progress.appliedIndex === 0n;
}

export function isFacadeSynced(
  state: FacadeState,
  syncMode: SyncMode = 'full',
  empty: EmptyStreams = NO_EMPTY_STREAMS,
): boolean {
  const unshieldedOk = state.unshielded.progress.isStrictlyComplete();
  const dustOk = syncMode === 'no-dust' || isDustCaughtUp(state.dust.progress, unshieldedOk, empty.dust);

  if (syncMode === 'lite') {
    return unshieldedOk && dustOk;
  }

  const shielded = state.shielded.progress;
  const shieldedOk = shielded.isStrictlyComplete() || (empty.zswap && unshieldedOk && isUntouched(shielded));

  return shieldedOk && unshieldedOk && dustOk;
}

/** Check if dust wallet sync is pending (for diagnostics). */
function isDustSyncPending(state: FacadeState, empty: EmptyStreams): boolean {
  return !isDustCaughtUp(state.dust.progress, state.unshielded.progress.isStrictlyComplete(), empty.dust);
}

/** Ask the indexer which of the streams this sync mode reads have no events. With no indexer to ask, none. */
async function readEmptyStreams(indexerWsUrl: string | undefined, syncMode: SyncMode): Promise<EmptyStreams> {
  if (!indexerWsUrl) return NO_EMPTY_STREAMS;
  const [zswap, dust] = await Promise.all([
    syncMode === 'lite' ? false : isStreamEmpty(indexerWsUrl, 'zswap'),
    syncMode === 'no-dust' ? false : isStreamEmpty(indexerWsUrl, 'dust'),
  ]);
  return { zswap, dust };
}

/**
 * Start the facade and wait for initial sync.
 * Calls onProgress with sync progress updates.
 *
 * Uses a single persistent subscription to facade.state() that serves three purposes:
 * 1. Reports unshielded progress (and which wallets are still syncing)
 * 2. Detects sync completion to resolve the sync promise
 * 3. Keeps shareReplay({ refCount: true }) buffers alive for the command lifetime
 */
export interface SyncOptions {
  onProgress?: (applied: number, highest: number) => void;
  onSyncDetail?: (detail: string) => void;
  timeoutMs?: number;
  syncMode?: SyncMode;
  /**
   * Require strict sync before resolving (disables the cached-restore grace
   * period). Write operations (transfer, airdrop, dust register, contract
   * calls) MUST pass this because they construct ZK proofs against the
   * commitment tree — if the tree is stale, the proof fails validation on
   * chain (MalformedError::InvalidDustSpendProof, error code 170). Read-only
   * operations (balance, dust status) can leave this off for the speedup.
   */
  requireStrictSync?: boolean;
  /** The call's verbose lines. */
  log?: VerboseLog;
  /** Cancels the wait: the sync fails with CancelledError. The caller stops the facade. */
  signal?: AbortSignal;
}

export async function startAndSyncFacade(
  bundle: FacadeBundle,
  options: SyncOptions = {},
): Promise<FacadeState> {
  const { onProgress, onSyncDetail, timeoutMs, syncMode = 'full', requireStrictSync = false, log, signal } = options;
  const { facade } = bundle;

  throwIfCancelled(signal);

  log?.('sync', 'Starting facade (connecting to node and indexer)...');
  const [, emptyStreams] = await Promise.all([startFacade(bundle), readEmptyStreams(bundle.indexerWsUrl, syncMode)]);
  bundle.emptyStreams = emptyStreams;
  if (emptyStreams.zswap || emptyStreams.dust) {
    log?.('sync', `The chain has no events in: ${[emptyStreams.zswap && 'zswap', emptyStreams.dust && 'dust'].filter(Boolean).join(', ')}`);
  }
  log?.('sync', 'Facade started, subscribing to state...');
  throwIfCancelled(signal);

  const effectiveTimeout = timeoutMs ?? SYNC_TIMEOUT_MS;
  log?.('sync', `Sync timeout: ${effectiveTimeout / 1000}s, mode: ${syncMode}`);

  // Cached-restore grace: if the facade was restored from cache and we're a
  // READ operation, accept dust as "good enough" once non-dust wallets are
  // strictly complete AND `CACHED_RESTORE_DUST_GRACE_MS` has elapsed — without
  // waiting for the dust-wallet SDK's `isConnected` flag (known bug — never
  // flips on idle preprod streams). Writes set `requireStrictSync` to opt out,
  // because ZK proofs built against a stale commitment tree are rejected by
  // the chain as MalformedError::InvalidDustSpendProof (error code 170).
  const graceEligible = !requireStrictSync && bundle.restoredFromCache;
  const startedAt = Date.now();

  return new Promise<FacadeState>((resolveSync, rejectSync) => {
    let resolved = false;
    let emissionCount = 0;
    const onAbort = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      log?.('sync', `Sync cancelled after ${emissionCount} emissions`);
      rejectSync(new CancelledError());
    };
    const resolve = (state: FacadeState): void => { signal?.removeEventListener('abort', onAbort); resolveSync(state); };
    const reject = (err: unknown): void => { signal?.removeEventListener('abort', onAbort); rejectSync(err); };
    let lastPendingKey = '';

    let lastState: FacadeState | null = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        log?.('sync', `Sync timed out after ${effectiveTimeout / 1000}s (${emissionCount} emissions)`);
        if (lastState) {
          try {
            const up = lastState.unshielded.progress;
            log?.('sync', `  unshielded: applied=${up.appliedId} highest=${up.highestTransactionId} complete=${up.isStrictlyComplete()}`);
            const dp = lastState.dust.progress;
            log?.('sync', `  dust: applied=${dp.appliedIndex} highest=${dp.highestRelevantWalletIndex} complete=${dp.isStrictlyComplete()} connected=${dp.isConnected}`);
            if (syncMode === 'full') {
              const sp = lastState.shielded.progress;
              log?.('sync', `  shielded: complete=${sp.isStrictlyComplete()}`);
            }
          } catch { /* best-effort */ }
        }
        reject(new SyncTimeoutError('Wallet sync timed out'));
      }
    }, effectiveTimeout);

    bundle.keepAlive = facade.state().subscribe({
      next: (state) => {
        if (resolved) return;
        emissionCount++;
        lastState = state;

        // Stale-cache detection: if we restored from cache and our cached
        // appliedIndex exceeds the chain's currently-reported highest, the
        // cache is from a different chain (common on localnet restarts).
        // Runs on every emission so the error fires before `isFacadeSynced`
        // might accept a stale state (sync can "complete" against cached
        // data before any chain-tip data arrives on emission 1-2).
        if (bundle.restoredFromCache) {
          const staleReason = detectStaleCache(state);
          if (staleReason) {
            resolved = true;
            clearTimeout(timeout);
            log?.('sync', `Stale cache detected: ${staleReason}`);
            reject(new StaleCacheError(staleReason));
            return;
          }
        }

        if (onProgress) {
          const progress = state.unshielded.progress;
          if (progress) {
            const applied = Number(progress.appliedId);
            const highest = Number(progress.highestTransactionId);
            onProgress(Math.min(applied, highest), highest);
          }
        }

        // Report which wallets are still syncing (only the ones this mode needs).
        const pending: string[] = [];
        try {
          if ((syncMode === 'full' || syncMode === 'no-dust') && !state.shielded.progress.isStrictlyComplete()) pending.push('shielded');
          if (syncMode !== 'no-dust' && isDustSyncPending(state, emptyStreams)) pending.push('dust');
          if (!state.unshielded.progress.isStrictlyComplete()) pending.push('unshielded');
        } catch { /* best-effort */ }

        if (pending.length > 0) {
          onSyncDetail?.(pending.join(', '));
          const pendingKey = pending.join(',');
          if (emissionCount === 1 || pendingKey !== lastPendingKey || emissionCount % 100 === 0) {
            log?.('sync', `Waiting on: ${pending.join(', ')} (emission #${emissionCount})`);
            lastPendingKey = pendingKey;
          }
        }

        // Primary: strict sync per mode (uses the isFacadeSynced workaround for
        // the dust isConnected bug — see that function above).
        if (isFacadeSynced(state, syncMode, emptyStreams)) {
          resolved = true;
          clearTimeout(timeout);
          log?.('sync', `Sync complete after ${emissionCount} emissions`);
          resolve(state);
          return;
        }

        // Grace fallback: treat "everything except dust synced, and grace
        // elapsed" as done. Reuses the existing no-dust predicate so the two
        // completion paths can't drift.
        if (graceEligible) {
          const elapsed = Date.now() - startedAt;
          if (elapsed >= CACHED_RESTORE_DUST_GRACE_MS && isFacadeSynced(state, 'no-dust', emptyStreams)) {
            resolved = true;
            clearTimeout(timeout);
            log?.('sync', `Sync resolved via cached-restore grace (${elapsed}ms, ${emissionCount} emissions)`);
            resolve(state);
          }
        }
      },
      error: (err) => {
        if (!resolved) {
          log?.('sync', `Sync error: ${(err as Error).message}`);
          clearTimeout(timeout);
          reject(err);
        }
      },
    });
    if (!resolved) signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Cached-restore grace period: after this long, if the facade was built from
// a cache, accept dust as "good enough" without waiting for the SDK's
// isConnected flag (which has a known bug and may never flip).
const CACHED_RESTORE_DUST_GRACE_MS = 10_000;

/**
 * Raised when a restored facade's cached state references event ids that
 * don't exist on the current chain — typically because the local chain was
 * reset (e.g. `mn localnet clean`) while the cache on disk kept the old
 * wallet state. Commands should catch this and clear the cache before retrying.
 */
export class StaleCacheError extends Error {
  readonly code = 'STALE_CACHE';
  constructor(detail: string) {
    super(
      `Cached wallet state is stale (from a previous chain). ${detail}\n` +
      `Run: midnight cache clear --wallet <name> --network <name>\n` +
      `Or:  midnight cache clear  (wipe all caches)`,
    );
    this.name = 'StaleCacheError';
  }
}

/**
 * Detect a cache whose `appliedIndex` exceeds the chain's currently-reported
 * `highestRelevantWalletIndex` — a signature of a cache restored against a
 * different chain (new localnet, networkId reuse, etc).
 *
 * Returns a human-readable reason string if stale, otherwise undefined.
 * Only checks unshielded (the indexer sends progress on every block so its
 * `highestTransactionId` is populated reliably — dust's `highest` can be 0
 * genuinely on a quiet stream even when cache is valid, so checking it would
 * produce false positives).
 */
export function detectStaleCache(state: FacadeState): string | undefined {
  const { appliedId: applied, highestTransactionId: highest } = state.unshielded.progress;
  // We require highest > 0 to ensure the indexer has reported at least once;
  // otherwise we can't make a reliable comparison. applied > highest means
  // our local state has applied events the chain doesn't have.
  if (highest > 0n && applied > highest) {
    return `unshielded cache applied=${applied} but chain highest=${highest}.`;
  }
  return undefined;
}

/**
 * Wait for a fully-populated lite-synced state (unshielded + dust data ready).
 *
 * The index fallback in `isFacadeSynced` resolves sync before the dust wallet
 * has processed its events into `balance()` and `availableCoins`. This helper
 * waits for dust's `isStrictlyComplete()` (which requires `isConnected` — set
 * when actual DustLedgerEvents arrive and populate state data).
 *
 * On active chains (preprod): resolves quickly — a few seconds after lite sync.
 * On idle chains (no dust events): times out after 15s, returns best-effort state.
 *
 * Use this for data-reading calls (dust status, balances) where accurate state
 * matters. Use `isFacadeSynced` with lite mode for sync gating where the index
 * fallback is acceptable.
 */
export async function waitForLiteSyncedState(bundle: FacadeBundle): Promise<FacadeState> {
  const isDataReady = (s: FacadeState): boolean => {
    const unshieldedOk = s.unshielded.progress.isStrictlyComplete();
    const dustOk = s.dust.progress.isStrictlyComplete();
    return unshieldedOk && dustOk;
  };

  try {
    return await rx.firstValueFrom(
      bundle.facade.state().pipe(
        rx.filter(isDataReady),
        rx.timeout(15_000),
      )
    );
  } catch {
    // Timeout — idle chain where dust never connects (no DustLedgerEvents).
    // Fall back to the latest available state (dust balance will be 0, which
    // is correct for a chain with no dust activity).
    return await rx.firstValueFrom(bundle.facade.state());
  }
}

/**
 * Wait for dust coins to actually be available (not just synced).
 *
 * `waitForLiteSyncedState` checks sync progress (`isStrictlyComplete`), but that
 * resolves before `availableCoins` is populated. This helper waits until the dust
 * wallet has at least one available coin, which is required for any write operation
 * (balancing, transfers, swaps).
 *
 * On preprod: may take 10-30s after sync for dust coins to appear.
 * Timeout falls back gracefully — the server still starts, but writes will fail
 * until dust becomes available (the retry wrapper in dapp-connector handles that).
 */
/** Whether the wallet holds dust it can spend on fees right now. */
export function hasDustAvailable(state: FacadeState): boolean {
  return state.dust.availableCoins.length > 0 || state.dust.balance(new Date()) > 0n;
}

export async function waitForDustAvailable(bundle: FacadeBundle, timeoutMs = 60_000, signal?: AbortSignal): Promise<FacadeState> {
  throwIfCancelled(signal);
  const cancelled = signal === undefined ? rx.NEVER : rx.fromEvent(signal, 'abort');
  try {
    return await rx.firstValueFrom(
      bundle.facade.state().pipe(
        rx.filter(hasDustAvailable),
        rx.timeout(timeoutMs),
        rx.takeUntil(cancelled),
      )
    );
  } catch {
    throwIfCancelled(signal);
    // Timeout — dust may not be available yet (fresh wallet, slow chain).
    // Return latest state; caller should handle gracefully.
    return await rx.firstValueFrom(bundle.facade.state());
  }
}

/**
 * Quick sync for pre-send validation.
 * Shorter timeout — just catches stale UTXOs before building a transaction.
 */
export async function quickSync(bundle: FacadeBundle, syncMode: SyncMode = 'full'): Promise<FacadeState> {
  return rx.firstValueFrom(
    bundle.facade.state().pipe(
      rx.filter((state) => isFacadeSynced(state, syncMode, bundle.emptyStreams)),
      rx.timeout(PRE_SEND_SYNC_TIMEOUT_MS),
    )
  );
}

/** How long stopFacade waits for the SDK's wallets to stop. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Clean shutdown of the wallet facade.
 */
export async function stopFacade(bundle: FacadeBundle): Promise<void> {
  bundle.keepAlive?.unsubscribe();
  // Timeout facade.stop() — wallets may hang if in a bad state (e.g. dust wallet stuck).
  // Don't block the caller forever; let the old facade be GC'd. The wait is
  // cleared once the facade stops, so it doesn't keep the process up 5 s more.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bundle.facade.stop(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

