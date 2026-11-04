// Deploying the project `mn dev` watches: the compiled contract found in the
// project's folder, with no constructor arguments, paid by one of the dev
// wallets on the local network. What its steps say goes to `progress`; the
// SDK's warnings go to the deploying call's `sdkWarnings`.

import { deployContract, type DeployedContract, contractDeployRequest } from '@kuiralabs/midnight-contract';
import type { Payer, Host, NetworkName, CallSdkWarnings } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';

/**
 * Deploys the contract compiled in `projectRoot` on `network`, paid by
 * `payer` from `wallet`. Every step reports on the one line `progress`: its
 * updates, its end and its failure, as each step's own line would.
 */
export async function deployDevContract(host: Host, projectRoot: string, wallet: string, network: NetworkName, payer: Payer, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined): Promise<DeployedContract> {
  return deployContract(host, {
    request: contractDeployRequest({ dappDir: projectRoot }),
    network,
    wallet,
    payer,
    sdkWarnings,
    signal,
    onProgress: (event) => {
      if (event.kind === 'update') progress.update(event.message);
      else if (event.kind === 'done') progress.stop(event.message);
      else if (event.kind === 'step-failed') progress.fail(event.message);
    },
  });
}
