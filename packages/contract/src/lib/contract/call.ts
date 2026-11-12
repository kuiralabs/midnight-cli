// Calling a circuit of a deployed contract: the call script, run against the
// wallet the payer serves (served-wallet.ts). `mn contract call` calls through here.
// The call is priced before it is proven (cost.ts); `--dry-run` stops there.

import { type Host, throwIfCancelled, type NetworkName, networkTargetOf, withCallSdkWarnings, type PayingTarget, provingLine } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';
import { networkChoiceOf, stepSpinner, type PaidCallOptions } from '@kuiralabs/midnight-wallet';
import type { Receipt } from '@kuiralabs/midnight-chain';
import { reportedTransaction } from './script-transaction.ts';
import { type ServedRunLabels, withServedWallet } from './served-wallet.ts';
import { assertContractRunsOn, type ContractChecked } from './runtime-check.ts';
import { type ContractCost, type ContractPriced, costRecorder, maxPriceAdjustmentOn, type PricedContract } from './cost.ts';
import type { ContractCallRequest } from './request.ts';
import type { CallOptions } from './runner.ts';
import type { HeldCoin } from './held-coins.ts';
import { namingFreshCoinShortfall } from './fresh-coin-funds.ts';

/**
 * The call's --secret-key seeded nothing: the contract's private-state store
 * already held a private state, which doesn't hold that secret, and the call
 * runs from it (call-private-state.ts).
 */
export interface PrivateStateSecretUnused {
  readonly kind: 'private-state-secret-unused';
}

export interface CallContractOptions extends PaidCallOptions<ContractChecked | ContractPriced | PrivateStateSecretUnused> {
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
  /** The call's transaction's identifier (66 hex characters), as every command that submits gives it and `mn tx status` takes it; its hash is the receipt's. Undefined when the script reported none. */
  readonly txHash?: string;
  /** The transaction once the indexer lists it, or why it is missing; absent with no txHash. */
  readonly receipt?: Receipt;
  /** What the call was priced at before it was proven; absent when the mn serve that paid gave no price. */
  readonly cost?: ContractCost;
  /** The coins the call gave the contract, recorded in its private state for a witness to spend (held-coins.ts); absent when none. */
  readonly heldCoins?: readonly HeldCoin[];
}

/**
 * Calls the request's circuit on its deployed contract, paid by the payer's
 * wallet: refuses a contract compiled for another runtime than the network's,
 * then the payer checks its wallet has NIGHT and Dust, serves it, and the call
 * script runs against it in the dApp's folder, saying the call's price (a
 * `contract-priced` event) before it is proven; the wallet stops being served
 * whatever happens.
 */
export async function callContract(host: Host, options: CallContractOptions): Promise<CalledCircuit> {
  const { circuit, address } = options.request;
  return withCallScript(host, options, { running: `Calling ${circuit}...`, done: `${circuit} called`, failed: 'Call failed', paying: callPayment(options.request) }, async (call, target, cost) => {
    const { runCall } = await import('./runner.ts');
    const result = await runCall(call);
    const transaction = await reportedTransaction(result, target.networkConfig.indexer, options.signal);
    const priced = cost();
    return {
      network: target.network,
      contractName: options.request.info.name,
      circuit,
      address,
      status: result.status,
      ...transaction,
      ...(priced === undefined ? {} : { cost: priced }),
      ...(result.heldCoins === undefined || result.heldCoins.length === 0 ? {} : { heldCoins: result.heldCoins }),
    };
  });
}

/**
 * The request's call priced, and nothing more: the same checks and the same
 * call script as callContract, stopped once midnight-js hands it the
 * transaction to prove. The circuit runs on the contract's state; nothing is
 * proven or sent, and its private state is not written.
 */
export async function priceContractCall(host: Host, options: CallContractOptions): Promise<PricedContract> {
  return withCallScript(host, options, { running: 'Pricing the call...', done: 'Call priced', failed: 'Pricing failed', paying: callPayment(options.request) }, async (call, target, cost) => {
    const { priceCall } = await import('./runner.ts');
    await priceCall(call);
    return { network: target.network, contractName: options.request.info.name, cost: cost()! };
  });
}

/** What a call pays for, as a refusal names it. */
const callPayment = ({ circuit, info }: ContractCallRequest): string => `calling ${circuit} on ${info.name}`;

/** The call script's options for the request, against the served wallet, with `run` given them; the shared path of callContract and priceContractCall. */
async function withCallScript<T>(
  host: Host,
  options: CallContractOptions,
  labels: ServedRunLabels,
  run: (call: CallOptions, target: PayingTarget, cost: () => ContractCost | undefined) => Promise<T>,
): Promise<T> {
  const { request, payer, wallet, signal, onProgress } = options;
  const { dappDir, info, address, circuit, callArgs, freshCoins, privateStateSecretKey } = request;
  throwIfCancelled(signal);
  const target = networkTargetOf(host, networkChoiceOf(options));
  const { network } = target;
  await assertContractRunsOn(info, network, target.root, host.engines);
  onProgress?.({ kind: 'contract-checked', network });
  const priced = costRecorder(await maxPriceAdjustmentOn(host, target, signal), onProgress);

  // A wallet short of the shielded coins the call's fresh coins take is said with their amounts.
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
        contractAddress: address,
        circuit,
        args: callArgs,
        servePort: served.port,
        contractKeys: served.contractKeys,
        privateStateSecretKey,
        onMessage: (msg) => spinner.update(msg),
        onPriced: priced.onPrice,
        // A proof of minutes is said in every mode (--json included), as a wait is.
        onProving: (elapsedMs) => host.waiting(provingLine(elapsedMs), false),
        ...(privateStateSecretKey === undefined ? {} : { onPrivateStateSecretUnused: () => onProgress?.({ kind: 'private-state-secret-unused' }) }),
        notice: host.notice,
        signal,
      }, target, priced.cost))).catch((err: unknown) => {
    throw namingFreshCoinShortfall(err, callArgs, freshCoins, wallet);
  });
}
