// The one sequence a contract deploy and call share: check the payer's wallet
// can pay, serve it through the payer, run the script against it with a
// progress line, and stop serving whatever happens. A run whose fee the node
// refused as too low runs again: mn serve then prices with a larger margin
// (FEE_REPRICED), until it has none larger left (FEE_TOO_LOW).

import { type Payer, type PayingTarget, type CallSdkWarnings, type ServedWallet, DUST_FEE_MARGIN_STEPS, isFeeRepriced, rerunWhenRepriced, throwIfCancelled } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';

export interface ServedWalletParams {
  target: PayingTarget;
  /** The wallet that pays; the active wallet when undefined. */
  wallet: string | undefined;
  payer: Payer;
  /** Starts the progress line for each step, given its first message. */
  progress: (message: string) => Spinner;
  /** The paying call's SDK warnings, which a wallet served in this process keeps to. */
  sdkWarnings: CallSdkWarnings;
  /** The paying call's cancellation: checking and serving the wallet stop when it aborts. */
  signal: AbortSignal | undefined;
}

/** What the progress line says while the script runs, when it succeeds, and when it fails. */
export interface ServedRunLabels {
  running: string;
  done: string;
  failed: string;
}

export async function withServedWallet<T>(
  { target, wallet, payer, progress, sdkWarnings, signal }: ServedWalletParams,
  labels: ServedRunLabels,
  run: (served: Pick<ServedWallet, 'port' | 'contractKeys'>, spinner: Spinner) => Promise<T>,
): Promise<T> {
  // Before anything is served: the payer's wallet has NIGHT and Dust to pay with.
  await payer.assertCanPay(target, wallet, progress('Checking wallet...'), signal);
  throwIfCancelled(signal);
  const serve = await payer.serve(target, wallet, progress('Starting mn serve...'), sdkWarnings, signal);
  const spinner = progress(labels.running);
  try {
    const result = await runRepricing(() => run(serve, spinner), (message) => spinner.update(message), signal);
    spinner.stop(labels.done);
    return result;
  } catch (err) {
    spinner.fail(labels.failed);
    throw err;
  } finally {
    await serve.stop();
  }
}

/**
 * Runs `run`, and again each time it fails with FEE_REPRICED, at most once per
 * margin mn serve can move to: nothing was spent, and the next balance is
 * priced with the larger margin. Any other failure, or one past the last, is
 * the run's.
 */
export async function runRepricing<T>(run: () => Promise<T>, onStatus: (message: string) => void, signal: AbortSignal | undefined): Promise<T> {
  let reruns = 0;
  return rerunWhenRepriced(run, (err) => isFeeRepriced(err) && reruns++ < DUST_FEE_MARGIN_STEPS.length - 1, onStatus, signal);
}
