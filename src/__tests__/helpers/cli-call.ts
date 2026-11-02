// A handler called as the CLI calls it: with a context built as the
// shell builds one, its result written at once to stdout as one JSON line.
// Tests that read a command's output from the process's streams call it so.

import type { ParsedArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { createCallContext, runHandler, type CommandHandler, type CommandOutcome } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { processOutput } from '../../lib/command-dispatch.ts';
import type { Payer } from '@kuiralabs/midnight-cli-core/lib/payer';

export interface CliCallOptions<Protector> {
  /** The call's cancellation; none: it is never cancelled. */
  signal?: AbortSignal;
  payer?: Payer;
  protectors?: readonly Protector[];
}

/** Runs `handler` with `args` as the CLI does, and returns the exit code it gives. */
export function cliCall<Protector = unknown>(
  handler: CommandHandler<Protector>,
  args: ParsedArgs,
  { signal, payer, protectors }: CliCallOptions<Protector> = {},
): Promise<CommandOutcome | void> {
  const ctx = createCallContext<Protector>({
    args,
    signal: signal ?? new AbortController().signal,
    output: processOutput,
    ...(payer === undefined ? {} : { payer }),
    ...(protectors === undefined ? {} : { protectors }),
  });
  return runHandler(handler, args, ctx);
}
