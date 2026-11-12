// Deploying a compiled contract: the deploy script, run against the wallet
// the payer serves (served-wallet.ts). `mn contract deploy` and `mn dev` both deploy through here.
// The deploy is priced before it is proven (cost.ts); `--dry-run` stops there.

import { type Host, throwIfCancelled, type NetworkName, networkTargetOf, withCallSdkWarnings, type PayingTarget } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';
import { networkChoiceOf, stepSpinner, type PaidCallOptions } from '@kuiralabs/midnight-wallet';
import type { Receipt } from '@kuiralabs/midnight-chain';
import { reportedTransaction } from './script-transaction.ts';
import { type ServedRunLabels, withServedWallet } from './served-wallet.ts';
import { assertContractRunsOn, type ContractChecked } from './runtime-check.ts';
import { type ContractCost, type ContractPriced, costRecorder, maxPriceAdjustmentOn, type PricedContract } from './cost.ts';
import type { ContractDeployRequest } from './request.ts';
import type { DeployOptions } from './runner.ts';

export interface DeployContractOptions extends PaidCallOptions<ContractChecked | ContractPriced> {
  /** What to deploy (contractDeployRequest). */
  request: ContractDeployRequest;
}

/** A deployed contract. */
export interface DeployedContract {
  readonly network: NetworkName;
  readonly contractName: string;
  /** The contract's address on the network, 64 hex characters. */
  readonly address: string;
  /** The deploy's transaction's identifier (66 hex characters), as every command that submits gives it and `mn tx status` takes it; its hash is the receipt's. Undefined when the script reported none. */
  readonly txHash?: string;
  /** The transaction once the indexer lists it, or why it is missing; absent with no txHash. */
  readonly receipt?: Receipt;
  /** What the deploy was priced at before it was proven; absent when the mn serve that paid gave no price. */
  readonly cost?: ContractCost;
}

/**
 * Deploys the request's contract on the network, paid by the payer's wallet:
 * refuses a contract compiled for another runtime than the network's, then
 * the payer checks its wallet has NIGHT and Dust, serves it, and the deploy
 * script runs against it in the dApp's folder, saying the deploy's price
 * (a `contract-priced` event) before it is proven; the wallet stops being
 * served whatever happens.
 */
export async function deployContract(host: Host, options: DeployContractOptions): Promise<DeployedContract> {
  return withDeployScript(host, options, { running: 'Deploying contract...', done: 'Contract deployed', failed: 'Deploy failed', paying: `deploying ${options.request.info.name}` }, async (deploy, target, cost) => {
    const { runDeploy } = await import('./runner.ts');
    const result = await runDeploy(deploy);
    const transaction = await reportedTransaction(result, target.networkConfig.indexer, options.signal);
    const priced = cost();
    return {
      network: target.network,
      contractName: options.request.info.name,
      address: result.contractAddress,
      ...transaction,
      ...(priced === undefined ? {} : { cost: priced }),
    };
  });
}

/**
 * The request's deploy priced, and nothing more: the same checks and the same
 * deploy script as deployContract, stopped once midnight-js hands it the
 * transaction to prove. Nothing is proven or sent.
 */
export async function priceContractDeploy(host: Host, options: DeployContractOptions): Promise<PricedContract> {
  return withDeployScript(host, options, { running: 'Pricing the deploy...', done: 'Deploy priced', failed: 'Pricing failed', paying: `deploying ${options.request.info.name}` }, async (deploy, target, cost) => {
    const { priceDeploy } = await import('./runner.ts');
    await priceDeploy(deploy);
    return { network: target.network, contractName: options.request.info.name, cost: cost()! };
  });
}

/** The deploy script's options for the request, against the served wallet, with `run` given them; the shared path of deployContract and priceContractDeploy. */
async function withDeployScript<T>(
  host: Host,
  options: DeployContractOptions,
  labels: ServedRunLabels,
  run: (deploy: DeployOptions, target: PayingTarget, cost: () => ContractCost | undefined) => Promise<T>,
): Promise<T> {
  const { request, payer, wallet, signal, onProgress } = options;
  const { dappDir, info, constructorArgs, privateStateSecretKey } = request;
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network } = target;
  await assertContractRunsOn(info, network, target.root, host.engines);
  onProgress?.({ kind: 'contract-checked', network });
  const priced = costRecorder(await maxPriceAdjustmentOn(host, target, signal), onProgress);

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, (sdkWarnings) =>
    withServedWallet({ target, wallet, payer, progress: (message) => stepSpinner(onProgress, message), sdkWarnings, signal }, labels, (served, spinner: Spinner) =>
      run({
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
        onPriced: priced.onPrice,
        notice: host.notice,
        signal,
      }, target, priced.cost)));
}
