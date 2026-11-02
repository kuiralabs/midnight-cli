// Where the Dust and shielded readers keep their caches under the state root,
// and how they are cleared. Plain files, named by network and public key, so
// clearing them needs no SDK: the engine that reads and writes them does.

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cacheKeyOf, cacheRootDir, networkCacheFolder } from './wallet-cache.ts';

/** The folder of a network's reader caches. */
export function dustCacheDir(network: string, cacheDir?: string): string {
  const base = cacheRootDir(cacheDir);
  return join(base, networkCacheFolder(network));
}

/** The Dust reader's cache file for a network and Dust public key. */
export function getDustCachePath(
  network: string,
  pubkeyHex: string,
  cacheDir?: string,
): string {
  const prefix = cacheKeyOf(pubkeyHex);
  return join(dustCacheDir(network, cacheDir), `dust-${prefix}.json`);
}

/**
 * Remove dust-direct cache files. Scope:
 *  - (network, pubkeyHex) → single file
 *  - (network)            → all dust-* files in that network dir
 *  - (neither)            → all dust-* files across all networks
 */
export function clearDustDirectCache(
  network?: string,
  pubkeyHex?: string,
  cacheDir?: string,
): void {
  const base = cacheRootDir(cacheDir);

  if (network && pubkeyHex) {
    const path = getDustCachePath(network, pubkeyHex, cacheDir);
    try { unlinkSync(path); } catch { /* not found is ok */ }
    return;
  }

  const wipeNetworkDir = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir)) {
        if (file.startsWith('dust-') && file.endsWith('.json')) {
          try { unlinkSync(join(dir, file)); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort */ }
  };

  if (network) {
    wipeNetworkDir(dustCacheDir(network, cacheDir));
    return;
  }

  if (!existsSync(base)) return;
  try {
    for (const net of readdirSync(base)) {
      wipeNetworkDir(join(base, net));
    }
  } catch { /* best-effort */ }
}

function shieldedCacheDir(network: string, cacheDir?: string): string {
  const base = cacheRootDir(cacheDir);
  return join(base, networkCacheFolder(network));
}

/** The shielded reader's cache file for a network and coin public key. */
export function getShieldedCachePath(
  network: string,
  pubkeyHex: string,
  cacheDir?: string,
): string {
  const prefix = cacheKeyOf(pubkeyHex);
  return join(shieldedCacheDir(network, cacheDir), `shielded-${prefix}.json`);
}

/**
 * Remove shielded-direct cache files. Scope:
 *  - (network, pubkeyHex) → single file
 *  - (network)            → all shielded-* files in that network dir
 *  - (neither)            → all shielded-* files across all networks
 */
export function clearShieldedDirectCache(
  network?: string,
  pubkeyHex?: string,
  cacheDir?: string,
): void {
  const base = cacheRootDir(cacheDir);

  if (network && pubkeyHex) {
    const path = getShieldedCachePath(network, pubkeyHex, cacheDir);
    try { unlinkSync(path); } catch { /* not found is ok */ }
    return;
  }

  const wipeNetworkDir = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir)) {
        if (file.startsWith('shielded-') && file.endsWith('.json')) {
          try { unlinkSync(join(dir, file)); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort */ }
  };

  if (network) {
    wipeNetworkDir(shieldedCacheDir(network, cacheDir));
    return;
  }

  if (!existsSync(base)) return;
  try {
    for (const net of readdirSync(base)) {
      wipeNetworkDir(join(base, net));
    }
  } catch { /* best-effort */ }
}

/** The native sidecar's checkpoint file for a Dust public key. */
export const nativeCheckpointName = (pubkeyHex: string): string => `dust-native-${cacheKeyOf(pubkeyHex)}.json`;

/**
 * Remove native-sidecar checkpoint files (`dust-native-*.json`). Scope mirrors
 * `clearDustDirectCache`: (network, pubkey) → one file; (network) → that network;
 * (neither) → all. Called from `mn cache clear` so clearing the cache also forces
 * a fresh native sync (and drops a stale checkpoint after a chain reset).
 */
export function clearNativeDustCheckpoint(network?: string, pubkeyHex?: string, cacheDir?: string): void {
  const base = cacheRootDir(cacheDir);
  if (network && pubkeyHex) {
    try { unlinkSync(join(base, networkCacheFolder(network), nativeCheckpointName(pubkeyHex))); } catch { /* not found is ok */ }
    return;
  }
  const wipeDir = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('dust-native-') && f.endsWith('.json')) {
          try { unlinkSync(join(dir, f)); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort */ }
  };
  if (network) { wipeDir(join(base, networkCacheFolder(network))); return; }
  if (!existsSync(base)) return;
  try { for (const net of readdirSync(base)) wipeDir(join(base, net)); } catch { /* best-effort */ }
}
