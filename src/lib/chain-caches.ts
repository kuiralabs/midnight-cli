// The caches the wallet keeps for a chain, cleared together: when that chain
// is reset (`localnet down` removes the local chain's volumes) every cache
// still referring to it is stale and would fail the next command, and
// `cache clear` clears the same set.

import { clearWalletCache } from '@kuiralabs/midnight-cli-core/lib/wallet-cache';
import { clearDustDirectCache } from '@kuiralabs/midnight-cli-core/lib/reader-cache-files';
import { clearShieldedDirectCache } from '@kuiralabs/midnight-cli-core/lib/reader-cache-files';
import { clearNativeDustCheckpoint } from '@kuiralabs/midnight-cli-core/lib/reader-cache-files';

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
