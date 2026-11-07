// Shielded-sync policy. Shielded (zswap) sync is the slow part of a wallet's
// first read on the hosted test networks (preview, preprod, stagenet), so it is
// off there by default: those networks have no shielded faucet, and most
// wallets hold nothing shielded. A wallet can still hold shielded tokens there
// (contracts mint them), so `--force-shielded` reads them, and what is skipped
// is said so, never shown as nothing held. `undeployed` (localnet genesis) and
// any future funded network keep shielded on.

import type { NetworkName } from './network.ts';

/** The networks with no shielded faucet, where shielded sync is off by default. */
const NO_SHIELDED_FAUCET: readonly NetworkName[] = ['preview', 'preprod', 'stagenet'];

/** True when shielded is synced on this network by default. */
export function networkHasShielded(network: NetworkName): boolean {
  return !NO_SHIELDED_FAUCET.includes(network);
}

/**
 * Whether to sync/allow shielded for this run. Off by default on faucet-less
 * networks; `force` (the `--force-shielded` flag) re-enables it.
 */
export function shieldedSyncEnabled(network: NetworkName, force = false): boolean {
  return networkHasShielded(network) || force;
}

/** One-line reason shown when the shielded wallet is not read, or a shielded transfer refused, by default. */
export function shieldedDisabledReason(network: NetworkName): string {
  return `Shielded is not read on ${network} by default (its first read takes a while), though a wallet can hold shielded tokens there. Pass --force-shielded to read it.`;
}
