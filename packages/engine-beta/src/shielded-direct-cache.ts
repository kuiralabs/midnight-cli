// Cache for the indexer-direct shielded (zswap) reader.
//
// Persists a serialized `ZswapLocalState` + the last event id we applied to
// disk, keyed by (network, shielded coin public key). On next run we restore the
// state and resume the subscription from `lastAppliedEventId + 1` — delta-sync
// instead of re-reading the full zswap event history (which is ~50-70s cold on
// hosted networks; incremental is ~instant).
//
// Security: the cached state contains owned coins but NOT the secret keys. Same
// sensitivity as the wallet file (mode 0o600).

import { bindCachesToIndexer } from '@kuiralabs/midnight-cli-core/lib/cache-indexer';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import * as ledger from '@midnightntwrk/ledger-v9';

import { DIR_MODE, FILE_MODE } from '@kuiralabs/midnight-cli-core/lib/constants';
import { deriveShieldedSeed } from './derivation.ts';
import { readShieldedBalanceDirect, type ShieldedDirectOptions } from './shielded-direct.ts';
import { fetchEventTip, isCursorBeyondTip } from '@kuiralabs/midnight-chain/lib/event-tip';
import { clearShieldedDirectCache, getShieldedCachePath } from '@kuiralabs/midnight-cli-core/lib/reader-cache-files';

// v2: ledger-9 states replace ledger-8 ones. Dev-preset localnets share a genesis
// hash, so the chain-id guard can't keep a ledger-8 cache off a ledger-9 chain.
const SHIELDED_CACHE_VERSION = 2;

interface ShieldedCacheFile {
  version: number;
  network: string;
  coinPublicKeyHex: string;
  lastAppliedEventId: number;
  /** Genesis block hash — invalidates the cache on chain reset. Optional for back-compat. */
  chainId?: string;
  timestamp: string;
  zswapState: string; // hex-encoded ZswapLocalState.serialize()
}

export interface ShieldedCacheEntry {
  state: ledger.ZswapLocalState;
  lastAppliedEventId: number;
}

/**
 * Derive the shielded coin public key (as hex) from a wallet seed. Used to key
 * shielded-direct cache entries by wallet.
 */
export function shieldedCoinPublicKeyHexFromSeed(seedBuffer: Buffer): string {
  const keys = ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(seedBuffer));
  return keys.coinPublicKey;
}


/**
 * Load a cached ZswapLocalState for the given (network, coin pubkey).
 * Returns null if missing, corrupt, version-mismatched, network/pubkey-mismatched,
 * or — when `expectedChainId` is given and the cache recorded one — if the chain
 * genesis hash no longer matches (chain reset). A stale-chain cache is discarded
 * so a localnet reset can't surface a wrong balance from an old chain's coins.
 */
export function loadShieldedCache(
  network: string,
  pubkeyHex: string,
  root: string,
  expectedChainId?: string,
): ShieldedCacheEntry | null {
  const path = getShieldedCachePath(network, pubkeyHex, root);
  if (!existsSync(path)) return null;

  try {
    const parsed: ShieldedCacheFile = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.version !== SHIELDED_CACHE_VERSION) return null;
    if (parsed.network !== network) return null;
    if (parsed.coinPublicKeyHex !== pubkeyHex) return null;
    if (typeof parsed.lastAppliedEventId !== 'number') return null;
    if (typeof parsed.zswapState !== 'string') return null;
    if (expectedChainId && parsed.chainId && parsed.chainId !== expectedChainId) return null;

    const state = ledger.ZswapLocalState.deserialize(new Uint8Array(Buffer.from(parsed.zswapState, 'hex')));
    return { state, lastAppliedEventId: parsed.lastAppliedEventId };
  } catch {
    return null;
  }
}

/**
 * Serialize a ZswapLocalState + lastAppliedEventId to disk atomically.
 */
export function saveShieldedCache(
  network: string,
  pubkeyHex: string,
  state: ledger.ZswapLocalState,
  lastAppliedEventId: number,
  root: string,
  chainId?: string,
): void {
  const data: ShieldedCacheFile = {
    version: SHIELDED_CACHE_VERSION,
    network,
    coinPublicKeyHex: pubkeyHex,
    lastAppliedEventId,
    timestamp: new Date().toISOString(),
    zswapState: Buffer.from(state.serialize()).toString('hex'),
    ...(chainId ? { chainId } : {}),
  };

  const path = getShieldedCachePath(network, pubkeyHex, root);
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


export type { ShieldedBalanceResult, ShieldedCachedOptions } from '@kuiralabs/midnight-cli-core/lib/engine';
import type { ShieldedBalanceResult, ShieldedCachedOptions } from '@kuiralabs/midnight-cli-core/lib/engine';

/**
 * Read a wallet seed's shielded balances, using (and refreshing) the
 * indexer-direct cache. Loads any cached ZswapLocalState, resumes the
 * `zswapLedgerEvents` subscription from the last applied event, and persists the
 * extended state. First sync walks the full history (~50-70s on hosted nets);
 * subsequent calls are delta-syncs.
 */
export async function readShieldedBalanceCached(
  seedBuffer: Buffer,
  network: string,
  indexerWS: string,
  options: ShieldedCachedOptions,
): Promise<ShieldedBalanceResult> {
  const secretKeys = ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(seedBuffer));
  const pubkeyHex = secretKeys.coinPublicKey;

  // State resumed from another indexer's event ids would replay the wrong events.
  bindCachesToIndexer(network, indexerWS, options.root);
  let cached = options.forceFresh ? null : loadShieldedCache(network, pubkeyHex, options.root, options.chainId);
  // A cursor past the chain's latest event: the chain was reset under the cache.
  if (cached && isCursorBeyondTip(cached.lastAppliedEventId, await fetchEventTip(indexerWS, 'zswap'))) {
    clearShieldedDirectCache(network, pubkeyHex, options.root);
    cached = null;
  }
  const startFromId = cached ? cached.lastAppliedEventId + 1 : 0;

  const result = await readShieldedBalanceDirect(secretKeys, indexerWS, {
    initialState: cached?.state,
    startFromId,
    onProgress: options.onProgress,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    // Persist after each chunk so a Ctrl+C / kill during a cold ~70s sync
    // doesn't lose progress — the next call resumes from the last checkpoint.
    onCheckpoint: (state, lastAppliedEventId) => {
      try { saveShieldedCache(network, pubkeyHex, state, lastAppliedEventId, options.root, options.chainId); } catch { /* best-effort */ }
    },
  });

  // Only write if we advanced or this is a first sync. If we had a cache and zero
  // new events arrived, leave the on-disk file untouched.
  if (result.lastAppliedEventId >= 0) {
    saveShieldedCache(network, pubkeyHex, result.state, result.lastAppliedEventId, options.root, options.chainId);
  } else if (!cached) {
    saveShieldedCache(network, pubkeyHex, result.state, -1, options.root, options.chainId);
  }

  return {
    balance: result.balance,
    availableCoins: result.availableCoins,
    tokens: result.tokens,
    eventCount: result.eventCount,
    lastAppliedEventId: result.lastAppliedEventId >= 0
      ? result.lastAppliedEventId
      : (cached?.lastAppliedEventId ?? -1),
    fromCache: cached !== null,
    partial: result.partial,
  };
}
