// A compiled contract runs only on the compact runtime it was compiled for,
// and each SDK set has its own. A contract compiled for another refused up
// front, naming the compiler this network's set needs, instead of failing in
// its script after the wallet has synced ("Version mismatch").

import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { sdkSetOf, type HostEngines } from '@kuiralabs/midnight-cli-core/lib/engine';
import type { NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import type { ContractInfo } from './inspect.ts';

/** A deploy's or call's contract runs on the network's runtime: paying for it starts next. */
export interface ContractChecked {
  readonly kind: 'contract-checked';
  readonly network: NetworkName;
}

/**
 * Throws a UsageError unless the engine of `engines` for `network` (by the
 * config under the state root `root`) runs a contract
 * compiled for `info.runtimeVersion`. A contract from a compiler that records
 * no runtime version is let through: its own code checks the runtime when it
 * loads.
 */
export async function assertContractRunsOn(info: Pick<ContractInfo, 'name' | 'compilerVersion' | 'runtimeVersion'>, network: NetworkName, root: string, engines: HostEngines): Promise<void> {
  if (info.runtimeVersion === 'unknown') return;
  const { scripts } = (await engines.load(sdkSetOf(network, root))).contracts;
  if (scripts.acceptsRuntime(info.runtimeVersion)) return;
  throw new UsageError(
    `${info.name} was compiled by compactc ${info.compilerVersion} for compact-runtime ${info.runtimeVersion}, ` +
    `but ${network} runs contracts on compact-runtime ${scripts.compactRuntimeVersion}.\n` +
    `Recompile it with ${scripts.compiler}.`,
  );
}
