// What an operation paid through a payer takes besides its own inputs (a
// contract deploy or call, a swap), and the payer's steps said as progress
// events: a payer reports on a Spinner (payer.ts), which stepSpinner turns
// into the operation's events.

import type { NetworkChoice } from '@kuiralabs/midnight-cli-core/lib/network-target';
import type { Payer } from '@kuiralabs/midnight-cli-core/lib/payer';
import type { ProgressEvent } from '@kuiralabs/midnight-cli-core/lib/progress';
import type { CallSdkWarnings } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import type { Spinner, SpinnerReporter } from '@kuiralabs/midnight-cli-core/ui/spinner';

/** A step ended in failure, saying so: the payer found no NIGHT, the script failed. The operation's error follows. */
export interface StepFailed {
  readonly kind: 'step-failed';
  readonly message: string;
}

/** The network, the endpoints, the payer and what a call gives an operation it pays for; `Event` is what it says beyond its steps. */
export interface PaidCallOptions<Event = never> extends NetworkChoice {
  /** Pays: checks its wallet can, and serves or opens it (the CLI and the MCP server pass mn serve's). */
  payer: Payer;
  /** The wallet the payer pays from, a name or a path; the active wallet when not given. */
  wallet?: string;
  /** Cancels the operation: a call cancelled already starts nothing; one cancelled later stops with CancelledError. */
  signal?: AbortSignal;
  /** Each step, in today's words for a person, a step that fails, and the operation's own events. */
  onProgress?: (event: ProgressEvent | StepFailed | Event) => void;
  /** The call's SDK warnings, kept off the terminal while a wallet in this process runs; a call of the host's own when not given. */
  sdkWarnings?: CallSdkWarnings;
}

/**
 * A step that starts by saying `message`, as a Spinner for a payer to report
 * on: its updates, its end (`stop`) and its failure (`fail`) go to
 * `onProgress` as events. A step says nothing more once it has ended; `clear`
 * ends it as `stop` does, and `log` says its line as an update.
 */
export function stepSpinner(onProgress: ((event: ProgressEvent | StepFailed) => void) | undefined, message: string): Spinner {
  let current = message;
  let ended = false;
  const say = (text: string): void => {
    if (ended) return;
    current = text;
    onProgress?.({ kind: 'update', message: text });
  };
  const end = (event: ProgressEvent | StepFailed): void => {
    if (ended) return;
    ended = true;
    onProgress?.(event);
  };
  onProgress?.({ kind: 'start', message });
  return {
    update: say,
    stop: (finalMessage) => end({ kind: 'done', message: finalMessage ?? current }),
    fail: (finalMessage) => end({ kind: 'step-failed', message: finalMessage ?? current }),
    log: say,
    clear: () => end({ kind: 'done', message: current }),
  };
}

/** Shows a paid operation's step on `reporter`'s spinners: a failed step ends with a failure mark. */
export function showPaidStep(reporter: SpinnerReporter, event: ProgressEvent | StepFailed): void {
  if (event.kind === 'step-failed') reporter.fail(event.message);
  else reporter.report(event);
}
