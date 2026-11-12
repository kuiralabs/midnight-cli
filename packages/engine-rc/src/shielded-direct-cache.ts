// Cache for the indexer-direct shielded (zswap) reader.
//
// Persists a serialized `ZswapLocalState` (ledger 8 or 9) + the last event id we applied to
// disk, keyed by (network, shielded coin public key). On next run we restore the
// state and resume the subscription from `lastAppliedEventId + 1` — delta-sync
// instead of re-reading the full zswap event history (which is ~50-70s cold on
// hosted networks; incremental is ~instant).
//
// Security: the cached state contains owned coins but NOT the secret keys. Same
// sensitivity as the wallet file (mode 0o600).

import { bindCachesToIndexer, getShieldedCachePath, type ShieldedBalanceResult, type ShieldedCachedOptions } from '@kuiralabs/midnight-cli-core/engine';
import { DIR_MODE, FILE_MODE, clearShieldedDirectCache, retryingTransient } from '@kuiralabs/midnight-cli-core';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import * as ledger from '@midnightntwrk/ledger-v9';

import { deriveShieldedSeed } from './derivation.ts';
import { readShieldedBalanceDirect } from './shielded-direct.ts';
import { type LedgerVersion } from './fork-schedule.ts';
import {
  deserializeShieldedLedgerState, serializeShieldedLedgerState, shieldedKeysFromSeed, type ShieldedLedgerState,
} from './shielded-ledger-state.ts';
import { fetchEventTip, isCursorBeyondTip } from '@kuiralabs/midnight-chain';

// v2: ledger-9 states replace ledger-8 ones. Dev-preset localnets share a genesis
// hash, so the chain-id guard can't keep a ledger-8 cache off a ledger-9 chain.
// v3: `ledgerVersion` names the state's ledger: a chain that forked from ledger 8
// has a ledger-8 state until its sync passes the fork. Both ledgers serialize a
// zswap local state under the same `zswap-local-state` codec, so the bytes can't
// tell; the entry has to. Older entries are re-synced once.
const SHIELDED_CACHE_VERSION = 3;

interface ShieldedCacheFile {
  version: number;
  network: string;
  coinPublicKeyHex: string;
  lastAppliedEventId: number;
  /** Genesis block hash — invalidates the cache on chain reset. Optional for back-compat. */
  chainId?: string;
  timestamp: string;
  zswapState: string; // hex-encoded ZswapLocalState.serialize() of `ledgerVersion`
  /** The ledger whose library reads `zswapState`. */
  ledgerVersion: LedgerVersion;
}

export interface ShieldedCacheEntry {
  state: ShieldedLedgerState;
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
    if (parsed.ledgerVersion !== 8 && parsed.ledgerVersion !== 9) return null;
    if (expectedChainId && parsed.chainId && parsed.chainId !== expectedChainId) return null;

    const state = deserializeShieldedLedgerState(parsed.ledgerVersion, new Uint8Array(Buffer.from(parsed.zswapState, 'hex')));
    return { state, lastAppliedEventId: parsed.lastAppliedEventId };
  } catch {
    return null;
  }
}

/**
 * Serialize a zswap state + lastAppliedEventId to disk atomically.
 */
export function saveShieldedCache(
  network: string,
  pubkeyHex: string,
  state: ShieldedLedgerState,
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
    zswapState: Buffer.from(serializeShieldedLedgerState(state)).toString('hex'),
    ledgerVersion: state.ledgerVersion,
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


export type { ShieldedBalanceResult, ShieldedCachedOptions } from '@kuiralabs/midnight-cli-core/engine';

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
  const keys = shieldedKeysFromSeed(deriveShieldedSeed(seedBuffer));
  // The same key on both ledgers; the ledger-9 one names the cache entry.
  const pubkeyHex = keys.v9.coinPublicKey;

  // State resumed from another indexer's event ids would replay the wrong events.
  bindCachesToIndexer(network, indexerWS, options.root);
  // A connection that fails (an indexer that blinked) is retried after a
  // wait, from the checkpoint the failed read saved; one the indexer closed
  // mid-stream ends a window short, and the next window resumes from where it
  // stopped, while windows still move and the read's time lasts.
  const deadline = Date.now() + (options.timeoutMs ?? SHIELDED_READ_MS);
  let eventCount = 0;
  let fromCache: boolean | undefined;
  for (;;) {
    const timeoutMs = Math.max(1, deadline - Date.now());
    const read = await retryingTransient(() => readFromCheckpoint(keys, pubkeyHex, network, indexerWS, { ...options, timeoutMs }), { signal: options.signal });
    eventCount += read.eventCount;
    fromCache ??= read.fromCache;
    if (!read.partial || read.eventCount === 0 || Date.now() >= deadline) return { ...read, eventCount, fromCache };
  }
}

/** How long a shielded read may take in all, over however many windows, unless its caller says. */
const SHIELDED_READ_MS = 600_000;

/** One read of the shielded history, from the checkpoint on disk to the tip. */
async function readFromCheckpoint(keys: ReturnType<typeof shieldedKeysFromSeed>, pubkeyHex: string, network: string, indexerWS: string, options: ShieldedCachedOptions): Promise<ShieldedBalanceResult> {
  let cached = options.forceFresh ? null : loadShieldedCache(network, pubkeyHex, options.root, options.chainId);
  // A cursor past the chain's latest event: the chain was reset under the cache.
  if (cached && isCursorBeyondTip(cached.lastAppliedEventId, await fetchEventTip(indexerWS, 'zswap'))) {
    clearShieldedDirectCache(network, pubkeyHex, options.root);
    cached = null;
  }
  const startFromId = cached ? cached.lastAppliedEventId + 1 : 0;

  const result = await readShieldedBalanceDirect(keys, indexerWS, {
    initialState: cached?.state,
    startFromId,
    chainProtocolVersion: options.chainProtocolVersion,
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
  // new events arrived, leave the on-disk file untouched. A first sync that
  // applied nothing is kept only when it is complete (an empty zswap timeline):
  // cut short, its state is the tip's ledger 9 at cursor -1, while a forked
  // chain's timeline starts with ledger-8 events, which the next read would refuse.
  if (result.lastAppliedEventId >= 0) {
    saveShieldedCache(network, pubkeyHex, result.state, result.lastAppliedEventId, options.root, options.chainId);
  } else if (!cached && !result.partial) {
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
