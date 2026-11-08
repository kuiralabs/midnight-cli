import { blockfrostEndpoints, usesBlockfrost } from './blockfrost.ts';
import { execSync } from 'child_process';
import { loadCliConfig, getEndpointOverridesForNetwork } from './cli-config.ts';
import { INDEXER_GRAPHQL_PATH, INDEXER_GRAPHQL_WS_PATH } from './constants.ts';
import type { Settings } from './settings.ts';
import { UsageError } from './errors.ts';

export type NetworkName = 'mainnet' | 'preprod' | 'preview' | 'undeployed';

/**
 * The protocol version ledger 9 starts at on the chains this build targets:
 * chains born on ledger 9 (the localnet reports 2001000). A plain number, so
 * the base and the ledger guard need no SDK; the wallet passes the SDK's own
 * schedule to the facade (`fork-schedule.ts`), and a test keeps the two equal.
 */
export const LEDGER_9_FORK_VERSION = 2_000_000n;

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  networkId: string;
}

const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  // Served only by Blockfrost. No faucet. These carry no project id:
  // `resolveNetworkConfig` adds it.
  mainnet: {
    ...blockfrostEndpoints('mainnet', undefined),
    proofServer: 'http://localhost:6300',
    networkId: 'MainNet',
  },
  // Served by Blockfrost since Midnight shut its own preprod indexer down
  // (2026-10-09). These carry no project id: `resolveNetworkConfig` adds it.
  preprod: {
    ...blockfrostEndpoints('preprod', undefined),
    proofServer: 'http://localhost:6300',
    networkId: 'PreProd',
  },
  preview: {
    indexer: `https://indexer.preview.midnight.network${INDEXER_GRAPHQL_PATH}`,
    indexerWS: `wss://indexer.preview.midnight.network${INDEXER_GRAPHQL_WS_PATH}`,
    node: 'wss://rpc.preview.midnight.network',
    proofServer: 'http://localhost:6300',
    networkId: 'Preview',
  },
  undeployed: {
    indexer: `http://localhost:8088${INDEXER_GRAPHQL_PATH}`,
    indexerWS: `ws://localhost:8088${INDEXER_GRAPHQL_WS_PATH}`,
    node: 'ws://localhost:9944',
    proofServer: 'http://localhost:6300',
    networkId: 'Undeployed',
  },
};

const VALID_NETWORK_NAMES: readonly NetworkName[] = ['mainnet', 'preprod', 'preview', 'undeployed'] as const;

/** Networks an earlier mn ran on and this one no longer does: named, they are refused with that said, not as unknown. */
const RETIRED_NETWORK_NAMES: readonly string[] = ['stagenet'];

/** Whether `name` is a network an earlier mn ran on and this one no longer does. */
export function isRetiredNetworkName(name: string): boolean {
  return RETIRED_NETWORK_NAMES.includes(name);
}

/** A network an earlier mn ran on and this one no longer does, given on a command or saved in the config. `asked` says where it came from. */
export class RetiredNetworkError extends UsageError {
  constructor(name: string, asked: string) {
    const savable = VALID_NETWORK_NAMES.filter((network) => !NAMED_ONLY_NETWORKS.includes(network));
    super(
      `${name} is no longer supported (${asked}): mn runs on ${VALID_NETWORK_NAMES.join(', ')}.\n`
      + `Pick another network: --network <name> on the command, or save one with: midnight config set network <${savable.join('|')}>`,
    );
    this.name = 'RetiredNetworkError';
    Object.setPrototypeOf(this, RetiredNetworkError.prototype);
  }
}

export function isValidNetworkName(name: string): name is NetworkName {
  return VALID_NETWORK_NAMES.includes(name as NetworkName);
}

/** A network name mn doesn't know. `valid` is what the message offers instead: every network, unless the place it was given takes fewer. */
export class InvalidNetworkError extends UsageError {
  constructor(name: string, valid: readonly string[] = VALID_NETWORK_NAMES) {
    super(`Invalid network: "${name}"\nValid networks: ${valid.join(', ')}`);
    this.name = 'InvalidNetworkError';
    Object.setPrototypeOf(this, InvalidNetworkError.prototype);
  }
}

/** Throws InvalidNetworkError unless `name` is a network mn knows (RetiredNetworkError for one it no longer runs on). */
export function assertValidNetworkName(name: string): asserts name is NetworkName {
  if (isRetiredNetworkName(name)) throw new RetiredNetworkError(name, 'given as the network');
  if (!isValidNetworkName(name)) throw new InvalidNetworkError(name);
}

/**
 * Networks a command acts on only when it names them itself (`--network`, a
 * tool's network parameter): never the saved network, never one inferred
 * from an address. Mainnet's transactions move real value.
 */
const NAMED_ONLY_NETWORKS: readonly NetworkName[] = ['mainnet'];

/** Whether a command must name `name` itself to act on it. */
export function isNamedOnlyNetwork(name: string): boolean {
  return NAMED_ONLY_NETWORKS.includes(name as NetworkName);
}

/** A named-only network was asked for where it would not be named per command: as the saved network, or inferred from an address. `asked` says which. */
export class NetworkNotNamedError extends UsageError {
  constructor(network: NetworkName, asked: string) {
    super(
      `${network} is used only when a command names it: ${asked}.\n`
      + `Name it on each command instead: --network ${network} (for an MCP tool, its network parameter).`,
    );
    this.name = 'NetworkNotNamedError';
    Object.setPrototypeOf(this, NetworkNotNamedError.prototype);
  }
}

export function getNetworkConfig(name: NetworkName): NetworkConfig {
  return { ...NETWORK_CONFIGS[name] };
}

export function getValidNetworkNames(): readonly string[] {
  return VALID_NETWORK_NAMES;
}

/**
 * Detect network from a Midnight bech32m address prefix: `mn_addr_<network>1…`,
 * or `mn_addr1…` on mainnet, whose addresses carry no network segment.
 * Returns null if the prefix doesn't match any known network.
 */
export function detectNetworkFromAddress(address: string): NetworkName | null {
  if (address.startsWith('mn_addr1')) return 'mainnet';
  if (address.startsWith('mn_addr_preprod1')) return 'preprod';
  if (address.startsWith('mn_addr_preview1')) return 'preview';
  if (address.startsWith('mn_addr_undeployed1')) return 'undeployed';
  return null;
}

/** Whether the text is written as an unshielded address (`mn_addr1…` on mainnet, `mn_addr_<network>1…` elsewhere) rather than a wallet name. */
export function looksLikeUnshieldedAddress(text: string): boolean {
  return text.startsWith('mn_addr1') || text.startsWith('mn_addr_');
}

/** Whether the text is written as a shielded address (`mn_shield-addr1…` on mainnet, `mn_shield-addr_<network>1…` elsewhere). */
export function looksLikeShieldedAddress(text: string): boolean {
  return text.startsWith('mn_shield-addr1') || text.startsWith('mn_shield-addr_');
}

/** The bech32m prefix, up to and including the separator, of an address of that kind on `network`: mainnet's has no network segment. */
export function addressPrefix(kind: 'unshielded' | 'shielded', network: NetworkName): string {
  const hrp = kind === 'shielded' ? 'mn_shield-addr' : 'mn_addr';
  return network === 'mainnet' ? `${hrp}1` : `${hrp}_${network}1`;
}

interface TestcontainerPorts {
  indexerPort?: number;
  nodePort?: number;
  proofServerPort?: number;
}

/** Host ports of each Midnight component running locally, distinct and sorted. */
export interface LocalStackPorts {
  node: number[];
  indexer: number[];
  proofServer: number[];
}

/**
 * Collect the host ports of local Midnight containers from
 * `docker ps --format "{{.Image}}|{{.Ports}}"` output.
 */
export function parseLocalStacks(dockerPsOutput: string): LocalStackPorts {
  const found = { node: new Set<number>(), indexer: new Set<number>(), proofServer: new Set<number>() };
  for (const line of dockerPsOutput.split('\n')) {
    if (!line) continue;
    const [image = '', ports = ''] = line.split('|');
    const hostPorts = (containerPort: number): number[] =>
      [...ports.matchAll(new RegExp(`:(\\d+)->${containerPort}/tcp`, 'g'))].map((m) => parseInt(m[1]!, 10));
    if (image.includes('indexer')) hostPorts(8088).forEach((p) => found.indexer.add(p));
    if (image.includes('midnight-node')) hostPorts(9944).forEach((p) => found.node.add(p));
    if (image.includes('proof-server')) hostPorts(6300).forEach((p) => found.proofServer.add(p));
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return { node: sorted(found.node), indexer: sorted(found.indexer), proofServer: sorted(found.proofServer) };
}

export class AmbiguousLocalStacksError extends Error {
  readonly code = 'AMBIGUOUS_LOCAL_STACKS';
  constructor(found: LocalStackPorts) {
    super(
      `Several local Midnight stacks are running (node ${found.node.join(', ')}; ` +
      `indexer ${found.indexer.join(', ')}; proof-server ${found.proofServer.join(', ')}), ` +
      `and mn won't guess which one to use.\n` +
      `Pick one per command:  --node ws://localhost:<port> --indexer-ws ws://localhost:<port>${INDEXER_GRAPHQL_WS_PATH} --proof-server http://localhost:<port>\n` +
      `or once:               midnight config set network undeployed, then midnight config set node / indexer-ws / proof-server <url>\n` +
      `Commands without endpoint flags (cache, test, dev) use the saved config. MN_NO_LOCAL_DETECT=1 turns detection off.`,
    );
    this.name = 'AmbiguousLocalStacksError';
  }
}

/** Which components still need a port from detection. */
export interface NeededComponents {
  node: boolean;
  indexer: boolean;
  proofServer: boolean;
}

const ALL_COMPONENTS: NeededComponents = { node: true, indexer: true, proofServer: true };

/**
 * The single local stack's ports for the components still needed. Throws
 * AmbiguousLocalStacksError when a needed component runs on more than one
 * port: picking would be a guess, and could mix two stacks. A component the
 * caller already has an endpoint for can't be ambiguous.
 */
export function pickLocalStack(found: LocalStackPorts, need: NeededComponents = ALL_COMPONENTS): TestcontainerPorts {
  if ((need.node && found.node.length > 1) || (need.indexer && found.indexer.length > 1)
      || (need.proofServer && found.proofServer.length > 1)) {
    throw new AmbiguousLocalStacksError(found);
  }
  return {
    nodePort: need.node ? found.node[0] : undefined,
    indexerPort: need.indexer ? found.indexer[0] : undefined,
    proofServerPort: need.proofServer ? found.proofServer[0] : undefined,
  };
}

/**
 * Read the local Midnight containers from docker (empty when docker isn't
 * available, or when the settings turn detection off (MN_NO_LOCAL_DETECT=1)
 * and leave undeployed on its default endpoints).
 */
export function detectLocalStacks(settings: Pick<Settings, 'isLocalDetectOff'>): LocalStackPorts {
  if (settings.isLocalDetectOff) return { node: [], indexer: [], proofServer: [] };
  try {
    return parseLocalStacks(execSync('docker ps --format "{{.Image}}|{{.Ports}}"', { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return { node: [], indexer: [], proofServer: [] };
  }
}

export interface ResolveNetworkConfigOptions {
  /** Endpoints given by flag or config. They win; only the rest are auto-detected. */
  given?: EndpointOverrides;
  /** Local stack detection (tests inject docker output). */
  detect?: () => LocalStackPorts;
  /** MN_NO_LOCAL_DETECT: don't look for a local stack (looked for when not given). */
  isLocalDetectOff?: boolean;
  /** The user's Blockfrost project id, for a network Blockfrost serves. */
  blockfrostProjectId?: string;
}

/**
 * Resolve a full network config: given endpoints first, then (on undeployed)
 * the single running local stack's ports for the components not given, then
 * the network defaults (on a network Blockfrost serves, its endpoints with the
 * project id). Refuses when a component it must detect is ambiguous.
 */
export function resolveNetworkConfig(name: NetworkName, options: ResolveNetworkConfigOptions = {}): NetworkConfig {
  const config = getNetworkConfig(name);
  if (usesBlockfrost(name)) Object.assign(config, blockfrostEndpoints(name, options.blockfrostProjectId));
  const given = options.given ?? {};

  const need: NeededComponents = {
    node: given.node === undefined,
    indexer: given.indexerWS === undefined,
    proofServer: given.proofServer === undefined,
  };
  if (name === 'undeployed' && (need.node || need.indexer || need.proofServer)) {
    const detected = pickLocalStack((options.detect ?? (() => detectLocalStacks({ isLocalDetectOff: options.isLocalDetectOff ?? false })))(), need);

    if (detected.indexerPort) {
      config.indexer = `http://localhost:${detected.indexerPort}${INDEXER_GRAPHQL_PATH}`;
      config.indexerWS = `ws://localhost:${detected.indexerPort}${INDEXER_GRAPHQL_WS_PATH}`;
    }
    if (detected.nodePort) {
      config.node = `ws://localhost:${detected.nodePort}`;
    }
    if (detected.proofServerPort) {
      config.proofServer = `http://localhost:${detected.proofServerPort}`;
    }
  }

  if (given.node !== undefined) config.node = given.node;
  if (given.proofServer !== undefined) config.proofServer = given.proofServer;
  if (given.indexerWS !== undefined) {
    config.indexerWS = given.indexerWS;
    config.indexer = indexerHttpFromWs(given.indexerWS);
  }
  return config;
}

/**
 * The indexer's HTTP GraphQL URL for its WebSocket URL: the protocol changed
 * and the path's trailing `/ws` dropped. A query string (a Blockfrost project
 * id) stays where it is.
 */
export function indexerHttpFromWs(wsUrl: string): string {
  const queryAt = wsUrl.indexOf('?');
  const [base, query] = queryAt === -1 ? [wsUrl, ''] : [wsUrl.slice(0, queryAt), wsUrl.slice(queryAt)];
  return base.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '') + query;
}

export interface EndpointOverrides {
  proofServer?: string;
  node?: string;
  indexerWS?: string;
}

/** The CLI flags carrying these endpoints, for building parsed args in code. */
export function endpointFlags(e: EndpointOverrides): Record<string, string> {
  const flags: Record<string, string> = {};
  if (e.node !== undefined) flags.node = e.node;
  if (e.indexerWS !== undefined) flags['indexer-ws'] = e.indexerWS;
  if (e.proofServer !== undefined) flags['proof-server'] = e.proofServer;
  return flags;
}

/**
 * Apply endpoint overrides to a network config.
 * Priority: flag overrides > persistent config (scoped to `networkName`) >
 * network defaults. Config overrides are network-scoped because endpoints
 * are inherently network-specific — a preprod node URL must never apply to
 * an `--network undeployed` run. See `getEndpointOverridesForNetwork` for
 * the scoping rules, including legacy flat-key compatibility.
 * Mutates and returns the config for convenience.
 */
export function applyEndpointOverrides(
  config: NetworkConfig,
  flagOverrides: EndpointOverrides,
  networkName: NetworkName,
  configDir: string,
): NetworkConfig {
  const cliConfig = loadCliConfig(configDir);
  const scoped = getEndpointOverridesForNetwork(cliConfig, networkName);

  config.proofServer = flagOverrides.proofServer ?? scoped['proof-server'] ?? config.proofServer;
  config.node = flagOverrides.node ?? scoped.node ?? config.node;
  config.indexerWS = flagOverrides.indexerWS ?? scoped['indexer-ws'] ?? config.indexerWS;

  // Keep indexer HTTP in sync if indexer WS was overridden
  if (flagOverrides.indexerWS ?? scoped['indexer-ws']) {
    config.indexer = indexerHttpFromWs(config.indexerWS);
  }

  return config;
}
