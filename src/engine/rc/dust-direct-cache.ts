// Cache for the indexer-direct dust reader.
//
// Persists a serialized `DustLocalState` + the last event id we applied to
// disk, keyed by (network, dust public key). On next run we restore the state
// and resume the subscription from `lastAppliedEventId + 1` — delta-sync
// instead of re-reading the full event history.
//
// Security: the cached state contains owned UTXOs but NOT the dust secret
// key. Same sensitivity as the wallet file (mode 0o600).

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import * as ledger from '@midnightntwrk/ledger-v9';

import { DIR_MODE, FILE_MODE } from '../../lib/constants.ts';
import { deriveDustSeed } from './derivation.ts';
import { type DustRetention } from './dust-direct.ts';
import { dustCacheDir, getDustCachePath } from '../../lib/reader-cache-files.ts';

// v2 added the retention fields (owned generation indices + frontier) that the
// generation-tree collapse needs. v1 caches lack them and are invalidated, so
// they re-sync once and come back collapsed.
// v3: ledger-9 states replace ledger-8 ones. Dev-preset localnets share a genesis
// hash, so the chain-id guard can't keep a ledger-8 cache off a ledger-9 chain.
const DUST_CACHE_VERSION = 3;

interface DustCacheFile {
  version: number;
  network: string;
  dustPublicKeyHex: string;
  lastAppliedEventId: number;
  /** Genesis block hash — see wallet-cache.ts for the rationale. Optional for back-compat. */
  chainId?: string;
  timestamp: string;
  dustState: string; // hex-encoded DustLocalState.serialize()
  /** Generation-tree indices owned by this wallet (never collapsed). */
  ownedGenerationIndices: number[];
  /** Next-free generation index the state has reached. */
  generationFrontier: number;
}

export interface DustCacheEntry {
  state: ledger.DustLocalState;
  lastAppliedEventId: number;
  retention: DustRetention;
}

const EMPTY_RETENTION: DustRetention = { ownedGenerationIndices: [], generationFrontier: 0 };

/** Normalize a DustPublicKey (bigint) to a fixed-width 64-char hex string. */
export function dustPublicKeyHex(publicKey: ledger.DustPublicKey): string {
  return publicKey.toString(16).padStart(64, '0');
}

/**
 * Derive the dust public key (as hex) from a wallet seed. Convenience for
 * callers that want to look up dust-direct cache entries by wallet rather
 * than by raw public key.
 */
export function dustPublicKeyHexFromSeed(seedBuffer: Buffer): string {
  const dustSeed = deriveDustSeed(seedBuffer);
  const sk = ledger.DustSecretKey.fromSeed(dustSeed);
  return dustPublicKeyHex(sk.publicKey);
}


/**
 * Load a cached DustLocalState for the given (network, dust pubkey).
 * Returns null if missing, corrupt, version-mismatched, or network/pubkey-mismatched.
 */
export function loadDustCache(
  network: string,
  pubkeyHex: string,
  cacheDir?: string,
): DustCacheEntry | null {
  const path = getDustCachePath(network, pubkeyHex, cacheDir);
  if (!existsSync(path)) return null;

  try {
    const parsed: DustCacheFile = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.version !== DUST_CACHE_VERSION) return null;
    if (parsed.network !== network) return null;
    if (parsed.dustPublicKeyHex !== pubkeyHex) return null;
    if (typeof parsed.lastAppliedEventId !== 'number') return null;
    if (typeof parsed.dustState !== 'string') return null;
    if (!Array.isArray(parsed.ownedGenerationIndices)) return null;
    if (typeof parsed.generationFrontier !== 'number') return null;

    const bytes = Buffer.from(parsed.dustState, 'hex');
    const state = ledger.DustLocalState.deserialize(bytes);
    return {
      state,
      lastAppliedEventId: parsed.lastAppliedEventId,
      retention: {
        ownedGenerationIndices: parsed.ownedGenerationIndices,
        generationFrontier: parsed.generationFrontier,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Serialize a DustLocalState + lastAppliedEventId to disk atomically.
 */
export function saveDustCache(
  network: string,
  pubkeyHex: string,
  state: ledger.DustLocalState,
  lastAppliedEventId: number,
  cacheDir?: string,
  chainId?: string,
  retention: DustRetention = EMPTY_RETENTION,
): void {
  const data: DustCacheFile = {
    version: DUST_CACHE_VERSION,
    network,
    dustPublicKeyHex: pubkeyHex,
    lastAppliedEventId,
    timestamp: new Date().toISOString(),
    dustState: Buffer.from(state.serialize()).toString('hex'),
    ownedGenerationIndices: retention.ownedGenerationIndices,
    generationFrontier: retention.generationFrontier,
    ...(chainId ? { chainId } : {}),
  };

  const path = getDustCachePath(network, pubkeyHex, cacheDir);
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }

  const tmpPath = path + `.tmp.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data), { mode: FILE_MODE });
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Wipe every dust-direct cache file for a network whose stored chainId
 * doesn't match the chain's current genesis hash. Paired with
 * `validateWalletCacheChainId` — both get called at command startup.
 * Returns wiped paths.
 */
export function validateDustCacheChainId(
  network: string,
  currentChainId: string | null,
  cacheDir?: string,
): string[] {
  // Caller fetches the chain's current genesis hash once and passes it in.
  // A null hash (node unreachable) skips validation — proceed best-effort.
  if (!currentChainId) return [];

  const dir = dustCacheDir(network, cacheDir);
  if (!existsSync(dir)) return [];

  const wiped: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }

  for (const file of entries) {
    if (!file.startsWith('dust-') || !file.endsWith('.json')) continue;
    const path = join(dir, file);
    try {
      const parsed: DustCacheFile = JSON.parse(readFileSync(path, 'utf-8'));
      if (!parsed.chainId) continue; // legacy — back-compat
      if (parsed.chainId !== currentChainId) {
        unlinkSync(path);
        wiped.push(path);
      }
    } catch { /* skip */ }
  }
  return wiped;
}

