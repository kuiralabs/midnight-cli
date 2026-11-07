// Native dust-sync bridge: run the Rust `dust-sync` sidecar and adapt its output
// to a `DustDirectResult`, so it drops into the repository's `fetchDust` seam.
// Several times faster on a cold dust sync. If the binary is missing or the run
// fails, callers fall back to the WASM path — the sidecar is an optional
// accelerator, never a hard dependency.

import { cacheRootDir, networkCacheFolder, nativeCheckpointName } from '@kuiralabs/midnight-cli-core/engine';
import { assertEndpointUsable, DIR_MODE, DISABLE_NATIVE_DUST_ENV, DUST_SYNC_BIN_ENV, FILE_MODE, type NetworkConfig, type Settings } from '@kuiralabs/midnight-cli-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as ledger from '@midnightntwrk/ledger-v9';

import { deriveDustSeed } from './derivation.ts';
import { type DustDirectResult, type DustRetention } from './dust-direct.ts';
import { type DustLedgerState } from './dust-ledger-state.ts';
import { collapseForeignGenerations } from './dust-collapse.ts';
import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import { ledgerOfProtocolVersion } from './dust-ledger-state.ts';
import { FORK_SCHEDULE } from './fork-schedule.ts';

/**
 * The ledger of the Dust states this engine reads, and so the only ledger a
 * sidecar may fold with: it replays events with its own copy of the ledger,
 * and its state is deserialized with this engine's.
 */
export const SIDECAR_LEDGER = 9;

/** A sidecar checkpoint holds a Dust state of another ledger than this engine reads. */
export class SidecarLedgerMismatchError extends Error {
  constructor(readonly ledger: number) {
    super(`the dust-sync sidecar returned a ledger-${ledger} Dust state; this engine reads ledger ${SIDECAR_LEDGER}. Reinstall mn so its dust-sync package matches it.`);
    this.name = 'SidecarLedgerMismatchError';
    Object.setPrototypeOf(this, SidecarLedgerMismatchError.prototype);
  }
}

/** Sidecar checkpoint JSON shape (snake_case — matches the Rust `Checkpoint`). */
export interface SidecarCheckpoint {
  /** The ledger of `dust_state`; absent in a checkpoint from a sidecar built before ledger 9. */
  ledger?: number;
  dust_state: string;
  last_applied_event_id: number;
  owned_generation_indices: number[];
  generation_frontier: number;
  balance: string;
  available_coins: number;
  events_applied: number;
  partial: boolean;
  /**
   * The run stopped inside a forked chain's ledger-8 events: the cursor says
   * how far the sidecar read (it resumes from its own file), and `dust_state`
   * is not a state at that cursor. Absent in older checkpoints.
   */
  before_fork?: boolean;
}

interface NativeFetchOptions {
  startFromId: number;
  initialState?: DustLedgerState;
  initialRetention?: DustRetention;
  signal?: AbortSignal;
  onProgress?: (applied: number, max: number) => void;
  /** The state root: the checkpoint lives beside the other Dust caches under it. */
  root: string;
  /** The engine's host's settings: the sidecar to run, and whether to collapse its state. */
  settings: Settings;
}

/**
 * Locate the sidecar binary. Order: the settings' override (MN_DUST_SYNC_BIN) →
 * the dev build under sidecar/dust-sync → the optional platform package.
 * Returns null when none resolve (→ WASM fallback).
 */
export function resolveSidecarBinary(settings: Pick<Settings, 'dustSyncBin'>): string | null {
  const fromEnv = settings.dustSyncBin;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const exe = process.platform === 'win32' ? 'dust-sync.exe' : 'dust-sync';
  // Dev build (repo checkout): sidecar/dust-sync/target/release/dust-sync,
  // three levels up from the engine package's src/ (tsx) and from its dist/.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of [['..', '..', '..']]) {
    const devBuild = join(here, ...up, 'sidecar', 'dust-sync', 'target', 'release', exe);
    if (existsSync(devBuild)) return devBuild;
  }

  return platformPackageBinary(import.meta.url);
}

/**
 * The sidecar binary in the platform package (@kuiralabs/dust-sync-<os>-<arch>)
 * resolvable from `fromUrl`, or null when it isn't installed. Resolved with
 * node:module's createRequire, which works from source and from the bundle.
 */
export function platformPackageBinary(fromUrl: string): string | null {
  const exe = process.platform === 'win32' ? 'dust-sync.exe' : 'dust-sync';
  try {
    const pkg = sidecarPackageName();
    const binPath = join(dirname(createRequire(fromUrl).resolve(`${pkg}/package.json`)), exe);
    return existsSync(binPath) ? binPath : null;
  } catch {
    return null; // package not installed
  }
}

/** A network mn doesn't run itself (preview, preprod, mainnet): its Dust history is long, and read through the sidecar. */
export function isHostedNetwork(network: Pick<NetworkConfig, 'networkId'>): boolean {
  return network.networkId !== 'Undeployed';
}

/** The notice a hosted network's Dust read in WASM gives, with why it isn't the sidecar's. */
export function wasmDustNotice(networkName: string, why: string): string {
  return `  Dust on ${networkName} is read in-process (WASM), slower than the native dust-sync sidecar: ${why}.`;
}

/** The platform package that ships the sidecar for this machine. */
export function sidecarPackageName(): string {
  return `@kuiralabs/dust-sync-${process.platform}-${process.arch}`;
}

const LEDGER_PROBE_TIMEOUT_MS = 5_000;

/**
 * The ledger a sidecar binary folds with, as its `--ledger` prints it; null
 * when it can't say (a sidecar built before ledger 9 refuses the flag). Asked
 * on every sync (a few milliseconds), so a replaced binary is never trusted on
 * an earlier answer.
 */
export function sidecarLedger(bin: string): number | null {
  const run = spawnSync(bin, ['--ledger'], { encoding: 'utf-8', timeout: LEDGER_PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  const printed = run.status === 0 ? run.stdout.trim() : '';
  return /^\d+$/.test(printed) ? Number(printed) : null;
}

/**
 * Why the native sidecar can't be used, or null when it can: it is turned
 * off, no binary resolves, or the one that does folds another ledger than
 * this engine's.
 */
export function sidecarUnavailableReason(settings: Pick<Settings, 'isNativeDustOff' | 'dustSyncBin'>): string | null {
  if (settings.isNativeDustOff) return `the native sidecar is turned off (${DISABLE_NATIVE_DUST_ENV}=1)`;
  const bin = resolveSidecarBinary(settings);
  if (bin === null) {
    const named = settings.dustSyncBin ? `, and ${DUST_SYNC_BIN_ENV} names no file (${settings.dustSyncBin})` : '';
    return `no dust-sync sidecar is installed (no ${sidecarPackageName()} package${named})`;
  }
  const folds = sidecarLedger(bin);
  if (folds === SIDECAR_LEDGER) return null;
  return `the dust-sync sidecar at ${bin} ${folds === null ? "doesn't say which ledger it folds" : `folds ledger ${folds}`}, and this mn reads ledger ${SIDECAR_LEDGER}: reinstall mn`;
}

/** True when the native sidecar should be used: not disabled, a binary resolves, and it folds this engine's ledger. */
export function nativeDustSyncAvailable(settings: Pick<Settings, 'isNativeDustOff' | 'dustSyncBin'>): boolean {
  return sidecarUnavailableReason(settings) === null;
}

/**
 * Why the sidecar's result would not be the one mn's reader reaches for this
 * sync, or null when it would. The sidecar folds ledger 9 only: on a forked
 * chain it reads the ledger-8 events and starts its fold at the fork, which
 * equals mn's reader only when the sync ends past the fork. So the chain tip
 * must be known to be on ledger 9, and a sync resuming a ledger-8 checkpoint
 * (one that stopped before the fork) is left to mn's reader, which crosses the
 * fork from it.
 */
export function sidecarSkipReason(sync: { chainProtocolVersion: bigint | null; initialState?: DustLedgerState }): string | null {
  if (sync.chainProtocolVersion === null) return "the indexer didn't say which protocol version the chain is on";
  if (ledgerOfProtocolVersion(sync.chainProtocolVersion) !== 9) return `the chain is on ledger 8 (protocol version ${sync.chainProtocolVersion})`;
  if (sync.initialState !== undefined && sync.initialState.ledgerVersion !== 9) {
    return 'the Dust checkpoint stopped before the chain\'s fork to ledger 9, and the sidecar folds ledger 9 only';
  }
  return null;
}

/** True when the sidecar's result is the one mn's reader would reach for this sync (see sidecarSkipReason). */
export function sidecarServesSync(sync: { chainProtocolVersion: bigint | null; initialState?: DustLedgerState }): boolean {
  return sidecarSkipReason(sync) === null;
}

/**
 * Choose how to resume the sidecar, kill-safely:
 *  - `existing`: an on-disk checkpoint already reaches the requested cursor
 *    (e.g. a prior run was killed mid-sync) — resume from it, don't rewind.
 *  - `seed`: no usable checkpoint but the repo has cached state — seed from it.
 *  - `fresh`: nothing to resume from — sync from the start.
 * `existingCursor` is a last-applied-event-id (-2 if no checkpoint).
 */
export function resumeDecision(existingCursor: number, startFromId: number, hasInitialState: boolean): 'existing' | 'seed' | 'fresh' {
  if (existingCursor + 1 >= startFromId) return 'existing';
  if (hasInitialState) return 'seed';
  return 'fresh';
}

/**
 * Last-applied event id in a sidecar checkpoint file, or -2 if absent,
 * unreadable, or of another ledger (one an earlier sidecar wrote on ledger 8).
 */
export function readCheckpointCursor(path: string): number {
  if (!existsSync(path)) return -2;
  try {
    const cp: SidecarCheckpoint = JSON.parse(readFileSync(path, 'utf-8'));
    if (cp.ledger !== SIDECAR_LEDGER) return -2;
    return typeof cp.last_applied_event_id === 'number' ? cp.last_applied_event_id : -2;
  } catch { return -2; }
}

/** The sidecar's checkpoint file for a Dust key, beside the other Dust caches. */

function nativeCheckpointPath(networkName: string, pubkeyHex: string, root: string): string {
  const dir = join(cacheRootDir(root), networkCacheFolder(networkName, root));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return join(dir, nativeCheckpointName(pubkeyHex));
}


/**
 * Run the native sidecar for a dust sync and adapt to `DustDirectResult`.
 * Rejects (so the caller can fall back) if the binary is missing or the run
 * fails. Aborting via `signal` sends SIGINT — the sidecar checkpoints and exits,
 * yielding a `partial` result the repo persists and resumes from.
 */
export function runDustSyncNative(
  seed: Buffer,
  network: NetworkConfig,
  opts: NativeFetchOptions,
): Promise<DustDirectResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveSidecarBinary(opts.settings);
    if (!bin) { reject(new Error('dust-sync sidecar not found')); return; }
    assertEndpointUsable(network.indexerWS);

    const networkName = network.networkId.toLowerCase();
    const pubkeyHex = dustPublicKeyHexFromSeed(seed);
    const out = nativeCheckpointPath(networkName, pubkeyHex, opts.root);

    // Resume selection (out == resume file; the sidecar reads it once at start,
    // then overwrites it with its own checkpoints — kill-safe at this path):
    //  - if an existing sidecar checkpoint is already AT/PAST the repo's cursor
    //    (e.g. a prior run was killed mid-sync), keep it — don't rewind it.
    //  - else seed it from the repo's cached state so we resume from there.
    //  - else (no cache) let the sidecar start fresh.
    const args = ['--indexer-ws', network.indexerWS, '--out', out, '--ledger9-from', String(FORK_SCHEDULE.v9)];
    const decision = resumeDecision(readCheckpointCursor(out), opts.startFromId, !!opts.initialState);
    if (decision === 'seed') {
      // The sidecar reads ledger-9 states only; a ledger-8 checkpoint (a forked
      // chain's sync stopped before the fork) is left to the WASM reader.
      if (opts.initialState!.ledgerVersion !== SIDECAR_LEDGER) { reject(new SidecarLedgerMismatchError(opts.initialState!.ledgerVersion)); return; }
      const seedCp: SidecarCheckpoint = {
        ledger: SIDECAR_LEDGER,
        dust_state: Buffer.from(opts.initialState!.state.serialize()).toString('hex'),
        last_applied_event_id: opts.startFromId - 1,
        owned_generation_indices: opts.initialRetention?.ownedGenerationIndices ?? [],
        generation_frontier: opts.initialRetention?.generationFrontier ?? 0,
        balance: '0', available_coins: 0, events_applied: 0, partial: true,
      };
      writeFileSync(out, JSON.stringify(seedCp), { mode: FILE_MODE });
    }
    if (decision !== 'fresh') args.push('--resume', out);

    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const onAbort = () => { try { child.kill('SIGINT'); } catch { /* already gone */ } };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Feed the derived dust seed on stdin (sidecar zeroizes it), then close.
    // If the sidecar exits before reading stdin, the write races an EPIPE that
    // would otherwise surface as an unhandled stream 'error' and crash us. Swallow
    // it here — the real outcome is reported via child.on('close'/'error').
    child.stdin.on('error', () => { /* EPIPE: child gone; handled by close/error */ });
    const dustSeedHex = Buffer.from(deriveDustSeed(seed)).toString('hex');
    child.stdin.write(dustSeedHex + '\n');
    child.stdin.end();

    let stdout = '';
    let stderrTail = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      // Parse "dust-sync: applied <n> / <max>" progress lines.
      for (const m of s.matchAll(/applied (\d+) \/ (\d+)/g)) {
        opts.onProgress?.(Number(m[1]), Number(m[2]));
      }
    });

    child.on('error', (err) => { opts.signal?.removeEventListener('abort', onAbort); reject(err); });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      // The sidecar answers SIGINT itself (checkpoint, then exit 0), so any
      // other exit is a failure, whatever is left at `out`. That file may be our
      // own seed checkpoint or one the dead run never finished.
      if (code !== 0) {
        reject(new Error(`dust-sync exited ${code}: ${stderrTail.trim().slice(-300)}`));
        return;
      }
      try {
        // Prefer the final stdout line; fall back to the checkpoint file.
        const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
        const cp: SidecarCheckpoint = lastLine
          ? JSON.parse(lastLine)
          : JSON.parse(readFileSync(out, 'utf-8'));
        resolve(adaptResult(cp, opts.settings));
      } catch (err) {
        reject(err instanceof SidecarLedgerMismatchError ? err : new Error(`dust-sync output parse failed: ${(err as Error).message}`));
      }
    });
  });
}

/** Map the sidecar's checkpoint JSON to a `DustDirectResult`, collapsed unless the settings say not to. Exported for tests. */
export function adaptResult(cp: SidecarCheckpoint, settings: Pick<Settings, 'isDustCollapseOff'>): DustDirectResult {
  if (cp.ledger !== SIDECAR_LEDGER) throw new SidecarLedgerMismatchError(cp.ledger ?? 8);
  if (cp.before_fork && !cp.partial) throw new Error('dust-sync reported a finished run that stopped before the fork');
  const now = new Date();
  let state = ledger.DustLocalState.deserialize(new Uint8Array(Buffer.from(cp.dust_state, 'hex')));
  // The Rust sidecar doesn't collapse the generation tree, so a native sync would
  // otherwise persist/export an unbounded state (~1.46 MB on a cold preprod wallet
  // vs ~23 KB collapsed). Apply the same TS collapse the WASM reader uses, reusing
  // the owned-indices + frontier the checkpoint already carries. Idempotent, and it
  // fails safe to the uncollapsed state via the balance+root guard.
  if (!settings.isDustCollapseOff) {
    const owned = new Set(cp.owned_generation_indices.map((i) => BigInt(i)));
    state = collapseForeignGenerations(state, owned, BigInt(cp.generation_frontier)).state;
  }
  // processTtls is immutable (returns a new state) — parity with the WASM reader,
  // which drops expired coins before reading the balance.
  state = state.processTtls(now);
  const utxoCount = state.utxos.length;
  return {
    balance: state.walletBalance(now),
    availableCoins: utxoCount,
    eventCount: cp.events_applied,
    ownedUtxoCount: utxoCount,
    syncTime: state.syncTime instanceof Date ? state.syncTime : new Date(String(state.syncTime)),
    state: { ledgerVersion: 9, state },
    retention: {
      ownedGenerationIndices: cp.owned_generation_indices,
      generationFrontier: cp.generation_frontier,
    },
    // A run stopped before the fork holds no Dust state at its cursor: the
    // repository keeps nothing from it (its cursor stays where it was), and the
    // sidecar's next run resumes reading from its own checkpoint file.
    lastAppliedEventId: cp.before_fork ? -1 : cp.last_applied_event_id,
    partial: cp.partial,
  };
}
