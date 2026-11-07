// Running a command from its definition, as a program that mounts our
// commands does: in its own command line (`runCommand`, the output the
// program gives) or as an MCP tool (`captureCommand`, the result kept as
// JSON). Both do what mn's shell and MCP server do around a handler: refuse a
// command its definition marks unavailable, write its notice, load its
// handler, give it the payer or protectors only when its definition asks for
// them, and run it as one call of the host, with SDK warnings of its own.

import { listedNames } from './agent-guidance.ts';
import { MINIMAL_FLAG, type ParsedArgs } from './argv.ts';
import { createCallContext, runHandler, type CallOutput, type CommandOutcome } from './call-context.ts';
import type { CommandDefinition, CommandRegistry, RegisteredTool } from './command-definition.ts';
import { commandOwnCodes, declaredSets } from './command-definition.ts';
import { CommandFailedError, UsageError } from './errors.ts';
import type { Host } from './host.ts';
import type { Payer } from './payer.ts';

/** A value, or what loads it: a loader is called only for a command whose definition asks for it. */
export type Provided<T> = T | (() => Promise<T>);

/** What a program gives a command it runs. */
export interface CommandRun<Protector = unknown> {
  /** The host the command runs in: its state root, settings, engines and the rest. */
  readonly host: Host;
  /** Cancels the command; a call already cancelled never starts. None: it runs to the end. */
  readonly signal?: AbortSignal;
  /** Each message the command's spinners say while it runs, in --json mode too. */
  readonly onProgress?: (message: string) => void;
  /** What a command whose definition asks for a payer pays with (contract, swap, grant, dev). */
  readonly payer?: Provided<Payer>;
  /** What `wallet protect` seals besides the wallets (grant's `accountProtector`). */
  readonly protectors?: Provided<readonly Protector[]>;
}

/** The part of a definition a run reads: what the shell does around the handler, and the handler. */
export type RunnableDefinition = Pick<CommandDefinition, 'shell' | 'load'>;

const provided = async <T>(value: Provided<T>): Promise<T> => (typeof value === 'function' ? (value as () => Promise<T>)() : value);

/**
 * Runs the command `definition` defines with `args`, its output going to
 * `run.output`; returns the exit code its handler gives, for the caller to
 * act on. Refuses a command its definition marks unavailable, and writes its
 * notice to the output's stderr before the handler loads.
 */
export async function runCommand<Protector = unknown>(definition: RunnableDefinition, args: ParsedArgs, run: CommandRun<Protector> & { readonly output: CallOutput }): Promise<CommandOutcome | void> {
  const { payer, protectors, notice, unavailable } = definition.shell;
  // Refused like an unknown command: a usage error (exit 2), where its --help shows the general help (exit 0).
  if (unavailable !== undefined) throw new UsageError(unavailable);
  if (notice !== undefined) run.output.stderr(notice);
  const { default: handler } = await definition.load();
  const given = {
    ...(payer === true && run.payer !== undefined ? { payer: await provided(run.payer) } : {}),
    ...(protectors === true && run.protectors !== undefined ? { protectors: await provided(run.protectors) } : {}),
  };
  return run.host.sdkWarnings.run((sdkWarnings) => runHandler(handler, args, createCallContext<Protector>({
    host: run.host,
    args,
    signal: run.signal ?? new AbortController().signal,
    output: run.output,
    sdkWarnings,
    ...(run.onProgress === undefined ? {} : { onProgress: run.onProgress }),
    ...given,
  })));
}

/**
 * Runs the command as an MCP tool runs it: in --json mode, agent-slim unless
 * `args` says otherwise (`_minimal`, `_full`), and returns its JSON result
 * ({} when it wrote none), as it was when written. The result is this call's
 * alone, so calls that overlap never see each other's. The command's text for
 * the person goes to `run.text` (a server's stderr, never its protocol
 * channel). Progress reaches `run.onProgress` while the command runs and never
 * after. Throws what the command throws, and CommandFailedError, carrying the
 * result, when it ends with a non-zero exit code.
 */
export async function captureCommand<Protector = unknown>(definition: RunnableDefinition, args: ParsedArgs, run: CommandRun<Protector> & { readonly text: (text: string) => void }): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};
  const output: CallOutput = {
    // Read back as JSON, as a server sends it: what was written then, nothing the handler changes after.
    result: (data) => { result = JSON.parse(JSON.stringify(data)) as Record<string, unknown>; },
    stdout: run.text,
    stderr: run.text,
  };
  args.flags.json = true;
  if (!(MINIMAL_FLAG in args.flags)) args.flags[MINIMAL_FLAG] = true;
  // The call's own progress, closed when it ends: a spinner it left running says nothing after.
  let running = true;
  const onProgress = run.onProgress;
  const report = onProgress === undefined ? undefined : (message: string): void => { if (running) onProgress(message); };
  try {
    const outcome = await runCommand(definition, args, { ...run, output, ...(report === undefined ? {} : { onProgress: report }) });
    if (outcome !== undefined && outcome.exitCode !== 0) throw new CommandFailedError(args.command ?? 'the command', outcome.exitCode, result);
    return result;
  } finally {
    running = false;
  }
}

/**
 * A tool's description as an MCP server lists it: its definition's, then the
 * codes its command can end with: its own, and the sets it declares by name.
 */
export function toolDescription(registry: Pick<CommandRegistry, 'code'>, tool: RegisteredTool): string {
  const own = commandOwnCodes(registry, tool.command).map((definition) => definition.code);
  const sets = declaredSets(tool.command).map((set) => set.name);
  if (own.length === 0 && sets.length === 0) return tool.description;
  const named = sets.length === 0 ? '' : `the ${listedNames(sets)} codes (see the skill)`;
  return `${tool.description} Errors: ${own.join(', ')}${own.length > 0 && named !== '' ? '; and ' : ''}${named}.`;
}
