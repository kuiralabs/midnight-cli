// The CLI's dispatch, from the command registry (plan 2C): which command runs,
// what the shell gives its handler, and whether it needs the wallet SDK. The
// shell (src/wallet.ts) owns the process: it passes in what a handler may be
// given and where a notice goes, and decides the heap and the exit.

import type { ParsedArgs } from './argv.ts';
import { createCallContext, runHandler, type CallContext, type CommandOutcome, type OutputSink } from './call-context.ts';
import type { CommandDefinition, CommandRegistry } from './command-definition.ts';
import { UsageError } from './errors.ts';
import { writeJsonResult } from './json-output.ts';
import type { Payer } from './payer.ts';
import type { CallSdkWarnings, SdkWarningCalls } from './sdk-warnings.ts';
import type { WalletProtector } from './wallet-protector.ts';

/** What the shell can give a handler: its call's signal and output, and, as its definition's `shell` field asks, the payer or protectors, loaded only then. */
export interface ShellProvisions {
  readonly signal: AbortSignal;
  /** Where the call's output goes; a definition's notice goes to its stderr, before the handler loads. */
  readonly output: OutputSink;
  /** The host's calls: each call runs in one, with its own SDK warnings. */
  readonly sdkWarnings: SdkWarningCalls;
  readonly loadPayer: () => Promise<Payer>;
  readonly loadProtectors: () => Promise<readonly WalletProtector[]>;
}

/** The CLI's output, written at once: the result as one line of JSON on stdout, text on stdout and stderr. */
export const processOutput: OutputSink = {
  result: writeJsonResult,
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
};

/** Whether the command starts the wallet SDK (more heap before it loads, and an explicit exit when it ends). False for a command not installed. */
export function commandNeedsWalletSdk(registry: CommandRegistry, name: string): boolean {
  return registry.find(name)?.needsWalletSdk === true;
}

/** The installed command by name; a UsageError naming it when there is none. */
export function findInstalledCommand(registry: CommandRegistry, name: string): CommandDefinition {
  const definition = registry.find(name);
  if (definition === undefined) {
    throw new UsageError(
      `Unknown command: "${name}"\n` +
      `Run "midnight help" to see available commands.`,
    );
  }
  return definition;
}

/** The call's context: its signal, its output, its SDK warnings and --verbose, and the payer or the protectors when its definition asks for them. */
async function cliCallContext(definition: CommandDefinition, args: ParsedArgs, provisions: ShellProvisions, sdkWarnings: CallSdkWarnings): Promise<CallContext<WalletProtector>> {
  const { payer, protectors } = definition.shell;
  return createCallContext({
    args,
    signal: provisions.signal,
    output: provisions.output,
    sdkWarnings,
    ...(payer === true ? { payer: await provisions.loadPayer() } : {}),
    ...(protectors === true ? { protectors: await provisions.loadProtectors() } : {}),
  });
}

/**
 * Runs the command named by `name` with `args`: refuses it when its
 * definition says it is unavailable, writes its notice, loads its handler and
 * calls it with its call's context; a call already cancelled never starts.
 * Returns the exit code the handler gives, for the shell to set.
 */
export async function dispatchCommand(registry: CommandRegistry, name: string, args: ParsedArgs, provisions: ShellProvisions): Promise<CommandOutcome | void> {
  const definition = findInstalledCommand(registry, name);
  if (definition.shell.unavailable !== undefined) throw new Error(definition.shell.unavailable);
  if (definition.shell.notice !== undefined) provisions.output.stderr(definition.shell.notice);
  const { default: handler } = await definition.load();
  return provisions.sdkWarnings.run(async (sdkWarnings) => runHandler(handler, args, await cliCallContext(definition, args, provisions, sdkWarnings)));
}
