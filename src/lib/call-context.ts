// One call, one context. Every handler gets the
// context of its call: its cancellation signal, where its output goes, its
// progress, its diagnostics, where the SDK's warnings go, its configuration,
// and the payer and protectors its caller gives. Nothing about a call lives in
// a module global, so two calls in one process cannot mix. The context reaches
// libraries as explicit parameters, never as ambient per-call storage; the one
// exception is the shell's, which tags the SDK's noise with the call that
// raised it (lib/sdk-noise.ts).
//
// The CLI builds one from the process's streams, its signal and --verbose
// (lib/command-dispatch.ts); the MCP server builds one per request
// (lib/run-command.ts).

import { isVerbose, type ParsedArgs } from './argv.ts';
import { CancelledError } from './errors.ts';
import type { Payer } from './payer.ts';
import { settings, type Settings } from './settings.ts';
import { hostPaths, type HostPaths } from './state-root.ts';
import { notice } from './notices.ts';
import { verboseLine } from './verbose.ts';
import { createSdkWarningRouter, type CallSdkWarnings } from './sdk-warnings.ts';
import { createProgress, type Progress, type ProgressReport } from '../ui/spinner.ts';

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

/** A call's progress: the spinners of its steps, what they say to the caller, and which one runs now. Its own per call. */
export type CallProgress = Progress;

/** A call's diagnostics: whether it is verbose, and where its lines go. */
export interface CallDiagnostics {
  /** --verbose was given. */
  readonly isVerbose: boolean;
  /** One timestamped diagnostic line; shown only when verbose. */
  line(phase: string, message: string): void;
}

export type { CallSdkWarnings } from './sdk-warnings.ts';

/** A call's configuration, read when the call starts (set by the host). */
export interface CallConfig {
  readonly settings: Settings;
  readonly paths: HostPaths;
}

/**
 * The context of one call. `Protector` is what `wallet protect` runs (the
 * wallet package defines it); other commands never look at it.
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
  /** Where what the call's spinners say goes besides the terminal (the MCP server's progress notifications); none for the CLI. */
  readonly onProgress?: ProgressReport;
  /** Where the call's SDK warnings go, from the router of the host that runs it; none: a call of its own, which no host's filters report to. */
  readonly sdkWarnings?: CallSdkWarnings;
  readonly payer?: Payer;
  readonly protectors?: readonly Protector[];
}

/** The context of one call, from what its runner gives. */
export function createCallContext<Protector = unknown>(parts: CallParts<Protector>): CallContext<Protector> {
  return {
    signal: parts.signal,
    output: callOutput(parts.output),
    progress: createProgress(parts.onProgress),
    diagnostics: callDiagnostics(isVerbose(parts.args), notice),
    sdkWarnings: parts.sdkWarnings ?? createSdkWarningRouter().openCall().warnings,
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
