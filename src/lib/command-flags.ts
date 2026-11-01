// The unknown-flag refusal. The CLI rejects any flag a command doesn't accept
// before the command runs: an unrecognised flag used to be silently ignored, so
// a typo or a malformed argument fell back to defaults (for endpoints, a
// different chain). The accepted flags come from the command registry:
// each command's definition, and the registry's global flags.

import { type ParsedArgs } from './argv.ts';
import type { CommandRegistry } from './command-definition.ts';
import { UsageError } from './errors.ts';

/** The registry, as far as the refusal reads it. */
type FlagRegistry = Pick<CommandRegistry, 'find' | 'globalFlags'>;

/** Flags on the command line that the command doesn't accept, in the order given. */
export function findUnknownFlags(args: ParsedArgs, registry: FlagRegistry): string[] {
  const definition = args.command === undefined ? undefined : registry.find(args.command);
  if (definition === undefined) return []; // unknown or missing command: the dispatcher reports it
  const accepted = new Set([...registry.globalFlags, ...definition.flags].map((flag) => flag.name));
  return Object.keys(args.flags).filter((f) => !accepted.has(f));
}

/** Throw a UsageError naming every flag the command doesn't accept. */
export function assertKnownFlags(args: ParsedArgs, registry: FlagRegistry): void {
  const unknown = findUnknownFlags(args, registry);
  if (unknown.length === 0) return;
  const listed = unknown.map((f) => (f.length === 1 ? `-${f}` : `--${f}`)).join(', ');
  throw new UsageError(
    `Unknown flag${unknown.length > 1 ? 's' : ''} for "midnight ${args.command}": ${listed}\n` +
    `Run "midnight help ${args.command}" for the flags it accepts.`,
  );
}
