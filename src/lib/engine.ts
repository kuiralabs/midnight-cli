// The Midnight SDK, behind one interface. Everything that touches an SDK set
// is an engine's; the rest of mn reaches it through the engine for its
// network, and names no SDK type. One engine today, for the SDK's release
// candidates (rc). The interface grows area by area as code moves behind it.
// Loading an engine loads its SDK, so the loader imports it only when asked.

import type { NetworkName } from './network.ts';

/** An SDK set mn runs on. */
export type SdkSet = 'rc';

/** A wallet's keys and addresses, derived from its seed. Every set derives the same ones. */
export interface EngineKeys {
  /** The unshielded address of the seed's key at `keyIndex` (default 0) on a network. */
  unshieldedAddress(seed: Buffer, network: NetworkName, keyIndex?: number): string;
  /** The first unshielded address on every network. */
  unshieldedAddresses(seed: Buffer, keyIndex?: number): Record<NetworkName, string>;
  /** The shielded address on a network. */
  shieldedAddress(seed: Buffer, network: NetworkName): string;
  /** The shielded address on every network. */
  shieldedAddresses(seed: Buffer): Record<NetworkName, string>;
  /** The Dust public key, hex: what the Dust reader's cache is named by. */
  dustPublicKeyHex(seed: Buffer): string;
  /** The shielded coin public key, hex: what the shielded reader's cache is named by. */
  shieldedCoinPublicKeyHex(seed: Buffer): string;
}

/** A line of what a transaction is, as an approval prompt shows it. */
export interface TransactionDetail {
  label: string;
  value: string;
}

/** A chain's block limits: time in picoseconds, the rest in bytes. */
export interface BlockLimits {
  readTime: number;
  computeTime: number;
  blockUsage: number;
  bytesWritten: number;
  bytesChurned: number;
}

/** What an engine reads from the ledger's serialized values. */
export interface EngineLedger {
  /** The block limits in serialized ledger parameters (hex), as the indexer serves them. Throws when the bytes aren't this set's ledger parameters. */
  blockLimits(parametersHex: string): BlockLimits;
}

/** One SDK set, as mn uses it. */
export interface Engine {
  readonly set: SdkSet;
  readonly keys: EngineKeys;
  readonly ledger: EngineLedger;
}

/** The SDK set a network runs on. */
export function sdkSetOf(_network: NetworkName): SdkSet {
  return 'rc';
}

// The engine this process has loaded: one per process, since two SDK sets'
// WASM ledgers can't share one.
let loaded: Promise<Engine> | undefined;

function loadEngine(set: SdkSet): Promise<Engine> {
  loaded ??= import('../engine/rc/index.ts').then((module) => module.rcEngine);
  return loaded.then((engine) => {
    if (engine.set !== set) throw new Error(`This process runs the ${engine.set} SDK set and can't load the ${set} one`);
    return engine;
  });
}

/** The engine for a network's SDK set, loaded on first use. */
export function engineFor(network: NetworkName): Promise<Engine> {
  return loadEngine(sdkSetOf(network));
}

/**
 * An engine for work every set does alike, such as deriving addresses: the
 * one this process has loaded, else the rc set's.
 */
export function anyEngine(): Promise<Engine> {
  return loaded ?? loadEngine('rc');
}
