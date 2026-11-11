// This build of mn speaks ledger 9 only. wallet-sdk 2.0 can't sync against a
// ledger-8 indexer (it retries forever), and mn's own readers decode ledger-9
// events. So check the chain's protocol version up front and fail with a
// clear message instead of hanging or failing on a deserialize error.

import { LEDGER_9_FORK_VERSION, type NetworkConfig, isEndpointError, throwIfCancelled } from '@kuiralabs/midnight-cli-core';
import { getChainGenesisHash } from './chain-id.ts';
import { queryIndexer } from './indexer-graphql.ts';

export class UnsupportedLedgerError extends Error {
  readonly code = 'UNSUPPORTED_LEDGER';
  constructor(network: string, protocolVersion: bigint) {
    super(
      `${network} is on ledger 8 (protocol version ${protocolVersion}), and mn supports ledger 9 only.\n` +
      `If it is a local stack, restart or upgrade it: midnight localnet down, then midnight localnet up, starts a ledger-9 one.`,
    );
    this.name = 'UnsupportedLedgerError';
  }
}

/**
 * Throw if the chain is below the ledger-9 fork. An unknown version (indexer
 * unreachable) passes: the real network error surfaces from the call itself.
 */
export function checkLedgerSupported(network: string, protocolVersion: bigint | null): void {
  if (protocolVersion !== null && protocolVersion < LEDGER_9_FORK_VERSION) {
    throw new UnsupportedLedgerError(network, protocolVersion);
  }
}

const PROBE_TIMEOUT_MS = 5_000;

/** The chain tip's protocol version from the indexer, or null if it can't be read. A cancelled call fails with CancelledError. */
export function fetchProtocolVersion(indexerHttpUrl: string, signal?: AbortSignal): Promise<bigint | null> {
  return fetchBlockProtocolVersion(indexerHttpUrl, '{ block { protocolVersion } }', signal);
}

/**
 * The protocol version of the chain's first block, or null if it can't be
 * read: the ledger a new wallet replays the chain's history with, as the
 * wallet SDK's chain-version probe asks it. Below the ledger-9 fork on a chain
 * that forked from ledger 8. Read once per indexer for the process. A
 * cancelled call fails with CancelledError.
 */
export async function fetchGenesisProtocolVersion(indexerHttpUrl: string, signal?: AbortSignal): Promise<bigint | null> {
  const known = GENESIS_VERSIONS.get(indexerHttpUrl);
  if (known !== undefined) return known;
  const version = await fetchBlockProtocolVersion(indexerHttpUrl, '{ block(offset: { height: 0 }) { protocolVersion } }', signal);
  // A chain's first block doesn't change: asked once per indexer for the process (the MCP server's included).
  if (version !== null) GENESIS_VERSIONS.set(indexerHttpUrl, version);
  return version;
}

/** The protocol version of each indexer's chain's first block, as read in this process. */
const GENESIS_VERSIONS = new Map<string, bigint>();

async function fetchBlockProtocolVersion(indexerHttpUrl: string, query: string, signal?: AbortSignal): Promise<bigint | null> {
  try {
    const data = await queryIndexer<{ block?: { protocolVersion?: number } }>(indexerHttpUrl, query, undefined, PROBE_TIMEOUT_MS, signal);
    const version = data.block?.protocolVersion;
    return typeof version === 'number' ? BigInt(version) : null;
  } catch (err) {
    throwIfCancelled(signal);
    // An endpoint that can't serve the request as configured (no Blockfrost
    // project id, one it refuses, a host that was shut down) says what to do.
    if (isEndpointError(err)) throw err;
    return null;
  }
}

/** Probe the network's indexer and throw UnsupportedLedgerError on a ledger-8 chain. `signal` cancels the probe. */
export async function assertLedgerSupported(
  networkName: string,
  network: NetworkConfig,
  fetchVersion: (indexerHttpUrl: string, signal?: AbortSignal) => Promise<bigint | null> = fetchProtocolVersion,
  signal?: AbortSignal,
): Promise<void> {
  checkLedgerSupported(networkName, await fetchVersion(network.indexer, signal));
}

/**
 * No ledger-9 stack answers at the configured endpoints: the user starts one
 * (`mn localnet up`) or points mn at one that runs.
 */
export class LocalStackUnreachableError extends Error {
  readonly code = 'LOCAL_STACK_UNREACHABLE';
  constructor(component: 'indexer' | 'node', url: string) {
    super(
      `No ledger-9 stack is reachable: the ${component} at ${url} did not answer.\n` +
      `Start a local ledger-9 stack with: midnight localnet up\n` +
      `Or point mn at a running one: midnight config set network undeployed, then midnight config set node / indexer-ws / proof-server <url>`,
    );
    this.name = 'LocalStackUnreachableError';
  }
}

export interface StackProbes {
  fetchVersion?: (indexerHttpUrl: string) => Promise<bigint | null>;
  fetchGenesis?: (nodeWsUrl: string) => Promise<string | null>;
}

/**
 * Require a running ledger-9 stack at the network's endpoints: the indexer
 * answers with a ledger-9 protocol version, and the node answers.
 */
export async function assertLedger9StackReachable(
  networkName: string,
  network: NetworkConfig,
  probes: StackProbes = {},
): Promise<void> {
  const version = await (probes.fetchVersion ?? fetchProtocolVersion)(network.indexer);
  if (version === null) throw new LocalStackUnreachableError('indexer', network.indexer);
  checkLedgerSupported(networkName, version);
  const genesis = await (probes.fetchGenesis ?? getChainGenesisHash)(network.node);
  if (genesis === null) throw new LocalStackUnreachableError('node', network.node);
}

type WalletKind = 'shielded' | 'unshielded' | 'dust';

/**
 * The wallets (shielded, unshielded, dust) still below the ledger-9 fork. The
 * facade reads a dApp's transaction at the lowest of the three versions, so
 * until this is empty it would read ledger-9 bytes as ledger 8 and refuse them.
 */
export function walletsBelowLedger9(versions: Readonly<Record<WalletKind, bigint>>): WalletKind[] {
  return (['shielded', 'unshielded', 'dust'] as const).filter((wallet) => versions[wallet] < LEDGER_9_FORK_VERSION);
}
