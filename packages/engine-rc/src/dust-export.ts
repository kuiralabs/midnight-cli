// Export a facade-restorable dust snapshot for a seed.
//
// Combines a full dust sync with a base facade dust snapshot (built from keys,
// never connected) to produce a JSON blob that ANY wallet on the same seed can
// hand to `DustWallet.restore(...)` (e.g. via a wallet-SDK facade's
// `dustSerializedState`) to skip the slow cold dust scan. This is the seam a
// dApp operator uses to warm up in seconds instead of re-scanning the whole
// dust event history on every restart.
//
// The sync runs through `WalletDataRepository.dust()` rather than calling the
// indexer-direct reader itself. That is deliberate: the repository owns the
// native-sidecar acceleration (~5x on a cold preprod sync) and the
// partial-resume loop that carries a from-scratch sync past the underlying
// fetcher's soft timeout. Calling the reader directly — as this module used to —
// got neither, so a fresh wallet on preprod silently exported a snapshot cut off
// at the 600s mark.
//
// Pure logic: returns values, never writes to stdout/stderr or exits.

import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import { buildFacade, stopFacade, overlayDustDirectSnapshot } from './facade.ts';
import { type NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import { defaultRepository, type WalletDataRepository } from './wallet-data-repository.ts';
import type { VerboseLog } from '@kuiralabs/midnight-cli-core/lib/verbose';
import type { NoticeSink } from '@kuiralabs/midnight-cli-core/lib/notices';
import type { DustExportResult } from '@kuiralabs/midnight-cli-core/lib/engine';
export type { DustExportResult } from '@kuiralabs/midnight-cli-core/lib/engine';


export interface DustExportOptions {
  /** The state root the Dust cache lives under. */
  root: string;
  /** Where the export's lines for the person go (the host's notices). */
  notice: NoticeSink;
  onProgress?: (eventsApplied: number, maxIdSeen: number) => void;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the process-wide repository. */
  repository?: WalletDataRepository;
  /**
   * Produce the base (empty) dust snapshot to overlay onto. Injectable for tests;
   * defaults to building a fresh facade from keys and reading its dust snapshot.
   * The default touches the node relay (building a facade opens its API-WS), so
   * tests stub this to stay offline.
   */
  buildBaseDust?: (seed: Buffer, networkConfig: NetworkConfig, root: string, notice: NoticeSink, log?: VerboseLog) => Promise<string>;
  /** The call's verbose lines. */
  log?: VerboseLog;
}

/** Build a fresh facade from keys and read its base (empty) dust snapshot. */
async function defaultBuildBaseDust(seedBuffer: Buffer, networkConfig: NetworkConfig, root: string, notice: NoticeSink, log?: VerboseLog): Promise<string> {
  const bundle = await buildFacade(seedBuffer, networkConfig, root, notice, null, log);
  try {
    return await (bundle.facade as unknown as {
      dust: { serializeState(): Promise<string> };
    }).dust.serializeState();
  } finally {
    await stopFacade(bundle);
  }
}

/**
 * Produce a restorable dust snapshot for `seedBuffer` on `network`.
 *
 * 1. Full dust sync via the repository (native sidecar when available, WASM
 *    otherwise; resumes from the on-disk checkpoint and retries past partials).
 * 2. Build a fresh facade (from keys only — no `start()`, so no network I/O)
 *    to get a correctly-shaped base dust snapshot (publicKey/protocolVersion/
 *    networkId + schema).
 * 3. Overlay the synced `DustLocalState` onto that base — the same operation
 *    `maybeBridgeDustCache` does for the CLI's own write commands.
 */
export async function exportDustSnapshot(
  seedBuffer: Buffer,
  network: string,
  networkConfig: NetworkConfig,
  options: DustExportOptions,
): Promise<DustExportResult> {
  const pubkeyHex = dustPublicKeyHexFromSeed(seedBuffer);
  const repo = options.repository ?? defaultRepository();

  const view = await repo.dust(seedBuffer, networkConfig, {
    root: options.root,
    notice: options.notice,
    signal: options.signal,
    onProgress: options.onProgress,
    log: options.log,
  });

  const baseDust = await (options.buildBaseDust ?? defaultBuildBaseDust)(seedBuffer, networkConfig, options.root, options.notice, options.log);

  // Overlay whenever at least one event has been folded in. For a wallet with no
  // dust events yet (lastAppliedEventId -1) the fresh base snapshot is already the
  // correct empty state and carries a valid offset 0, so leave it untouched.
  // The state + offset come from the view rather than re-reading the cache file:
  // the repository may be pointed at a different cache dir, and its in-memory view
  // is authoritative for the sync that just ran.
  const snapshot = view.lastAppliedEventId >= 0
    ? overlayDustDirectSnapshot(baseDust, {
        state: view.state,
        lastAppliedEventId: view.lastAppliedEventId,
      })
    : baseDust;

  return {
    network,
    dustPublicKey: pubkeyHex,
    offset: view.lastAppliedEventId,
    balance: view.balance,
    eventCount: view.eventsApplied,
    fromCache: view.fromCache,
    partial: view.partial,
    snapshot,
  };
}
