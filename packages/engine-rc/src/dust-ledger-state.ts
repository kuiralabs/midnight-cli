// A Dust local state of either ledger the rc engine reads, and the crossing
// between them.
//
// A chain that forked from ledger 8 to ledger 9 (mainnet, Preview) serves its
// pre-fork Dust events in ledger-8 format and the rest in ledger-9 format. The
// wallet SDK's forking Dust wallet folds the first with a ledger-8 state and
// migrates to a ledger-9 one at the fork; the direct reader does the same with
// the functions here, deciding each event's ledger the way the SDK does.
//
// Pure logic: no I/O.

import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import { dustVariantConfigurations } from '@midnightntwrk/wallet-sdk/dust';
import { CoreWallet as V2CoreWallet } from '@midnightntwrk/wallet-sdk/dust/v2';
import { INITIAL_NIGHT_DUST_RATIO, INITIAL_GENERATION_DECAY_RATE, INITIAL_DUST_GRACE_PERIOD_SECONDS } from '@kuiralabs/midnight-cli-core/engine';
import { FORK_SCHEDULE } from './fork-schedule.ts';

/** The ledger a Dust state or event belongs to. */
export type DustLedger = 8 | 9;

/** A Dust local state, tagged with the ledger whose library reads it. */
export type DustLedgerState =
  | { readonly ledgerVersion: 8; readonly state: ledgerV8.DustLocalState }
  | { readonly ledgerVersion: 9; readonly state: ledgerV9.DustLocalState };

/** One wallet's Dust secret key in each ledger's library (both from the same seed). */
export interface DustKeys {
  readonly v8: ledgerV8.DustSecretKey;
  readonly v9: ledgerV9.DustSecretKey;
}

/** A wallet's Dust secret keys for both ledgers, from its derived Dust seed. */
export function dustKeysFromSeed(dustSeed: Uint8Array): DustKeys {
  return { v8: ledgerV8.DustSecretKey.fromSeed(dustSeed), v9: ledgerV9.DustSecretKey.fromSeed(dustSeed) };
}

/**
 * The ledger of a protocol version, by the fork schedule the facade's Dust
 * wallet runs on: ledger 8 below `forks.v9`, ledger 9 from it. The SDK's
 * ledger-8 variant owns exactly that range, and hands over at the first event
 * (or chain tip) reported at or above it.
 */
export function ledgerOfProtocolVersion(protocolVersion: bigint | number): DustLedger {
  return BigInt(protocolVersion) < FORK_SCHEDULE.v9 ? 8 : 9;
}

/** An empty Dust state of `ledger`, on the ledger's initial Dust parameters. */
export function emptyDustLedgerState(ledger: DustLedger): DustLedgerState {
  if (ledger === 8) {
    const params = new ledgerV8.DustParameters(INITIAL_NIGHT_DUST_RATIO, INITIAL_GENERATION_DECAY_RATE, INITIAL_DUST_GRACE_PERIOD_SECONDS);
    return { ledgerVersion: 8, state: new ledgerV8.DustLocalState(params) };
  }
  const params = new ledgerV9.DustParameters(INITIAL_NIGHT_DUST_RATIO, INITIAL_GENERATION_DECAY_RATE, INITIAL_DUST_GRACE_PERIOD_SECONDS);
  return { ledgerVersion: 9, state: new ledgerV9.DustLocalState(params) };
}

/** What a ledger-8 wallet carries across the fork. */
export interface DustCrossing {
  /** The wallet's Dust public key (the same on both ledgers). */
  readonly publicKey: bigint;
  /** The network id the wallet is on. */
  readonly networkId: string;
  /** The protocol version that signalled the fork: the first ledger-9 event's, or the chain tip's. */
  readonly protocolVersion: bigint;
  /** The id of the last ledger-8 event folded in, or -1 for none. */
  readonly lastAppliedEventId: number;
}

/**
 * The ledger-9 Dust state a ledger-8 wallet continues with after the fork, as
 * the SDK's cross-ledger migration makes it (`Migration.makeCrossLedgerMigration`
 * in the wallet SDK's Dust v2 variant, which builds it with
 * `CoreWallet.fromPreviousVersion`). It carries no Dust: the indexer re-emits
 * the live Dust generations as ledger-9 events after the fork, so the state is
 * an empty one on the parameters the facade's Dust wallet values the crossing
 * with (`dustVariantConfigurations`; mn configures no rates, so the ledger's
 * initial ones). The wallet's network and position are the facade's; the
 * reader keeps only the state.
 */
export function crossToLedger9(crossing: DustCrossing): DustLedgerState {
  const { v2 } = dustVariantConfigurations({});
  const appliedIndex = BigInt(Math.max(crossing.lastAppliedEventId, 0));
  const wallet = V2CoreWallet.fromPreviousVersion({
    publicKey: { publicKey: crossing.publicKey },
    networkId: crossing.networkId,
    protocolVersion: crossing.protocolVersion,
    progress: { appliedIndex, highestRelevantWalletIndex: appliedIndex, highestIndex: appliedIndex, highestRelevantIndex: appliedIndex, isConnected: false },
    dustParameters: v2.dustParameters,
  });
  return { ledgerVersion: 9, state: wallet.state };
}

/** A Dust state's bytes, as its ledger serializes it. */
export function serializeDustLedgerState(state: DustLedgerState): Uint8Array {
  return state.state.serialize();
}

/** A Dust state of `ledger` from its bytes. Throws when the bytes are not a state of that ledger. */
export function deserializeDustLedgerState(ledger: DustLedger, bytes: Uint8Array): DustLedgerState {
  return ledger === 8
    ? { ledgerVersion: 8, state: ledgerV8.DustLocalState.deserialize(bytes) }
    : { ledgerVersion: 9, state: ledgerV9.DustLocalState.deserialize(bytes) };
}

/** The state with its expired pending spends dropped at `now` (`processTtls`), on its own ledger. */
export function processDustTtls(state: DustLedgerState, now: Date): DustLedgerState {
  return state.ledgerVersion === 8
    ? { ledgerVersion: 8, state: state.state.processTtls(now) }
    : { ledgerVersion: 9, state: state.state.processTtls(now) };
}
