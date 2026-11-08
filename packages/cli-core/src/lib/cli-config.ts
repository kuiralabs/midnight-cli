import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG_FILENAME, FILE_MODE, WALLETS_DIR_NAME } from './constants.ts';
import { ensureOwnerOnlyDir, narrowToOwnerOnly } from './owner-only.ts';
import { assertValidWalletName } from './wallet-name.ts';
import { blockfrostNetworks, checkProjectId, maskProjectId, networkOfProjectId } from './blockfrost.ts';
import { InvalidNetworkError, type NetworkName, NetworkNotNamedError, RetiredNetworkError, getValidNetworkNames, isNamedOnlyNetwork, isRetiredNetworkName, isValidNetworkName } from './network.ts';
import { UsageError } from './errors.ts';
import { ACCOUNT_ARTIFACTS_KEY, checkAccountArtifactsSource } from './account-artifacts.ts';

/** mn's config file can't be read as one: mn neither guesses its settings nor writes over it. */
export class CorruptConfigError extends UsageError {
  constructor(configPath: string, reason: string) {
    super(
      `mn can't read its config file ${configPath}: ${reason}.\n`
      + `Fix it by hand, or move it aside to start again from the defaults (mn won't write over it): mv ${configPath} ${configPath}.bad`,
    );
    this.name = 'CorruptConfigError';
    Object.setPrototypeOf(this, CorruptConfigError.prototype);
  }
}

/** Endpoint overrides for one network. Keys mirror the flag/config names. */
export interface NetworkEndpointOverrides {
  'proof-server'?: string;
  node?: string;
  'indexer-ws'?: string;
}

/** What is kept per network: endpoint overrides, and the Blockfrost project id of a network Blockfrost serves. */
export interface NetworkSettings extends NetworkEndpointOverrides {
  'blockfrost-project-id'?: string;
}

const PROJECT_ID_KEY = 'blockfrost-project-id';

export interface CliConfig {
  network: NetworkName;
  /**
   * The saved network when it is one mn no longer runs on (stagenet). `network`
   * is then the default, which commands don't fall back to: they refuse until
   * another network is saved. Saved back as the network, unless one is set.
   */
  retiredNetwork?: string;
  /**
   * Per-network endpoint overrides — the canonical home for custom URLs.
   * Endpoints are inherently network-specific; scoping them prevents a
   * preprod node URL from leaking into `--network undeployed` runs.
   */
  networks?: Partial<Record<NetworkName, NetworkSettings>>;
  /**
   * Legacy flat overrides (pre-scoping). Still read for backward
   * compatibility, but they only apply when the resolved network matches
   * the config's pinned `network` — the network they were set under.
   * New writes go to `networks.<name>.*`.
   */
  'proof-server'?: string;
  node?: string;
  'indexer-ws'?: string;
  wallet?: string;
  /** Where mn grant gets the account contract's proving artefacts: an absolute folder or an http(s) URL (account-artifacts.ts). For every network: it is the account build's. */
  'account-artifacts'?: string;
}

const DEFAULT_CLI_CONFIG: CliConfig = {
  network: 'undeployed',
};

const VALID_CONFIG_KEYS: readonly string[] = ['network', 'proof-server', 'node', 'indexer-ws', 'wallet', PROJECT_ID_KEY, ACCOUNT_ARTIFACTS_KEY] as const;

/**
 * Aliases mapped to canonical config keys. Keeps integrations that learned
 * a different name working without forcing them to update. Add carefully —
 * each entry is a permanent compatibility surface.
 *   network-id → network: midnight-expert's setup-test-wallets skill
 *     instructs agents to read `network-id`. Resolve transparently so their
 *     flow doesn't error at step 1.
 */
const CONFIG_KEY_ALIASES: Readonly<Record<string, string>> = {
  'network-id': 'network',
};

function resolveConfigKey(key: string): string {
  return CONFIG_KEY_ALIASES[key] ?? key;
}

const ENDPOINT_KEYS: ReadonlySet<string> = new Set(['proof-server', 'node', 'indexer-ws']);

/** The URL schemes each endpoint is reached by: the node and the indexer's subscriptions over WebSocket, the proof server over HTTP. */
const ENDPOINT_SCHEMES: Readonly<Record<keyof NetworkEndpointOverrides, readonly string[]>> = {
  node: ['ws', 'wss'],
  'indexer-ws': ['ws', 'wss'],
  'proof-server': ['http', 'https'],
};

/** Refuses, as a usage error, a value for an endpoint key that is not a URL of a scheme that endpoint is reached by. */
function assertEndpointUrl(key: keyof NetworkEndpointOverrides, value: string): void {
  const schemes = ENDPOINT_SCHEMES[key];
  const scheme = /^([a-z]+):\/\/\S+$/.exec(value)?.[1];
  if (scheme === undefined || !schemes.includes(scheme)) {
    throw new UsageError(`Invalid URL for "${key}": "${value}"\nMust start with ${schemes.map((s) => `${s}://`).join(' or ')}`);
  }
}

function getConfigPath(configDir: string): string {
  return path.join(configDir, DEFAULT_CONFIG_FILENAME);
}



/**
 * Load CLI config from ~/.midnight/config.json.
 * Returns defaults if the file doesn't exist.
 */
export function loadCliConfig(configDir: string): CliConfig {
  const configPath = getConfigPath(configDir);

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CLI_CONFIG };
  }

  // A file that can't be read is refused, never taken as the defaults: a command
  // would then run on the default network and endpoints, and the next `config
  // set` would write the defaults over it.
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    throw new CorruptConfigError(configPath, error instanceof Error ? error.message : String(error));
  }

  let parsed: Partial<CliConfig>;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CorruptConfigError(configPath, error instanceof Error ? error.message : String(error));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CorruptConfigError(configPath, 'it is not a JSON object');
  }

  // A network a command must name itself (mainnet) is never the saved one,
  // even written into the file by hand: it is read as the default.
  const config: CliConfig = {
    network: parsed.network && isValidNetworkName(parsed.network) && !isNamedOnlyNetwork(parsed.network)
      ? parsed.network
      : DEFAULT_CLI_CONFIG.network,
  };
  // A network mn no longer runs on is kept as said, so a command refuses it
  // rather than run on the default; the legacy flat endpoints were set under
  // it, and never apply to another network.
  const retired = typeof parsed.network === 'string' && isRetiredNetworkName(parsed.network);
  if (retired) config.retiredNetwork = parsed.network;

  if (!retired && parsed['proof-server'] && typeof parsed['proof-server'] === 'string') {
    config['proof-server'] = parsed['proof-server'];
  }
  if (!retired && parsed.node && typeof parsed.node === 'string') {
    config.node = parsed.node;
  }
  if (!retired && parsed['indexer-ws'] && typeof parsed['indexer-ws'] === 'string') {
    config['indexer-ws'] = parsed['indexer-ws'];
  }
  if (parsed.wallet && typeof parsed.wallet === 'string') {
    config.wallet = parsed.wallet;
  }
  if (parsed[ACCOUNT_ARTIFACTS_KEY] && typeof parsed[ACCOUNT_ARTIFACTS_KEY] === 'string') {
    config[ACCOUNT_ARTIFACTS_KEY] = parsed[ACCOUNT_ARTIFACTS_KEY];
  }

  // Per-network endpoint overrides: keep only valid network names and
  // string-valued endpoint keys; drop anything else silently (config files
  // are user-edited — tolerate junk rather than crash every command).
  if (parsed.networks && typeof parsed.networks === 'object') {
    const networks: Partial<Record<NetworkName, NetworkSettings>> = {};
    for (const [name, overrides] of Object.entries(parsed.networks)) {
      if (!isValidNetworkName(name) || !overrides || typeof overrides !== 'object') continue;
      const scoped: NetworkSettings = {};
      for (const key of ENDPOINT_KEYS) {
        const value = (overrides as Record<string, unknown>)[key];
        if (value && typeof value === 'string') {
          scoped[key as keyof NetworkEndpointOverrides] = value;
        }
      }
      // A project id is kept only under the network its prefix names.
      const projectId = (overrides as Record<string, unknown>)[PROJECT_ID_KEY];
      if (typeof projectId === 'string' && networkOfProjectId(projectId) === name) scoped[PROJECT_ID_KEY] = projectId;
      if (Object.keys(scoped).length > 0) networks[name] = scoped;
    }
    if (Object.keys(networks).length > 0) config.networks = networks;
  }

  return config;
}

/**
 * Endpoint overrides that apply to `networkName`, resolved with scoping rules:
 *   scoped (`networks.<name>.*`) wins over legacy flat keys, and flat keys
 *   only apply when `networkName` is the config's pinned network — the
 *   network they were set under. This is what stops a preprod node URL in
 *   the config from hijacking `--network undeployed` runs.
 */
export function getEndpointOverridesForNetwork(
  config: CliConfig,
  networkName: NetworkName,
): NetworkEndpointOverrides {
  const scoped = config.networks?.[networkName] ?? {};
  const flatApplies = networkName === config.network;
  return {
    'proof-server': scoped['proof-server'] ?? (flatApplies ? config['proof-server'] : undefined),
    node: scoped.node ?? (flatApplies ? config.node : undefined),
    'indexer-ws': scoped['indexer-ws'] ?? (flatApplies ? config['indexer-ws'] : undefined),
  };
}

/** The Blockfrost project id set for `networkName`, if any. */
export function getBlockfrostProjectId(config: CliConfig, networkName: NetworkName): string | undefined {
  return config.networks?.[networkName]?.[PROJECT_ID_KEY];
}

/**
 * Save CLI config to ~/.midnight/config.json.
 * Creates the directory if it doesn't exist.
 */
export function saveCliConfig(config: CliConfig, configDir: string): void {
  ensureOwnerOnlyDir(configDir);
  const configPath = getConfigPath(configDir);
  const { retiredNetwork, ...saved } = config;
  if (retiredNetwork !== undefined) (saved as Record<string, unknown>).network = retiredNetwork;
  fs.writeFileSync(configPath, JSON.stringify(saved, null, 2) + '\n', { mode: FILE_MODE });
  // It can hold a Blockfrost project id: a file an earlier mn left readable to others is narrowed.
  narrowToOwnerOnly(configPath);
}

/**
 * Get a single config value.
 * Endpoint keys are network-scoped: returns the value that applies to the
 * currently configured network (scoped entry first, then the legacy flat key).
 */
export function getConfigValue(key: string, configDir: string, scope?: NetworkName): string {
  const canonical = resolveConfigKey(key);
  const config = loadCliConfig(configDir);
  assertScopeApplies(canonical, scope);

  if (canonical === 'network') return config.retiredNetwork ?? config.network;
  if (canonical === 'wallet') return config.wallet ?? '(not set)';
  if (canonical === ACCOUNT_ARTIFACTS_KEY) return config[ACCOUNT_ARTIFACTS_KEY] ?? '(not set)';
  if (canonical === PROJECT_ID_KEY) {
    // A secret: shown masked, and by network, since each network has its own.
    const set = blockfrostNetworks().filter((network) => scope === undefined || scope === network).flatMap((network) => {
      const projectId = getBlockfrostProjectId(config, network);
      return projectId === undefined ? [] : [`${maskProjectId(projectId)} (${network})`];
    });
    return set.length > 0 ? set.join(', ') : '(not set)';
  }
  if (ENDPOINT_KEYS.has(canonical)) {
    const overrides = getEndpointOverridesForNetwork(config, scope ?? config.network);
    const value = overrides[canonical as keyof NetworkEndpointOverrides];
    return typeof value === 'string' ? value : '(not set)';
  }

  throw new UsageError(
    `Unknown config key: "${key}"\nValid keys: ${VALID_CONFIG_KEYS.join(', ')}`
  );
}

/**
 * Migrate legacy flat endpoint keys into the scope of `networkName` —
 * the network they were set under. Called before switching networks so a
 * preprod node URL set as a flat key stays a *preprod* override instead of
 * following the user to the next network. Scoped entries win on conflict.
 */
function migrateFlatEndpointsToScope(config: CliConfig, networkName: NetworkName): void {
  const scoped: NetworkSettings = { ...(config.networks?.[networkName] ?? {}) };
  let migrated = false;
  for (const key of ENDPOINT_KEYS) {
    const k = key as keyof NetworkEndpointOverrides;
    const flat = config[k];
    if (flat && typeof flat === 'string') {
      if (!scoped[k]) scoped[k] = flat;
      delete config[k];
      migrated = true;
    }
  }
  if (migrated) {
    config.networks = { ...(config.networks ?? {}), [networkName]: scoped };
  }
}

/**
 * Set a single config value with validation.
 * Endpoint keys are written scoped under the currently configured network
 * (`networks.<name>.*`); any legacy flat copy of that key is removed so the
 * two can't diverge. Switching `network` first migrates legacy flat endpoint
 * keys into the old network's scope — they were set while using it.
 */
export function setConfigValue(key: string, value: string, configDir: string, scope?: NetworkName): void {
  const canonical = resolveConfigKey(key);
  const config = loadCliConfig(configDir);
  assertScopeApplies(canonical, scope);

  if (canonical === 'network') {
    // The saved network can't be one a command must name (mainnet), so the networks offered leave it out.
    if (isRetiredNetworkName(value)) throw new RetiredNetworkError(value, 'given as the saved network, which was left as it was');
    if (!isValidNetworkName(value)) throw new InvalidNetworkError(value, getValidNetworkNames().filter((name) => !isNamedOnlyNetwork(name)));
    if (isNamedOnlyNetwork(value)) throw new NetworkNotNamedError(value, 'it can\'t be the saved network, which was left as it was');
    migrateFlatEndpointsToScope(config, config.network);
    config.network = value;
    delete config.retiredNetwork;
  } else if (canonical === 'wallet') {
    assertValidWalletName(value);
    // Refused like `midnight wallet use`: an active wallet with no file fails every command that opens it.
    if (!fs.existsSync(path.join(configDir, WALLETS_DIR_NAME, `${value}.json`))) {
      throw new UsageError(`Wallet "${value}" not found.\nRun "midnight wallet list" to see available wallets.`);
    }
    config.wallet = value;
  } else if (canonical === ACCOUNT_ARTIFACTS_KEY) {
    config[ACCOUNT_ARTIFACTS_KEY] = checkAccountArtifactsSource(value, `config key ${ACCOUNT_ARTIFACTS_KEY}`);
  } else if (canonical === PROJECT_ID_KEY) {
    // Filed under the network its prefix names, whichever network is selected.
    const { projectId, network } = checkProjectId(value);
    if (scope !== undefined && scope !== network) throw new UsageError(`That is a ${network} project id, and --network says ${scope}.`);
    config.networks = { ...(config.networks ?? {}), [network]: { ...(config.networks?.[network] ?? {}), [PROJECT_ID_KEY]: projectId } };
  } else if (ENDPOINT_KEYS.has(canonical)) {
    assertEndpointUrl(canonical as keyof NetworkEndpointOverrides, value);
    const k = canonical as keyof NetworkEndpointOverrides;
    const target = scope ?? config.network;
    const scoped: NetworkSettings = { ...(config.networks?.[target] ?? {}) };
    scoped[k] = value;
    config.networks = { ...(config.networks ?? {}), [target]: scoped };
    // A legacy flat key applies to the selected network only.
    if (target === config.network) delete config[k];
  } else {
    throw new UsageError(
      `Unknown config key: "${key}"\nValid keys: ${VALID_CONFIG_KEYS.join(', ')}`
    );
  }

  saveCliConfig(config, configDir);
}

/**
 * Unset (reset) a single config value.
 * For 'network': resets to default ('undeployed').
 * For endpoint keys: removes both the current network's scoped entry and the
 * legacy flat key (so one unset reliably clears whatever was applying).
 * For other optional keys: removes the key entirely.
 */
export function unsetConfigValue(key: string, configDir: string, scope?: NetworkName): void {
  const canonical = resolveConfigKey(key);
  const config = loadCliConfig(configDir);
  assertScopeApplies(canonical, scope);

  if (canonical === 'network') {
    config.network = DEFAULT_CLI_CONFIG.network;
    delete config.retiredNetwork;
  } else if (canonical === 'wallet') {
    delete config.wallet;
  } else if (canonical === ACCOUNT_ARTIFACTS_KEY) {
    delete config[ACCOUNT_ARTIFACTS_KEY];
  } else if (canonical === PROJECT_ID_KEY) {
    for (const network of blockfrostNetworks()) {
      if (scope !== undefined && scope !== network) continue;
      const scoped = config.networks?.[network];
      if (!scoped) continue;
      delete scoped[PROJECT_ID_KEY];
      if (Object.keys(scoped).length === 0) delete config.networks![network];
    }
    if (config.networks && Object.keys(config.networks).length === 0) delete config.networks;
  } else if (ENDPOINT_KEYS.has(canonical)) {
    const k = canonical as keyof NetworkEndpointOverrides;
    const target = scope ?? config.network;
    if (target === config.network) delete config[k];
    const scoped = config.networks?.[target];
    if (scoped) {
      delete scoped[k];
      if (Object.keys(scoped).length === 0) {
        delete config.networks![target];
        if (Object.keys(config.networks!).length === 0) delete config.networks;
      }
    }
  } else {
    throw new UsageError(
      `Unknown config key: "${key}"\nValid keys: ${VALID_CONFIG_KEYS.join(', ')}`
    );
  }

  saveCliConfig(config, configDir);
}

/** A network scope (`--network`) only means something for the keys kept per network. */
function assertScopeApplies(canonical: string, scope: NetworkName | undefined): void {
  if (scope !== undefined && !ENDPOINT_KEYS.has(canonical) && canonical !== PROJECT_ID_KEY) {
    throw new UsageError(`--network only applies to the endpoint keys (${[...ENDPOINT_KEYS].join(', ')}) and ${PROJECT_ID_KEY}, not "${canonical}".`);
  }
}

/**
 * Every config value as `getConfigValue` shows it (the Blockfrost project id
 * masked), key by key. With `scope`, only the keys a network scopes
 * (endpoints, the project id), for that network.
 */
export function listConfigValues(configDir: string, scope?: NetworkName): Record<string, string> {
  const keys = VALID_CONFIG_KEYS.filter((key) => scope === undefined || ENDPOINT_KEYS.has(key) || key === PROJECT_ID_KEY);
  return Object.fromEntries(keys.map((key) => [key, getConfigValue(key, configDir, scope)]));
}

export function getValidConfigKeys(): readonly string[] {
  return VALID_CONFIG_KEYS;
}
