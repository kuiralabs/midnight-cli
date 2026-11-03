// Native dust-sync bridge: run the Rust `dust-sync` sidecar and adapt its output
// to a `DustDirectResult`, so it drops into the repository's `fetchDust` seam.
// Several times faster on a cold dust sync. If the binary is missing or the run
// fails, callers fall back to the WASM path — the sidecar is an optional
// accelerator, never a hard dependency.

import { assertEndpointUsable } from '@kuiralabs/midnight-cli-core/lib/blockfrost';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as ledger from '@midnightntwrk/ledger-v9';

import { DIR_MODE, FILE_MODE } from '@kuiralabs/midnight-cli-core/lib/constants';
import { deriveDustSeed } from './derivation.ts';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import { type DustDirectResult, type DustRetention } from './dust-direct.ts';
import { collapseForeignGenerations } from './dust-collapse.ts';
import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import type { Settings } from '@kuiralabs/midnight-cli-core/lib/settings';
import { cacheRootDir, networkCacheFolder } from '@kuiralabs/midnight-cli-core/lib/wallet-cache';
import { nativeCheckpointName } from '@kuiralabs/midnight-cli-core/lib/reader-cache-files';

/** Sidecar checkpoint JSON shape (snake_case — matches the Rust `Checkpoint`). */
export interface SidecarCheckpoint {
  dust_state: string;
  last_applied_event_id: number;
  owned_generation_indices: number[];
  generation_frontier: number;
  balance: string;
  available_coins: number;
  events_applied: number;
  partial: boolean;
}

interface NativeFetchOptions {
  startFromId: number;
  initialState?: ledger.DustLocalState;
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
 * the (Phase 3) optional platform package → the dev build under
 * sidecar/dust-sync. Returns null when none resolve (→ WASM fallback).
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

  // Phase 3 platform package: @nel349/dust-sync-<os>-<arch>.
  return platformPackageBinary(import.meta.url);
}

/**
 * The sidecar binary in the platform package (@nel349/dust-sync-<os>-<arch>)
 * resolvable from `fromUrl`, or null when it isn't installed. Resolved with
 * node:module's createRequire, which works from source and from the bundle.
 */
export function platformPackageBinary(fromUrl: string): string | null {
  const exe = process.platform === 'win32' ? 'dust-sync.exe' : 'dust-sync';
  try {
    const pkg = `@nel349/dust-sync-${process.platform}-${process.arch}`;
    const binPath = join(dirname(createRequire(fromUrl).resolve(`${pkg}/package.json`)), exe);
    return existsSync(binPath) ? binPath : null;
  } catch {
    return null; // package not installed
  }
}


/** True when the native sidecar should be used (binary resolves + not disabled). */
/**
 * The ledger the sidecar binary is built against. It replays dust events with
 * its own copy of the ledger, so it can only serve a chain on the same ledger.
 * No ledger-9 `midnight-ledger` crate is published yet.
 */
const SIDECAR_LEDGER: number = 8;
/** The ledger this build of mn targets. */
const MN_LEDGER: number = 9;

export function nativeDustSyncAvailable(settings: Pick<Settings, 'isNativeDustOff' | 'dustSyncBin'>): boolean {
  if (SIDECAR_LEDGER !== MN_LEDGER) return false;
  if (settings.isNativeDustOff) return false;
  return resolveSidecarBinary(settings) !== null;
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

/** Last-applied event id in a sidecar checkpoint file, or -2 if absent/unreadable. */
function readCheckpointCursor(path: string): number {
  if (!existsSync(path)) return -2;
  try {
    const cp: SidecarCheckpoint = JSON.parse(readFileSync(path, 'utf-8'));
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
    const args = ['--indexer-ws', network.indexerWS, '--out', out];
    const decision = resumeDecision(readCheckpointCursor(out), opts.startFromId, !!opts.initialState);
    if (decision === 'seed') {
      const seedCp: SidecarCheckpoint = {
        dust_state: Buffer.from(opts.initialState!.serialize()).toString('hex'),
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
        reject(new Error(`dust-sync output parse failed: ${(err as Error).message}`));
      }
    });
  });
}

/** Map the sidecar's checkpoint JSON to a `DustDirectResult`, collapsed unless the settings say not to. Exported for tests. */
export function adaptResult(cp: SidecarCheckpoint, settings: Pick<Settings, 'isDustCollapseOff'>): DustDirectResult {
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
    state,
    retention: {
      ownedGenerationIndices: cp.owned_generation_indices,
      generationFrontier: cp.generation_frontier,
    },
    lastAppliedEventId: cp.last_applied_event_id,
    partial: cp.partial,
  };
}
