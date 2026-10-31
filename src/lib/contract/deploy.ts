// Deploying a compiled contract: the deploy script, run against the wallet
// the payer serves (served-wallet.ts). `mn contract deploy` and `mn dev` both deploy through here.

import type { Payer, PayingTarget } from '../payer.ts';
import { withServedWallet } from './served-wallet.ts';
import type { Spinner } from '../../ui/spinner.ts';
import type { ContractDeployRequest } from './request.ts';

export interface DeployContractParams {
  request: ContractDeployRequest;
  target: PayingTarget;
  /** The wallet that pays; the active wallet when undefined. */
  wallet: string | undefined;
  payer: Payer;
  /** Starts the progress line for each step, given its first message. */
  progress: (message: string) => Spinner;
  signal?: AbortSignal;
}

export interface DeployedContract {
  contractName: string;
  address: string;
  network: string;
}

export async function deployContract({ request, target, wallet, payer, progress, signal }: DeployContractParams): Promise<DeployedContract> {
  const { dappDir, info, constructorArgs, privateStateSecretKey } = request;
  const { runDeploy } = await import('./runner.ts');

  return withServedWallet({ target, wallet, payer, progress }, { running: 'Deploying contract...', done: 'Contract deployed', failed: 'Deploy failed' }, async (servePort, spinner) => {
    const result = await runDeploy({
      dappDir,
      networkConfig: target.networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      servePort,
      args: constructorArgs,
      privateStateSecretKey,
      onMessage: (msg) => spinner.update(msg),
      signal,
    });
    return { contractName: info.name, address: result.contractAddress, network: target.network };
  });
}
