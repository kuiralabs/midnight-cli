// Deploying a compiled contract: check the wallet can pay, serve it through
// the payer, run the deploy script against the served wallet, and stop
// serving. `mn contract deploy` and `mn dev` both deploy through here.

import { assertWalletCanPay } from '../wallet-can-pay.ts';
import type { Payer, PayingTarget } from '../payer.ts';
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

  // Before anything is served: the wallet has NIGHT and Dust to pay with.
  await assertWalletCanPay(target, wallet, progress('Checking wallet...'));

  const serve = await payer.serve(target, wallet, progress('Starting mn serve...'));
  const spinner = progress('Deploying contract...');
  try {
    const result = await runDeploy({
      dappDir,
      networkConfig: target.networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      servePort: serve.port,
      args: constructorArgs,
      privateStateSecretKey,
      onMessage: (msg) => spinner.update(msg),
      signal,
    });
    spinner.stop('Contract deployed');
    return { contractName: info.name, address: result.contractAddress, network: target.network };
  } catch (err) {
    spinner.fail('Deploy failed');
    throw err;
  } finally {
    await serve.stop();
  }
}
