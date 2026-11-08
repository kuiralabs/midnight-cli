// Deploying a compiled contract: the deploy script, run against the wallet
// the payer serves (served-wallet.ts). `mn contract deploy` and `mn dev` both deploy through here.

import { type Host, throwIfCancelled, type NetworkName, networkTargetOf, withCallSdkWarnings } from '@kuiralabs/midnight-cli-core';
import { networkChoiceOf, stepSpinner, type PaidCallOptions } from '@kuiralabs/midnight-wallet';
import { receiptOf, type Receipt } from '@kuiralabs/midnight-chain';
import { withServedWallet } from './served-wallet.ts';
import { assertContractRunsOn, type ContractChecked } from './runtime-check.ts';
import type { ContractDeployRequest } from './request.ts';

export interface DeployContractOptions extends PaidCallOptions<ContractChecked> {
  /** What to deploy (contractDeployRequest). */
  request: ContractDeployRequest;
}

/** A deployed contract. */
export interface DeployedContract {
  readonly network: NetworkName;
  readonly contractName: string;
  /** The contract's address on the network, 64 hex characters. */
  readonly address: string;
  /** The hash of the deploy's transaction (undefined when the script did not report one). */
  readonly txHash?: string;
  /** The transaction once the indexer lists it, or why it is missing; absent with no txHash. */
  readonly receipt?: Receipt;
}

/**
 * Deploys the request's contract on the network, paid by the payer's wallet:
 * refuses a contract compiled for another runtime than the network's, then
 * the payer checks its wallet has NIGHT and Dust, serves it, and the deploy
 * script runs against it in the dApp's folder; the wallet stops being served
 * whatever happens.
 */
export async function deployContract(host: Host, options: DeployContractOptions): Promise<DeployedContract> {
  const { request, payer, wallet, signal, onProgress } = options;
  const { dappDir, info, constructorArgs, privateStateSecretKey } = request;
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network } = target;
  await assertContractRunsOn(info, network, target.root, host.engines);
  onProgress?.({ kind: 'contract-checked', network });
  const { runDeploy } = await import('./runner.ts');

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) =>
    withServedWallet({ target, wallet, payer, progress: (message) => stepSpinner(onProgress, message), sdkWarnings, signal }, { running: 'Deploying contract...', done: 'Contract deployed', failed: 'Deploy failed' }, async (served, spinner) => {
      const result = await runDeploy({
        dappDir,
        network,
        root: target.root,
        engines: host.engines,
        networkConfig: target.networkConfig,
        managedDir: info.managedDir,
        contractName: info.name,
        servePort: served.port,
        contractKeys: served.contractKeys,
        args: constructorArgs,
        privateStateSecretKey,
        onMessage: (msg) => spinner.update(msg),
        notice: host.notice,
        signal,
      });
      const receipt = result.txHash === undefined ? undefined : await receiptOf(target.networkConfig.indexer, result.txHash, signal);
      return { network, contractName: info.name, address: result.contractAddress, ...(result.txHash === undefined ? {} : { txHash: result.txHash, receipt }) };
    }));
}
