// A handler called as the CLI calls it: with a context built as the
// shell builds one, its result written at once to stdout as one JSON line.
// Tests that read a command's output from the process's streams call it so.

import type { ParsedArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { createCallContext, runHandler, type CommandHandler, type CommandOutcome } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { processOutput } from '../../lib/command-dispatch.ts';
import type { Payer } from '@kuiralabs/midnight-cli-core/lib/payer';
import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { testHost } from './test-host.ts';

export interface CliCallOptions<Protector> {
  /** The call's cancellation; none: it is never cancelled. */
  signal?: AbortSignal;
  payer?: Payer;
  protectors?: readonly Protector[];
  /** The host the call runs in; a test host when not given. */
  host?: Host;
}

/** Runs `handler` with `args` as the CLI does, and returns the exit code it gives. */
export function cliCall<Protector = unknown>(
  handler: CommandHandler<Protector>,
  args: ParsedArgs,
  { signal, payer, protectors, host }: CliCallOptions<Protector> = {},
): Promise<CommandOutcome | void> {
  const ctx = createCallContext<Protector>({
    host: host ?? testHost(),
    args,
    signal: signal ?? new AbortController().signal,
    output: processOutput,
    ...(payer === undefined ? {} : { payer }),
    ...(protectors === undefined ? {} : { protectors }),
  });
  return runHandler(handler, args, ctx);
}
