// Calling a circuit of a deployed contract: the call script, run against the
// wallet the payer serves (served-wallet.ts). `mn contract call` calls through here.

import type { Payer, PayingTarget } from '../payer.ts';
import { withServedWallet } from './served-wallet.ts';
import type { Spinner } from '../../ui/spinner.ts';
import type { CallSdkWarnings } from '../sdk-warnings.ts';
import type { ContractCallRequest } from './request.ts';

export interface CallContractParams {
  request: ContractCallRequest;
  target: PayingTarget;
  /** The wallet that pays; the active wallet when undefined. */
  wallet: string | undefined;
  payer: Payer;
  /** Starts the progress line for each step, given its first message. */
  progress: (message: string) => Spinner;
  /** The paying call's SDK warnings, which a wallet served in this process keeps to. */
  sdkWarnings: CallSdkWarnings;
  signal?: AbortSignal;
}

export interface CalledCircuit {
  contractName: string;
  circuit: string;
  address: string;
  network: string;
  status: string;
}

export async function callContract({ request, target, wallet, payer, progress, sdkWarnings, signal }: CallContractParams): Promise<CalledCircuit> {
  const { dappDir, info, address, circuit, callArgs } = request;
  const { runCall } = await import('./runner.ts');

  return withServedWallet({ target, wallet, payer, progress, sdkWarnings }, { running: `Calling ${circuit}...`, done: `${circuit} called`, failed: 'Call failed' }, async (servePort, spinner) => {
    const result = await runCall({
      dappDir,
      networkConfig: target.networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      contractAddress: address,
      circuit,
      args: callArgs,
      servePort,
      onMessage: (msg) => spinner.update(msg),
      signal,
    });
    return { contractName: info.name, circuit, address, network: target.network, status: result.status };
  });
}
