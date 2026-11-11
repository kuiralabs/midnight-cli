// The facade's shielded wallet, started on the direct shielded reader's
// ledger-9 checkpoint (shielded-direct-cache.ts) when the SDK would start it on
// ledger 8.
//
// A new wallet on a chain that forked from ledger 8 (preprod, Preview, mainnet)
// starts its shielded wallet on ledger 8: the SDK asks the chain's first block
// which ledger can read the history it is about to replay. Until that wallet has
// replayed every zswap event up to the fork it stays below it, and the facade
// acts at the lowest version of its three wallets: a transaction the unshielded
// and Dust wallets build on ledger 9 is refused ("built for protocol version
// 2000000 ... The caller acts at protocol versions 0 up to 2000000"). On
// Preview (17,000 zswap event ids) the replay takes seconds; on preprod (127,000
// events up to id 1.86 million) the wallet was still at the genesis version a
// minute in. The direct reader replays the same events and crosses to ledger 9
// as the SDK's wallet does (216 s cold on preprod, once; resumed after); its
// state goes into a new ledger-9 wallet's snapshot, as Dust's checkpoint does
// (facade.ts, overlayDustDirectSnapshot).
//
// Pure logic: no I/O.

import * as ledger from '@midnightntwrk/ledger-v9';
import { FORK_SCHEDULE, ledgerOfProtocolVersion, type LedgerVersion } from './fork-schedule.ts';
import type { ShieldedLedgerState } from './shielded-ledger-state.ts';

/**
 * The fields mn reads and writes of the SDK's serialized shielded wallet (its
 * V2 `SnapshotSchema`: JSON, bigints as decimal strings). `state` is the hex of
 * a ledger-9 `ZswapLocalState.serialize()`; `coinHashes` holds a commitment and
 * a nullifier for every coin of that state, by nonce, which the SDK checks on
 * restore. Other fields are kept as they are.
 */
export interface FacadeShieldedSnapshot {
  protocolVersion: string;
  state: string;
  offset?: string;
  coinHashes: Record<string, { commitment: string; nullifier: string }>;
  [field: string]: unknown;
}

/** A direct reader's checkpoint: its zswap state and the last event it applied. */
export interface ShieldedCheckpoint {
  state: ShieldedLedgerState;
  lastAppliedEventId: number;
}

/** A checkpoint past the fork: a ledger-9 state, read to an event. */
export interface Ledger9ShieldedCheckpoint {
  state: { readonly ledgerVersion: 9; readonly state: ledger.ZswapLocalState };
  lastAppliedEventId: number;
}

/** The ledger a serialized shielded wallet restores onto: the one its protocol version falls in. */
export function shieldedSnapshotLedger(snapshotJson: string): LedgerVersion {
  return ledgerOfProtocolVersion(BigInt((JSON.parse(snapshotJson) as FacadeShieldedSnapshot).protocolVersion));
}

/**
 * The checkpoint a shielded wallet on `walletLedger` starts on instead: the
 * direct reader's, when the wallet is still on ledger 8 and the reader has
 * crossed to ledger 9. Null otherwise, and the wallet runs as it is: a wallet
 * on ledger 9 already syncs from its own position, and a ledger-8 checkpoint
 * would not lift it past the fork.
 */
export function checkpointPastFork(walletLedger: LedgerVersion, checkpoint: ShieldedCheckpoint | null): Ledger9ShieldedCheckpoint | null {
  if (walletLedger === 9 || checkpoint === null || checkpoint.lastAppliedEventId < 0) return null;
  const { state, lastAppliedEventId } = checkpoint;
  return state.ledgerVersion === 9 ? { state, lastAppliedEventId } : null;
}

/**
 * Every coin of `state` (held, and received by a transaction still pending),
 * with its commitment and nullifier under the wallet's keys, as the SDK's
 * `CoinHashesMap.init` computes them for the state of a wallet it restores.
 */
function coinHashesOf(state: ledger.ZswapLocalState, shieldedSeed: Uint8Array): FacadeShieldedSnapshot['coinHashes'] {
  // A key the ledger hands out is cleared with the keys it came from, so the
  // keys live for this call only.
  const keys = ledger.ZswapSecretKeys.fromSeed(shieldedSeed);
  try {
    const coins = [...state.coins, ...[...state.pendingOutputs.values()].map(([coin]) => coin)];
    const hashes: FacadeShieldedSnapshot['coinHashes'] = {};
    for (const coin of coins) {
      hashes[coin.nonce] = { commitment: ledger.coinCommitment(coin, keys.coinPublicKey), nullifier: ledger.coinNullifier(coin, keys.coinSecretKey) };
    }
    return hashes;
  } finally {
    keys.clear();
  }
}

/**
 * A serialized ledger-9 shielded wallet (a new one's) with the checkpoint's
 * state in it: the state, its coins' hashes, and the offset set to the
 * checkpoint's last applied event (the wallet resumes after it). The rest of
 * the snapshot is kept. Refused when the snapshot is not on ledger 9.
 */
export function overlayShieldedCheckpoint(snapshotJson: string, checkpoint: Ledger9ShieldedCheckpoint, shieldedSeed: Uint8Array): string {
  const snapshot = JSON.parse(snapshotJson) as FacadeShieldedSnapshot;
  if (ledgerOfProtocolVersion(BigInt(snapshot.protocolVersion)) !== 9) {
    throw new Error(`Can't put a ledger-9 shielded state into a snapshot at protocol version ${snapshot.protocolVersion}: the wallet would read it as ledger 8 (fork at ${FORK_SCHEDULE.v9}).`);
  }
  snapshot.state = Buffer.from(checkpoint.state.state.serialize()).toString('hex');
  snapshot.offset = checkpoint.lastAppliedEventId.toString();
  snapshot.coinHashes = coinHashesOf(checkpoint.state.state, shieldedSeed);
  return JSON.stringify(snapshot);
}
