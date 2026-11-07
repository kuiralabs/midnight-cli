// The one sequence a contract deploy and call share: check the payer's wallet
// can pay, serve it through the payer, run the script against it with a
// progress line, and stop serving whatever happens.

import { type Payer, type PayingTarget, type CallSdkWarnings, type ServedWallet, throwIfCancelled } from '@kuiralabs/midnight-cli-core';
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
    throwIfCancelled(signal);
    const result = await run(serve, spinner);
    spinner.stop(labels.done);
    return result;
  } catch (err) {
    spinner.fail(labels.failed);
    throw err;
  } finally {
    await serve.stop();
  }
}
