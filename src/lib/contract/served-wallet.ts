// The one sequence a contract deploy and call share: check the payer's wallet
// can pay, serve it through the payer, run the script against it with a
// progress line, and stop serving whatever happens.

import type { Payer, PayingTarget } from '../payer.ts';
import type { Spinner } from '../../ui/spinner.ts';

export interface ServedWalletParams {
  target: PayingTarget;
  /** The wallet that pays; the active wallet when undefined. */
  wallet: string | undefined;
  payer: Payer;
  /** Starts the progress line for each step, given its first message. */
  progress: (message: string) => Spinner;
}

/** What the progress line says while the script runs, when it succeeds, and when it fails. */
export interface ServedRunLabels {
  running: string;
  done: string;
  failed: string;
}

export async function withServedWallet<T>(
  { target, wallet, payer, progress }: ServedWalletParams,
  labels: ServedRunLabels,
  run: (servePort: number, spinner: Spinner) => Promise<T>,
): Promise<T> {
  // Before anything is served: the payer's wallet has NIGHT and Dust to pay with.
  await payer.assertCanPay(target, wallet, progress('Checking wallet...'));
  const serve = await payer.serve(target, wallet, progress('Starting mn serve...'));
  const spinner = progress(labels.running);
  try {
    const result = await run(serve.port, spinner);
    spinner.stop(labels.done);
    return result;
  } catch (err) {
    spinner.fail(labels.failed);
    throw err;
  } finally {
    await serve.stop();
  }
}
