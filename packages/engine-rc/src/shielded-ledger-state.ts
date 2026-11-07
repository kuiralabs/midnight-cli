// A shielded (zswap) local state of either ledger the rc engine reads, and the
// crossing between them.
//
// A chain that forked from ledger 8 to ledger 9 (mainnet, Preview) serves its
// pre-fork zswap events in ledger-8 format and the rest in ledger-9 format. The
// wallet SDK's shielded wallet folds the first with a ledger-8 state and
// migrates to a ledger-9 one at the fork; the direct reader does the same with
// the functions here.
//
// Pure logic: no I/O.

import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import { type LedgerVersion } from './fork-schedule.ts';

/** A zswap local state, tagged with the ledger whose library reads it. */
export type ShieldedLedgerState =
  | { readonly ledgerVersion: 8; readonly state: ledgerV8.ZswapLocalState }
  | { readonly ledgerVersion: 9; readonly state: ledgerV9.ZswapLocalState };

/** One wallet's zswap secret keys in each ledger's library (both from the same seed). */
export interface ShieldedKeys {
  readonly v8: ledgerV8.ZswapSecretKeys;
  readonly v9: ledgerV9.ZswapSecretKeys;
}

/** A wallet's zswap secret keys for both ledgers, from its derived shielded seed. */
export function shieldedKeysFromSeed(shieldedSeed: Uint8Array): ShieldedKeys {
  return { v8: ledgerV8.ZswapSecretKeys.fromSeed(shieldedSeed), v9: ledgerV9.ZswapSecretKeys.fromSeed(shieldedSeed) };
}

/** An empty zswap state of `ledger`. */
export function emptyShieldedLedgerState(ledger: LedgerVersion): ShieldedLedgerState {
  return ledger === 8
    ? { ledgerVersion: 8, state: new ledgerV8.ZswapLocalState() }
    : { ledgerVersion: 9, state: new ledgerV9.ZswapLocalState() };
}

/**
 * The ledger-9 state a ledger-8 wallet continues with after the fork, as the
 * SDK's cross-ledger migration makes it (`Migration.makeCrossLedgerMigration`
 * in the wallet SDK's shielded v2 variant): the whole state, read back from its
 * ledger-8 bytes. Unlike Dust, nothing is reset: the chain keeps the commitment
 * tree in place across the fork and the indexer does not re-emit the ledger-8
 * zswap events, so the coins, their tree indices and the tree's frontier must
 * cross with the state. Both ledgers serialize it under the same
 * `zswap-local-state` codec.
 *
 * The SDK's first sync update after the crossing (`CoreWallet.completeCrossing`)
 * also releases the pending spends the state crossed with. A state this reader
 * builds holds none: it only replays events, and only `spend` books one.
 */
export function crossShieldedToLedger9(state: ShieldedLedgerState): ShieldedLedgerState {
  if (state.ledgerVersion === 9) return state;
  return { ledgerVersion: 9, state: ledgerV9.ZswapLocalState.deserialize(state.state.serialize()) };
}

/** A zswap state's bytes, as its ledger serializes it. */
export function serializeShieldedLedgerState(state: ShieldedLedgerState): Uint8Array {
  return state.state.serialize();
}

/** A zswap state of `ledger` from its bytes. Throws when the bytes are not a state of that ledger. */
export function deserializeShieldedLedgerState(ledger: LedgerVersion, bytes: Uint8Array): ShieldedLedgerState {
  return ledger === 8
    ? { ledgerVersion: 8, state: ledgerV8.ZswapLocalState.deserialize(bytes) }
    : { ledgerVersion: 9, state: ledgerV9.ZswapLocalState.deserialize(bytes) };
}
