// Run a command handler and capture its JSON output
// Used by the MCP server to invoke CLI commands programmatically

import { type ParsedArgs, MINIMAL_FLAG } from './argv.ts';
import type { Payer } from './payer.ts';
import { createCallContext, runHandler, type CommandHandler, type OutputSink } from './call-context.ts';
import { setProgressTarget } from '../ui/spinner.ts';

export interface CommandRun {
  /** Cancels the command; a call already cancelled never starts. None: it runs to the end. */
  signal?: AbortSignal;
  /** Each message the command's spinners say while it runs, --json mode included. */
  onProgress?: (message: string) => void;
  /** What a command that submits a transaction pays with. */
  payer?: Payer;
}

/** The server's stderr: where a call's text for the person goes (decision 3), never the protocol channel on stdout. */
const serverStderr = (text: string): void => { process.stderr.write(text); };

/**
 * Execute a command handler with --json mode, capturing the JSON result.
 *
 * The call gets a context of its own (2F): its result is kept for this call
 * alone, as JSON reads it back, so two calls that overlap never see each
 * other's result, and none reaches stdout, the MCP stdio channel. Its text for
 * the person goes to the server's stderr, which clients typically log
 * separately.
 *
 * Also opts every MCP-invoked command into agent-slim mode by injecting
 * `_minimal: true` into args.flags. Handlers that opt in (currently:
 * wallet list) emit a smaller JSON shape for agents while keeping
 * `mn <cmd> --json` (human path) byte-for-byte identical, since humans
 * never go through captureCommand. Tool handlers expose a `full: true`
 * escape hatch by setting `_full: true` in args.flags — handlers treat
 * that as "agent explicitly wants the full shape" and emit the human
 * shape instead.
 *
 * What the command's spinners say goes to `onProgress` while it runs.
 *
 * Returns the result as a JSON object ({} when the command wrote none).
 * Throws the original error if the handler throws.
 */
export async function captureCommand(
  handler: CommandHandler,
  args: ParsedArgs,
  { signal, onProgress, payer }: CommandRun = {},
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};
  const output: OutputSink = {
    // Read back as JSON, as the server sends it: what was written then, nothing the handler changes after.
    result: (data) => { result = JSON.parse(JSON.stringify(data)) as Record<string, unknown>; },
    stdout: serverStderr,
    stderr: serverStderr,
  };
  args.flags.json = true;
  if (!(MINIMAL_FLAG in args.flags)) {
    args.flags[MINIMAL_FLAG] = true;
  }
  const ctx = createCallContext({ args, signal: signal ?? new AbortController().signal, output, ...(payer === undefined ? {} : { payer }) });
  setProgressTarget(onProgress ?? null);

  try {
    await runHandler(handler, args, ctx);
    return result;
  } finally {
    setProgressTarget(null);
  }
}
