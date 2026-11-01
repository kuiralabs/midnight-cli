// One call, one context (spec §4.4, D21, plan 2F). Every handler gets the
// context of its call: its cancellation signal, where its output goes, its
// progress, its diagnostics, where the SDK's warnings go, its configuration,
// and the payer and protectors its caller gives. Nothing about a call lives in
// a module global, so two calls in one process cannot mix. The context reaches
// libraries as explicit parameters, never as ambient per-call storage.
//
// The CLI builds one from the process's streams, its signal and --verbose
// (lib/command-dispatch.ts); the MCP server builds one per request
// (lib/run-command.ts). Since 2F's S1 the shape is final; progress and the SDK
// warnings still reach today's module-level targets until S3 and S5 make them
// the call's own.

import { isVerbose, type ParsedArgs } from './argv.ts';
import { CancelledError } from './errors.ts';
import type { Payer } from './payer.ts';
import { settings, type Settings } from './settings.ts';
import { hostPaths, type HostPaths } from './state-root.ts';
import { notice } from './notices.ts';
import { verboseLine } from './verbose.ts';
import { onSdkWarning } from './sdk-warnings.ts';
import { getActiveSpinner, silentSpinner, start as startSpinner, type Spinner } from '../ui/spinner.ts';

/** Where a call's output goes. */
export interface CallOutput {
  /**
   * The call's JSON result. A call has one: a second throws. The CLI writes it
   * at once as one line on stdout; the MCP server keeps it as the tool's result.
   */
  result(data: Readonly<Record<string, unknown>>): void;
  /** Text for the person, as the CLI prints on stdout. The MCP server sends it to its stderr, never the protocol channel. */
  stdout(text: string): void;
  /** Text for the person beside the result (progress, warnings): stderr, for the CLI and the MCP server alike. */
  stderr(text: string): void;
}

/** Where a runner sends what a call's output is given. */
export interface OutputSink {
  result(data: Readonly<Record<string, unknown>>): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** A call's progress: the spinners of its steps, and what they say to the caller. */
export interface CallProgress {
  /** Starts a spinner for a step. */
  start(message: string): Spinner;
  /** A spinner that shows nothing (`--json`); what it would say still reaches the caller. */
  silent(): Spinner;
  /** The call's spinner that is running now, if any. */
  active(): Spinner | null;
}

/** A call's diagnostics: whether it is verbose, and where its lines go. */
export interface CallDiagnostics {
  /** --verbose was given. */
  readonly isVerbose: boolean;
  /** One timestamped diagnostic line; shown only when verbose. */
  line(phase: string, message: string): void;
}

type SdkWarningListener = (tag: string, message: string) => void;

/** Where the SDK's transient warnings go while the call runs the SDK. */
export interface CallSdkWarnings {
  /** Sends them to `listener` until the returned function is called; with none, they are only kept off the terminal. */
  listen(listener: SdkWarningListener | undefined): () => void;
}

/** A call's configuration, read when the call starts (decision 1: host-set until phase 3). */
export interface CallConfig {
  readonly settings: Settings;
  readonly paths: HostPaths;
}

/**
 * The context of one call. `Protector` is what `wallet protect` runs (the
 * wallet package defines it, D24); other commands never look at it.
 */
export interface CallContext<Protector = unknown> {
  /** The call's cancellation, always present. */
  readonly signal: AbortSignal;
  readonly output: CallOutput;
  readonly progress: CallProgress;
  readonly diagnostics: CallDiagnostics;
  readonly sdkWarnings: CallSdkWarnings;
  readonly config: CallConfig;
  /** What a command that submits a transaction pays with, when its caller gives one. */
  readonly payer?: Payer;
  /** What `wallet protect` seals besides the wallets, when its caller gives them. */
  readonly protectors?: readonly Protector[];
}

/** What a handler may return: the exit code its call ends with, which the shell sets. */
export interface CommandOutcome {
  readonly exitCode: number;
}

/** A command's handler. */
export type CommandHandler<Protector = unknown> = (args: ParsedArgs, ctx: CallContext<Protector>) => Promise<CommandOutcome | void>;

/** Thrown when a call writes a second result: a call has one. */
export class SecondResultError extends Error {
  constructor() {
    super('This call already wrote its result: a call has one.');
    this.name = 'SecondResultError';
    Object.setPrototypeOf(this, SecondResultError.prototype);
  }
}

/** A call's output over `sink`: one result at most, each piece passed on as it comes. */
export function callOutput(sink: OutputSink): CallOutput {
  let hasResult = false;
  return {
    result(data) {
      if (hasResult) throw new SecondResultError();
      hasResult = true;
      sink.result(data);
    },
    stdout: (text) => sink.stdout(text),
    stderr: (text) => sink.stderr(text),
  };
}

/** Diagnostics that show their lines through `write` when the call is verbose. */
export function callDiagnostics(verbose: boolean, write: (line: string) => void): CallDiagnostics {
  return {
    isVerbose: verbose,
    line(phase, message) {
      if (verbose) write(verboseLine(phase, message));
    },
  };
}

/** The configuration the host gives now: its settings and its paths. */
export function hostCallConfig(): CallConfig {
  return { settings: settings(), paths: hostPaths() };
}

/** What a runner gives a call; the rest of its context comes from the host. */
export interface CallParts<Protector = unknown> {
  readonly args: ParsedArgs;
  readonly signal: AbortSignal;
  readonly output: OutputSink;
  readonly payer?: Payer;
  readonly protectors?: readonly Protector[];
}

/** The context of one call, from what its runner gives. */
export function createCallContext<Protector = unknown>(parts: CallParts<Protector>): CallContext<Protector> {
  return {
    signal: parts.signal,
    output: callOutput(parts.output),
    // Today's progress target and active spinner, until S3 makes them the call's.
    progress: { start: startSpinner, silent: silentSpinner, active: getActiveSpinner },
    diagnostics: callDiagnostics(isVerbose(parts.args), notice),
    // Today's listener stack, until S5 routes the warnings per call.
    sdkWarnings: { listen: onSdkWarning },
    config: hostCallConfig(),
    ...(parts.payer === undefined ? {} : { payer: parts.payer }),
    ...(parts.protectors === undefined ? {} : { protectors: parts.protectors }),
  };
}

/** Runs `handler` for the call; a call already cancelled never starts. */
export async function runHandler<Protector>(handler: CommandHandler<Protector>, args: ParsedArgs, ctx: CallContext<Protector>): Promise<CommandOutcome | void> {
  if (ctx.signal.aborted) throw new CancelledError();
  return handler(args, ctx);
}
