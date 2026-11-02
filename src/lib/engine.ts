// The Midnight SDK, behind one interface. Everything that touches an SDK set
// is an engine's; the rest of mn reaches it through the engine for its
// network, and names no SDK type. One engine today, for the SDK's release
// candidates (rc). The interface grows area by area as code moves behind it.
// Loading an engine loads its SDK, so the loader imports it only when asked.

import type { NetworkConfig, NetworkName } from './network.ts';

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
  /** Throws, saying why, unless `address` is a bech32m address of that kind on `network`. */
  assertAddress(address: string, kind: 'shielded' | 'unshielded', network: NetworkName): void;
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
  /** The raw id of the unshielded NIGHT token, as wallet balances are keyed. */
  nightTokenId(): string;
}

/** A contract's ledger state read without its compiled contract: cells as their field-aligned bytes in hex, maps by size. */
export type RawStateValue =
  | { type: 'null' }
  | { type: 'cell'; value: string[] }
  | { type: 'array'; items: RawStateValue[] }
  | { type: 'map'; size: number }
  | { type: 'boundedMerkleTree'; height: number; root: string[] | null };

/** What every SDK set's contract script shares, which the contract runner gives the engine. */
export interface ScriptParts {
  /** First in every script: reports a failure as one marked line. */
  readonly prelude: string;
  /** The client of mn serve's RPC on that port, defining rpcConnect, rpcCall and rpcClose. */
  rpcClientCode(servePort: number): string;
  /** Defines coerceArg, which turns a JSON argument into a circuit's runtime value. */
  readonly coerceArgFn: string;
  /** Defines resolvePrivateStateSecretKey. */
  readonly privateStateSecretFn: string;
  /** Where the dApp's witnesses may be, relative to its folder. */
  readonly witnessCandidates: readonly string[];
  /** The environment variables carrying the indexer's URLs, which never go into a script's text. */
  readonly indexerUrlEnv: string;
  readonly indexerWsUrlEnv: string;
}

/** A compiled contract, as the scripts load it. */
export interface ScriptContract {
  networkConfig: NetworkConfig;
  managedDir: string;
  contractName: string;
}

export interface DeployScript extends ScriptContract {
  servePort: number;
  privateStateKey?: string;
  args?: unknown[];
}

export interface CallScript extends ScriptContract {
  servePort: number;
  contractAddress: string;
  circuit: string;
  args?: unknown[];
  privateStateKey?: string;
}

export interface StateScript extends ScriptContract {
  contractAddress: string;
}

/** The scripts mn runs in a dApp's folder, and the packages they import, for one SDK set. */
export interface EngineContractScripts {
  /** Every package a script imports, and the compact runtime a compiled contract imports. */
  readonly packages: readonly string[];
  /** The folder of one of them as this engine's install has it; null when it isn't installed. */
  packageFolder(name: string): string | null;
  deploy(script: DeployScript, parts: ScriptParts): string;
  call(script: CallScript, parts: ScriptParts): string;
  state(script: StateScript, parts: ScriptParts): string;
}

/** What an engine does with contracts in mn's own process. */
export interface EngineContracts {
  /** A deployed contract's raw ledger state from the indexer; null when no contract is at `address`. */
  rawState(networkConfig: NetworkConfig, address: string): Promise<RawStateValue | null>;
  /** Whether midnight-js accepts a private-state password (its own policy, which a random draw can miss). */
  acceptsPrivateStatePassword(password: string): boolean;
  /** The scripts the contract runner runs in a dApp's folder. */
  readonly scripts: EngineContractScripts;
}

/** A wallet's shielded NIGHT, from mn's own reader of the indexer's events. */
export interface ShieldedBalanceResult {
  /** Native (NIGHT) shielded balance in atomic units. */
  balance: bigint;
  /** Number of spendable NIGHT coins. */
  availableCoins: number;
  /** Events applied in this run (delta since last cache save). */
  eventCount: number;
  /** Latest event id in the saved cache (carried from prior cache if no new events). */
  lastAppliedEventId: number;
  /** True if an existing cache was loaded and extended; false if synced from scratch. */
  fromCache: boolean;
  /** True if the sync stopped before catching up (timeout/abort) — resume next call. */
  partial: boolean;
}

export interface ShieldedCachedOptions {
  /** Called with (eventsApplied, maxIdSeen) whenever a new event arrives. */
  onProgress?: (eventsApplied: number, maxIdSeen: number) => void;
  /** Stops the read; what was applied is kept for the next. */
  signal?: AbortSignal;
  /** Soft ceiling for the whole read, after which it returns what it has (partial). */
  timeoutMs?: number;
  /** Ignore any cached state and re-sync from the beginning (honours --no-cache). */
  forceFresh?: boolean;
  /** Current chain genesis hash — stored on save and checked on load (chain-reset guard). */
  chainId?: string;
}

/** mn's own readers of a wallet's chain state, beside the SDK's wallet. */
export interface EngineReaders {
  /** The shielded NIGHT balance of a seed on a network, reading (and extending) its cache. */
  shieldedBalance(seed: Buffer, network: NetworkName, indexerWS: string, options?: ShieldedCachedOptions): Promise<ShieldedBalanceResult>;
}

/** One SDK set, as mn uses it. */
export interface Engine {
  readonly set: SdkSet;
  readonly keys: EngineKeys;
  readonly ledger: EngineLedger;
  readonly contracts: EngineContracts;
  readonly readers: EngineReaders;
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
