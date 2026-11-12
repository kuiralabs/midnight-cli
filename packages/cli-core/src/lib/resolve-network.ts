// Network resolution chain — simplified 3-step priority
// 1. --network flag (explicit)
// 2. Default from ~/.midnight/config.json
// 3. Fallback: 'undeployed'

import { type ParsedArgs, getFlag } from './argv.ts';
import {
  type NetworkName,
  type NetworkConfig,
  isValidNetworkName,
  assertValidNetworkName,
  RetiredNetworkError,
  resolveNetworkConfig,
  type EndpointOverrides,
} from './network.ts';
import { usesBlockfrost } from './blockfrost.ts';
import { type BlockfrostSettings, blockfrostProjectIdInUse, loadCliConfig, getEndpointOverridesForNetwork } from './cli-config.ts';
import { BLOCKFROST_PROJECT_ID_ENV, SHARED_BLOCKFROST_PROJECT_ID_ENV, type Settings } from './settings.ts';

export type { BlockfrostSettings };

/** The settings resolving a network reads: whether to look for a local stack, and the Blockfrost ids. */
export type NetworkSettings = BlockfrostSettings & Pick<Settings, 'isLocalDetectOff'>;

export interface NetworkResolutionContext {
  args: ParsedArgs;
  /** The state root whose config.json holds the saved network and endpoints. */
  configDir: string;
}

/**
 * Resolve the network name using the 3-step priority chain.
 * Throws if --network flag is provided but invalid, and when the saved
 * network is one mn no longer runs on (RetiredNetworkError).
 */
export function resolveNetworkName(ctx: NetworkResolutionContext): NetworkName {
  // 1. Explicit --network flag
  const flagValue = getFlag(ctx.args, 'network');
  if (flagValue !== undefined) {
    assertValidNetworkName(flagValue);
    return flagValue;
  }

  // 2. Default from ~/.midnight/config.json
  const cliConfig = loadCliConfig(ctx.configDir);
  if (cliConfig.retiredNetwork !== undefined) throw new RetiredNetworkError(cliConfig.retiredNetwork, 'the saved network');
  if (cliConfig.network && isValidNetworkName(cliConfig.network)) {
    return cliConfig.network;
  }

  // 3. Fallback
  return 'undeployed';
}

// The Blockfrost variables' names are settings.ts's, re-exported for the callers that name them.
export { BLOCKFROST_PROJECT_ID_ENV, SHARED_BLOCKFROST_PROJECT_ID_ENV };

/**
 * The Blockfrost project id for `name`: the settings' (mn's own variable,
 * then the shared one), else the one set with `midnight config set`.
 * Undefined on a network Blockfrost doesn't serve, and when none is set (a
 * command that then connects is told so). mn's own variable is checked; both
 * are used only for the network their id is for.
 */
export function resolveBlockfrostProjectId(name: NetworkName, configDir: string, settings: BlockfrostSettings): string | undefined {
  if (!usesBlockfrost(name)) return undefined;
  return blockfrostProjectIdInUse(loadCliConfig(configDir), name, settings)?.projectId;
}

/**
 * Resolve network name + full config in one call. Endpoints come from the
 * command's flags, then the saved config for this network, and only the
 * components given by neither are auto-detected on undeployed (detection
 * refuses when a needed component is ambiguous). Every caller gets the same
 * fully resolved endpoints. `settings` are the host's: whether to look for a
 * local stack, and the Blockfrost ids.
 */
export function resolveNetwork(ctx: NetworkResolutionContext, settings: NetworkSettings): {
  name: NetworkName;
  config: NetworkConfig;
} {
  const name = resolveNetworkName(ctx);
  const configured = getEndpointOverridesForNetwork(loadCliConfig(ctx.configDir), name);
  const given: EndpointOverrides = {
    node: getFlag(ctx.args, 'node') ?? configured.node,
    indexerWS: getFlag(ctx.args, 'indexer-ws') ?? configured['indexer-ws'],
    proofServer: getFlag(ctx.args, 'proof-server') ?? configured['proof-server'],
  };
  const config = resolveNetworkConfig(name, {
    given,
    isLocalDetectOff: settings.isLocalDetectOff,
    blockfrostProjectId: resolveBlockfrostProjectId(name, ctx.configDir, settings),
  });
  return { name, config };
}
