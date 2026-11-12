// Where a deploy's or call's arguments come from. A circuit's arguments are
// private inputs to its proof unless the contract discloses them, so they have
// ways in that keep them off the command line: `--args-file <path>` and
// `--args -` (the standard input). `--args '<json>'` stays, for public values:
// on the command line they are in `ps`, the shell's history and an agent's
// transcript.
//
// No refusal here quotes what the arguments hold.

import { resolve } from 'node:path';
import { UsageError, readInputFile, readProcessStandardInput } from '@kuiralabs/midnight-cli-core';

/** Where arguments were given: on the command line, in a file, on the standard input, or not at all. */
export type ArgsSource = 'inline' | 'file' | 'stdin' | 'none';

/** The arguments as given, in order, and where they came from. */
export interface GivenArgs {
  args: unknown[];
  source: ArgsSource;
}

/** The `--args` value that reads the arguments from the standard input. */
export const ARGS_FROM_STDIN = '-';

/** Reads the standard input whole; absent where there is none to read (an MCP server's is its protocol channel). */
export type StdinReader = () => string;

/** The flags arguments come from: `--args` (JSON, or `-` for stdin) and `--args-file`. */
export interface ArgsFlags {
  args?: string;
  argsFile?: string;
}

/**
 * The arguments `flags` give: from `--args-file` (read from `cwd`), from the
 * standard input for `--args -` (through `readStdin`), or the JSON of
 * `--args`. An array is passed positionally, an object as its values in
 * order. Refuses both flags together, a file it can't read, `--args -` where
 * no standard input can be read, and JSON that isn't an array or an object.
 */
export function readGivenArgs(flags: ArgsFlags, cwd: string, readStdin?: StdinReader): GivenArgs {
  const { args, argsFile } = flags;
  if (args !== undefined && argsFile !== undefined) {
    throw new UsageError('Give the arguments once: --args or --args-file, not both.');
  }
  if (argsFile !== undefined) {
    const path = resolve(cwd, argsFile);
    let text: string;
    try {
      // A FIFO or a process substitution (<(…)) is read as it is written, to its end.
      text = readInputFile(path);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      throw new UsageError(`Can't read --args-file ${path}${typeof code === 'string' ? ` (${code})` : ''}: give the path of a JSON file of the arguments.`);
    }
    return { args: parseArgsJson(text, `--args-file ${path}`), source: 'file' };
  }
  if (args === ARGS_FROM_STDIN) {
    if (readStdin === undefined) {
      throw new UsageError('--args - reads the arguments from the standard input, which this caller has none of (an MCP server\'s is its protocol channel). Give them with --args-file <path>.');
    }
    return { args: parseArgsJson(readStdin(), 'the standard input (--args -)'), source: 'stdin' };
  }
  if (args === undefined || args === '') return { args: [], source: 'none' };
  return { args: parseArgsJson(args, '--args'), source: 'inline' };
}

/** JSON text as arguments: an array positionally, an object as its values in order. `from` names where it came from. */
export function parseArgsJson(text: string, from: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // JSON.parse's message quotes the text around the mistake: only where it is is said.
    const position = /position (\d+)/.exec((err as Error).message)?.[1];
    throw new UsageError(`The arguments in ${from} are not valid JSON${position === undefined ? '' : ` (at character ${position})`}. Give an array or an object of the arguments.`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') return Object.values(parsed);
  throw new UsageError(`The arguments in ${from} are JSON ${parsed === null ? 'null' : `of type ${typeof parsed}`}: give an array or an object of the arguments.`);
}

/** Reads the whole standard input of this process, waiting for a pipe's writer to finish. */
export function readProcessStdin(): string {
  return readProcessStandardInput();
}
