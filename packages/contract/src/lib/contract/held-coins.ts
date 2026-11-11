// The coins a contract holds for the wallet that gave them, kept where that
// wallet's witnesses can read them: the contract's private state.
//
// A contract that keeps custody of a shielded coin privately (it receives the
// coin and stores only a commitment to it, as the shielded-chips escrow does)
// can spend it later only from a witness, which must return the coin with its
// Merkle tree index (`QualifiedShieldedCoinInfo`). Only the depositor knows the
// coin, and the index is known only once the deposit lands. So after a call
// whose circuit takes a `ShieldedCoinInfo` argument, the call script finds the
// output the transaction made for the contract from that coin (by its
// commitment), reads the transaction's first Zswap tree index from the
// indexer, and records the coin under HELD_COINS_KEY in the contract's private
// state, keyed by its nonce in hex:
//
//   privateState.mnHeldCoins["<nonce hex>"] = { nonce, color, value, mt_index }
//
// (Uint8Array, Uint8Array, bigint, bigint: a QualifiedShieldedCoinInfo as a
// witness returns it). A witness reads it as
//
//   held_coin: ({ privateState }, nonce) =>
//     [privateState, privateState.mnHeldCoins[Buffer.from(nonce).toString('hex')]]
//
// The record is added to the private state the call left (a plain object).
// mn seeds each call's private state afresh (createPrivateState with the
// wallet's secret or --secret-key) and carries HELD_COINS_KEY over from the
// stored state into it, so the record stays until a witness returns a private
// state without it.

import type { ContractInfo, CompactType } from './inspect.ts';

/** The private-state key the coins a contract holds for the wallet are recorded under. */
export const HELD_COINS_KEY = 'mnHeldCoins';

/** A coin the call gave the contract, as the call script recorded it: all of it public on chain. */
export interface HeldCoin {
  /** The circuit argument the coin was. */
  argument: string;
  /** The commitment of the output the transaction made for the contract (hex). */
  commitment: string;
  /** Its index in the Zswap Merkle tree, as a decimal string. */
  mtIndex: string;
}

/** A circuit argument a call script looks for a held coin from: its place among the arguments and its name. */
export interface HeldCoinArgument {
  index: number;
  name: string;
}

/** Whether `type` is Compact's ShieldedCoinInfo, the coin a circuit receives. */
export function isShieldedCoinInfo(type: CompactType | undefined): boolean {
  return type?.['type-name'] === 'Struct' && type.name === 'ShieldedCoinInfo';
}

/** The arguments of `circuit` that are a ShieldedCoinInfo: the coins a call of it may give the contract. */
export function heldCoinArgumentsOf(info: Pick<ContractInfo, 'circuits'>, circuit: string): HeldCoinArgument[] {
  const found = info.circuits.find((c) => c.name === circuit);
  if (found === undefined) return [];
  return found.arguments.flatMap((argument, index) => (isShieldedCoinInfo(argument.type) ? [{ index, name: argument.name }] : []));
}
