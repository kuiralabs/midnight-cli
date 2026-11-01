// Deploying the project `mn dev` watches: the compiled contract found in the
// project's folder, with no constructor arguments, paid by one of the dev
// wallets on the local network. What its steps say goes to `progress`; the
// SDK's warnings go to the deploying call's `sdkWarnings`.

import type { ParsedArgs } from '../argv.ts';
import { deployContract, type DeployedContract } from '../contract/deploy.ts';
import { resolveContractDeployRequest } from '../contract/request.ts';
import { resolvePayingTarget, type Payer } from '../payer.ts';
import type { Spinner } from '../../ui/spinner.ts';
import type { CallSdkWarnings } from '../sdk-warnings.ts';

export async function deployDevContract(projectRoot: string, wallet: string, network: string, payer: Payer, progress: Spinner, sdkWarnings: CallSdkWarnings): Promise<DeployedContract> {
  // The deploy as `mn contract deploy --path <projectRoot> --wallet <wallet> --network <network>` reads it.
  const args: ParsedArgs = {
    command: 'contract',
    subcommand: 'deploy',
    positionals: [],
    flags: { path: projectRoot, wallet, network },
  };
  return deployContract({
    request: resolveContractDeployRequest(args),
    target: resolvePayingTarget(args, 'contract', 'deploy'),
    wallet,
    payer,
    progress: () => progress,
    sdkWarnings,
  });
}
