// Minimal argument parser for process.argv
// No external dependencies — raw argv parsing

import { UsageError } from './errors.ts';

export interface ParsedArgs {
  command: string | undefined;
  subcommand: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
  /**
   * Every value of a flag given more than once, in order (`flags` holds the
   * last). Only flags that repeat are here, and only when one does: read
   * them with getFlagValues.
   */
  repeated?: Record<string, Array<string | true>>;
}

/**
 * A token that starts like a flag but is a value: a negative number such as -5
 * (refused later as an amount, not taken for a flag), or a lone `-`, which
 * names the standard input (`--args -`).
 */
const isValueToken = (token: string): boolean => !token.startsWith('-') || token === '-' || /^-\d/.test(token);

/**
 * Parse process.argv into structured command, subcommand, positionals, and flags.
 * First non-flag arg = command, second = subcommand, rest = positionals.
 * --key value and --key=value pairs become flags. --key at end of argv becomes boolean true.
 */
export function parseArgs(argv?: string[]): ParsedArgs {
  const args = argv ?? process.argv.slice(2);
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const given: Record<string, Array<string | true>> = {};
  const setFlag = (key: string, value: string | true): void => {
    flags[key] = value;
    (given[key] ??= []).push(value);
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg.startsWith('--') && arg.includes('=')) {
      // --key=value: the value is everything after the first '=' (it may hold '=' itself, or be empty).
      const at = arg.indexOf('=');
      setFlag(arg.slice(2, at), arg.slice(at + 1));
      i += 1;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && isValueToken(next)) {
        setFlag(key, next);
        i += 2;
      } else {
        setFlag(key, true);
        i += 1;
      }
    } else if (!isValueToken(arg) && arg.length === 2) {
      // Short flag like -h
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next !== undefined && isValueToken(next)) {
        setFlag(key, next);
        i += 2;
      } else {
        setFlag(key, true);
        i += 1;
      }
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  const repeats = Object.entries(given).filter(([, values]) => values.length > 1);
  return {
    command: positionals[0],
    subcommand: positionals[1],
    positionals: positionals.slice(2),
    flags,
    ...(repeats.length > 0 ? { repeated: Object.fromEntries(repeats) } : {}),
  };
}

/**
 * Get a flag value as string, or undefined if not present. A flag given with
 * no value (`--network` at the end, or followed by another flag) is a usage
 * error: reading it as absent fell back to defaults, such as the configured
 * network, without a word.
 */
export function getFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} needs a value, e.g. --${name} <value>`);
  return value;
}

/**
 * Every value given for a flag that may be repeated (`--allow-origin a
 * --allow-origin b`), in order; none when it is absent. A flag given with no
 * value is a usage error, as getFlag has it.
 */
export function getFlagValues(args: ParsedArgs, name: string): string[] {
  const values = args.repeated?.[name] ?? (args.flags[name] === undefined ? [] : [args.flags[name]!]);
  return values.map((value) => {
    if (value === true) throw new UsageError(`--${name} needs a value, e.g. --${name} <value>`);
    return value;
  });
}

/**
 * Check if a flag is present (boolean or with value).
 */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return name in args.flags;
}

/**
 * Check if --verbose flag is present.
 * Note: -v is reserved for --version, so only --verbose enables verbose mode.
 */
export function isVerbose(args: ParsedArgs): boolean {
  return hasFlag(args, 'verbose');
}

/**
 * Internal flag names for the agent-slim JSON contract. See
 * lib/run-command.ts for the full contract.
 *   - MINIMAL_FLAG: captureCommand sets this on every MCP-invoked command
 *     so handlers default to a slim shape for agents.
 *   - FULL_FLAG: an MCP tool sets this when the agent passes `full: true`,
 *     telling the handler to emit the human shape instead.
 * Underscore prefix marks them as internal — humans never set these.
 */
export const MINIMAL_FLAG = '_minimal';
export const FULL_FLAG = '_full';

/**
 * True when the handler should emit the agent-slim JSON shape: an MCP
 * caller asked us through captureCommand AND didn't pass `full: true`.
 */
export function isMinimalMode(args: ParsedArgs): boolean {
  return hasFlag(args, MINIMAL_FLAG) && !hasFlag(args, FULL_FLAG);
}

/**
 * Reject `--no-cache` on commands that don't support it (write commands).
 * The SDK's fresh-sync path is too slow on hosted networks to be viable, so
 * writes always use the cache. Users who want a clean state should
 * `mn cache clear` explicitly.
 */
export function rejectNoCacheForWrites(args: ParsedArgs): void {
  if (hasFlag(args, 'no-cache')) {
    throw new Error(
      '--no-cache is not supported on write commands (transfer, airdrop, dust register, serve).\n' +
      'Writes always use the cache — the SDK\'s fresh-sync is too slow on hosted networks.\n' +
      'To reset: midnight cache clear --wallet <name> --network <name>',
    );
  }
}

/**
 * Require a flag value — throws a descriptive error if missing.
 */
export function requireFlag(args: ParsedArgs, name: string, description: string): string {
  const value = getFlag(args, name);
  if (value === undefined) {
    throw new UsageError(`Missing required flag: --${name} <${description}>`);
  }
  return value;
}
