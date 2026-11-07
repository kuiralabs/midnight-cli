// Ensures a ledger-9 network is reachable for `mn dev`. It does not start a
// localnet (`mn localnet up` does): it requires a running stack at the
// endpoints `undeployed` resolves to (saved config, or the single local stack
// docker shows).

import { resolveNetwork, type NetworkSettings } from '@kuiralabs/midnight-cli-core';
import { assertLedger9StackReachable } from '@kuiralabs/midnight-chain';

export type LocalnetState = 'already-running';

export interface EnsureLocalnetResult {
  state: LocalnetState;
}

/**
 * Require a running ledger-9 stack, at the endpoints saved under the state
 * root `root` (or the local stack detected, unless the host's `settings` turn
 * detection off); throws with setup instructions if none answers.
 */
export async function ensureLocalnetRunning(root: string, settings: NetworkSettings, onProgress?: (msg: string) => void): Promise<EnsureLocalnetResult> {
  const { name, config } = resolveNetwork({
    args: { command: 'dev', subcommand: undefined, positionals: [], flags: { network: 'undeployed' } },
    configDir: root,
  }, settings);
  onProgress?.(`Checking the ledger-9 stack at ${config.node}`);
  await assertLedger9StackReachable(name, config);
  return { state: 'already-running' };
}
