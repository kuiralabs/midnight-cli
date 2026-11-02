// The caches the wallet keeps for a chain, cleared together: when that chain
// is reset (`localnet down` removes the local chain's volumes) every cache
// still referring to it is stale and would fail the next command, and
// `cache clear` clears the same set.

import { clearWalletCache } from './wallet-cache.ts';
import { clearDustDirectCache } from './reader-cache-files.ts';
import { clearShieldedDirectCache } from './reader-cache-files.ts';
import { clearNativeDustCheckpoint } from './reader-cache-files.ts';

/**
 * Clears every wallet cache kept for `network` (all networks when undefined):
 * the wallet sync caches, the direct Dust and shielded caches, and the native
 * sidecar's Dust checkpoints.
 */
export function clearChainCaches(network: string | undefined, cacheDir?: string): void {
  clearWalletCache(undefined, network, cacheDir);
  clearDustDirectCache(network, undefined, cacheDir);
  clearShieldedDirectCache(network, undefined, cacheDir);
  clearNativeDustCheckpoint(network, undefined, cacheDir);
}
