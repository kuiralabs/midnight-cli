// Cache for the indexer-direct dust reader.
//
// Persists a serialized Dust local state (ledger 8 or 9) + the last event id we applied to
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

import { dustCacheDir, getDustCachePath } from '@kuiralabs/midnight-cli-core/engine';
import { DIR_MODE, FILE_MODE } from '@kuiralabs/midnight-cli-core';
import { deriveDustSeed } from './derivation.ts';
import { type DustRetention } from './dust-event-fold.ts';
import { deserializeDustLedgerState, serializeDustLedgerState, type DustLedger, type DustLedgerState } from './dust-ledger-state.ts';

// v2 added the retention fields (owned generation indices + frontier) that the
// generation-tree collapse needs. v1 caches lack them and are invalidated, so
// they re-sync once and come back collapsed.
// v3: ledger-9 states replace ledger-8 ones. Dev-preset localnets share a genesis
// hash, so the chain-id guard can't keep a ledger-8 cache off a ledger-9 chain.
// v4: `ledgerVersion` names the state's ledger: a chain that forked from ledger 8 has a
// ledger-8 state until its sync passes the fork. Both ledgers serialize a Dust
// local state under the same header (`dust-local-state[v1]`), so the bytes
// can't tell; the entry has to. A v3 entry holds a ledger-9 state (this engine
// wrote nothing else under v3), so it is still read, as one.
const DUST_CACHE_VERSION = 4;
const LEDGER_9_ONLY_CACHE_VERSION = 3;

interface DustCacheFile {
  version: number;
  network: string;
  dustPublicKeyHex: string;
  lastAppliedEventId: number;
  /** Genesis block hash — see wallet-cache.ts for the rationale. Optional for back-compat. */
  chainId?: string;
  timestamp: string;
  dustState: string; // hex-encoded DustLocalState.serialize() of `ledger`
  /** The ledger whose library reads `dustState`. Absent in v3 entries, which are all ledger 9. */
  ledgerVersion?: DustLedger;
  /** Generation-tree indices owned by this wallet (never collapsed). */
  ownedGenerationIndices: number[];
  /** Next-free generation index the state has reached. */
  generationFrontier: number;
}

export interface DustCacheEntry {
  state: DustLedgerState;
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


/** The ledger of a cache entry's state, or null when the entry's version or ledger is not one this engine reads. */
function entryLedger(parsed: DustCacheFile): DustLedger | null {
  if (parsed.version === LEDGER_9_ONLY_CACHE_VERSION) return 9;
  if (parsed.version !== DUST_CACHE_VERSION) return null;
  return parsed.ledgerVersion === 8 || parsed.ledgerVersion === 9 ? parsed.ledgerVersion : null;
}

/**
 * Load a cached Dust state for the given (network, dust pubkey).
 * Returns null if missing, corrupt, version-mismatched, or network/pubkey-mismatched.
 */
export function loadDustCache(
  network: string,
  pubkeyHex: string,
  root: string,
): DustCacheEntry | null {
  const path = getDustCachePath(network, pubkeyHex, root);
  if (!existsSync(path)) return null;

  try {
    const parsed: DustCacheFile = JSON.parse(readFileSync(path, 'utf-8'));
    const stateLedger = entryLedger(parsed);
    if (stateLedger === null) return null;
    if (parsed.network !== network) return null;
    if (parsed.dustPublicKeyHex !== pubkeyHex) return null;
    if (typeof parsed.lastAppliedEventId !== 'number') return null;
    if (typeof parsed.dustState !== 'string') return null;
    if (!Array.isArray(parsed.ownedGenerationIndices)) return null;
    if (typeof parsed.generationFrontier !== 'number') return null;

    const state = deserializeDustLedgerState(stateLedger, Buffer.from(parsed.dustState, 'hex'));
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
 * Serialize a Dust state + lastAppliedEventId to disk atomically.
 */
export function saveDustCache(
  network: string,
  pubkeyHex: string,
  state: DustLedgerState,
  lastAppliedEventId: number,
  root: string,
  chainId?: string,
  retention: DustRetention = EMPTY_RETENTION,
): void {
  const data: DustCacheFile = {
    version: DUST_CACHE_VERSION,
    network,
    dustPublicKeyHex: pubkeyHex,
    lastAppliedEventId,
    timestamp: new Date().toISOString(),
    dustState: Buffer.from(serializeDustLedgerState(state)).toString('hex'),
    ledgerVersion: state.ledgerVersion,
    ownedGenerationIndices: retention.ownedGenerationIndices,
    generationFrontier: retention.generationFrontier,
    ...(chainId ? { chainId } : {}),
  };

  const path = getDustCachePath(network, pubkeyHex, root);
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
  root: string,
): string[] {
  // Caller fetches the chain's current genesis hash once and passes it in.
  // A null hash (node unreachable) skips validation — proceed best-effort.
  if (!currentChainId) return [];

  const dir = dustCacheDir(network, root);
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

