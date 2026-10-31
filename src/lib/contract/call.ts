// Calling a circuit of a deployed contract: check the wallet can pay, serve it
// through the payer, run the call script against the served wallet, and stop
// serving. `mn contract call` calls through here, as deploy.ts deploys.

import { assertWalletCanPay } from '../wallet-can-pay.ts';
import type { Payer, PayingTarget } from '../payer.ts';
import type { Spinner } from '../../ui/spinner.ts';
import type { ContractCallRequest } from './request.ts';

export interface CallContractParams {
  request: ContractCallRequest;
  target: PayingTarget;
  /** The wallet that pays; the active wallet when undefined. */
  wallet: string | undefined;
  payer: Payer;
  /** Starts the progress line for each step, given its first message. */
  progress: (message: string) => Spinner;
  signal?: AbortSignal;
}

export interface CalledCircuit {
  contractName: string;
  circuit: string;
  address: string;
  network: string;
  status: string;
}

export async function callContract({ request, target, wallet, payer, progress, signal }: CallContractParams): Promise<CalledCircuit> {
  const { dappDir, info, address, circuit, callArgs } = request;
  const { runCall } = await import('./runner.ts');

  // Before anything is served: the wallet has NIGHT and Dust to pay with.
  await assertWalletCanPay(target, wallet, progress('Checking wallet...'));

  const serve = await payer.serve(target, wallet, progress('Starting mn serve...'));
  const spinner = progress(`Calling ${circuit}...`);
  try {
    const result = await runCall({
      dappDir,
      networkConfig: target.networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      contractAddress: address,
      circuit,
      args: callArgs,
      servePort: serve.port,
      onMessage: (msg) => spinner.update(msg),
      signal,
    });
    spinner.stop(`${circuit} called`);
    return { contractName: info.name, circuit, address, network: target.network, status: result.status };
  } catch (err) {
    spinner.fail('Call failed');
    throw err;
  } finally {
    await serve.stop();
  }
}
