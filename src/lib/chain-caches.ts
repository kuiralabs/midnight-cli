// The caches the wallet keeps for a chain, cleared together when that chain
// is reset (`localnet down` removes the local chain's volumes): a cache that
// still refers to it is stale and would fail the next command.

import { clearWalletCache } from './wallet-cache.ts';
import { clearDustDirectCache } from './dust-direct-cache.ts';

/** Clears every wallet cache kept for `network`: the wallet sync caches and the direct Dust caches. */
export function clearChainCaches(network: string, cacheDir?: string): void {
  clearWalletCache(undefined, network, cacheDir);
  clearDustDirectCache(network, undefined, cacheDir);
}
