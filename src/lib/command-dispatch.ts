// The CLI's dispatch, from the command registry (plan 2C): which command runs,
// what the shell gives its handler, and whether it needs the wallet SDK. The
// shell (src/wallet.ts) owns the process: it passes in what a handler may be
// given and where a notice goes, and decides the heap and the exit.

import type { ParsedArgs } from './argv.ts';
import type { CommandDefinition, CommandRegistry } from './command-definition.ts';
import { UsageError } from './errors.ts';
import type { Payer } from './payer.ts';
import type { WalletProtector } from './wallet-protector.ts';

/** What the shell can give a handler, as its definition's `shell` field asks. Payer and protectors load only when asked for. */
export interface ShellProvisions {
  readonly signal: AbortSignal;
  readonly loadPayer: () => Promise<Payer>;
  readonly loadProtectors: () => Promise<readonly WalletProtector[]>;
  /** Where a definition's notice is written, before its handler loads. */
  readonly writeNotice: (text: string) => void;
}

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

/** The context a handler gets: the payer or the protectors, when its definition asks for them. */
async function handlerContext(definition: CommandDefinition, provisions: ShellProvisions): Promise<object | undefined> {
  const { payer, protectors } = definition.shell;
  if (payer !== true && protectors !== true) return undefined;
  return {
    ...(payer === true ? { payer: await provisions.loadPayer() } : {}),
    ...(protectors === true ? { protectors: await provisions.loadProtectors() } : {}),
  };
}

/**
 * Runs the command named by `name` with `args`: refuses it when its
 * definition says it is unavailable, writes its notice, loads its handler
 * and calls it with the signal and context its definition asks for.
 */
export async function dispatchCommand(registry: CommandRegistry, name: string, args: ParsedArgs, provisions: ShellProvisions): Promise<void> {
  const definition = findInstalledCommand(registry, name);
  if (definition.shell.unavailable !== undefined) throw new Error(definition.shell.unavailable);
  if (definition.shell.notice !== undefined) provisions.writeNotice(definition.shell.notice);
  const { default: handler } = await definition.load();
  const signal = definition.shell.signal === true ? provisions.signal : undefined;
  const context = await handlerContext(definition, provisions);
  return handler(args, signal, context);
}
