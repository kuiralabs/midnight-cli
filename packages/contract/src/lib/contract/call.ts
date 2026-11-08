// Calling a circuit of a deployed contract: the call script, run against the
// wallet the payer serves (served-wallet.ts). `mn contract call` calls through here.

import { type Host, throwIfCancelled, type NetworkName, networkTargetOf, withCallSdkWarnings } from '@kuiralabs/midnight-cli-core';
import { networkChoiceOf, stepSpinner, type PaidCallOptions } from '@kuiralabs/midnight-wallet';
import { receiptOf, type Receipt } from '@kuiralabs/midnight-chain';
import { withServedWallet } from './served-wallet.ts';
import { assertContractRunsOn, type ContractChecked } from './runtime-check.ts';
import type { ContractCallRequest } from './request.ts';

export interface CallContractOptions extends PaidCallOptions<ContractChecked> {
  /** The circuit to call, on which contract (contractCallRequest). */
  request: ContractCallRequest;
}

/** A circuit called. */
export interface CalledCircuit {
  readonly network: NetworkName;
  readonly contractName: string;
  readonly circuit: string;
  readonly address: string;
  /** What the call script reports of the transaction (the SDK's status, e.g. "SucceedEntirely"). */
  readonly status: string;
  /** The hash of the call's transaction (undefined when the script did not report one). */
  readonly txHash?: string;
  /** The transaction once the indexer lists it, or why it is missing; absent with no txHash. */
  readonly receipt?: Receipt;
}

/**
 * Calls the request's circuit on its deployed contract, paid by the payer's
 * wallet: refuses a contract compiled for another runtime than the network's,
 * then the payer checks its wallet has NIGHT and Dust, serves it, and the call
 * script runs against it in the dApp's folder; the wallet stops being served
 * whatever happens.
 */
export async function callContract(host: Host, options: CallContractOptions): Promise<CalledCircuit> {
  const { request, payer, wallet, signal, onProgress } = options;
  const { dappDir, info, address, circuit, callArgs, privateStateSecretKey } = request;
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network } = target;
  await assertContractRunsOn(info, network, target.root, host.engines);
  onProgress?.({ kind: 'contract-checked', network });
  const { runCall } = await import('./runner.ts');

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) =>
    withServedWallet({ target, wallet, payer, progress: (message) => stepSpinner(onProgress, message), sdkWarnings, signal }, { running: `Calling ${circuit}...`, done: `${circuit} called`, failed: 'Call failed' }, async (served, spinner) => {
      const result = await runCall({
        dappDir,
        network,
        root: target.root,
        engines: host.engines,
        networkConfig: target.networkConfig,
        managedDir: info.managedDir,
        contractName: info.name,
        contractAddress: address,
        circuit,
        args: callArgs,
        servePort: served.port,
        contractKeys: served.contractKeys,
        privateStateSecretKey,
        onMessage: (msg) => spinner.update(msg),
        notice: host.notice,
        signal,
      });
      const receipt = result.txHash === undefined ? undefined : await receiptOf(target.networkConfig.indexer, result.txHash, signal);
      return { network, contractName: info.name, circuit, address, status: result.status, ...(result.txHash === undefined ? {} : { txHash: result.txHash, receipt }) };
    }));
}
