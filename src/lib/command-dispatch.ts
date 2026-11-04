// The CLI's dispatch, from the command registry: which command runs,
// what the shell gives its handler, and whether it needs the wallet SDK. The
// shell (src/wallet.ts) owns the process: it passes in what a handler may be
// given and where a notice goes, and decides the heap and the exit.

import { type ParsedArgs, type CommandOutcome, type CallOutput, type CommandDefinition, type CommandRegistry, type CommandRun, UsageError, writeJsonResult, runCommand } from '@kuiralabs/midnight-cli-core';
import type { WalletProtector } from '@kuiralabs/midnight-wallet';

/** What the shell gives a command: its call's signal and output, the host, and the payer and protectors, loaded only for a command whose definition asks for them. */
export type ShellProvisions = CommandRun<WalletProtector> & { readonly output: CallOutput };

/** The CLI's output, written at once: the result as one line of JSON on stdout, text on stdout and stderr. */
export const processOutput: CallOutput = {
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

/**
 * Runs the command named by `name` with `args` (core's `runCommand`):
 * refuses it when its definition says it is unavailable, writes its notice,
 * loads its handler and calls it with its call's context; a call already
 * cancelled never starts. Returns the exit code the handler gives, for the
 * shell to set.
 */
export async function dispatchCommand(registry: CommandRegistry, name: string, args: ParsedArgs, provisions: ShellProvisions): Promise<CommandOutcome | void> {
  return runCommand(findInstalledCommand(registry, name), args, provisions);
}
