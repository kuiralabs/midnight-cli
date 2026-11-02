// The unknown-flag refusal. The CLI rejects any flag a command doesn't accept
// before the command runs: an unrecognised flag used to be silently ignored, so
// a typo or a malformed argument fell back to defaults (for endpoints, a
// different chain). So is a flag that belongs to another subcommand of the
// command (`mn dust register --seed x` ignored the seed). The accepted flags
// come from the command registry: each command's definition, and the
// registry's global flags.

import { type ParsedArgs } from './argv.ts';
import type { CommandRegistry, FlagDefinition } from './command-definition.ts';
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

/**
 * Flags on the command line that the command accepts but its subcommand
 * doesn't read, with the subcommands that do, in the order given. None when
 * the subcommand is missing or not one of the command's: the handler reports
 * that.
 */
export function findMisplacedFlags(args: ParsedArgs, registry: FlagRegistry): Array<{ flag: string; subcommands: readonly string[] }> {
  const definition = args.command === undefined ? undefined : registry.find(args.command);
  if (definition === undefined || args.subcommand === undefined) return [];
  const subcommand = definition.subcommandAliases?.[args.subcommand] ?? args.subcommand;
  if (!definition.subcommands?.includes(subcommand)) return [];
  const byName = new Map<string, FlagDefinition>(definition.flags.map((flag) => [flag.name, flag]));
  return Object.keys(args.flags).flatMap((name) => {
    const scope = byName.get(name)?.subcommands;
    return scope === undefined || scope.includes(subcommand) ? [] : [{ flag: name, subcommands: scope }];
  });
}

const shown = (flag: string): string => (flag.length === 1 ? `-${flag}` : `--${flag}`);

/** Throw a UsageError naming every flag the command doesn't accept, or else every one its subcommand doesn't read. */
export function assertKnownFlags(args: ParsedArgs, registry: FlagRegistry): void {
  const unknown = findUnknownFlags(args, registry);
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown flag${unknown.length > 1 ? 's' : ''} for "midnight ${args.command}": ${unknown.map(shown).join(', ')}\n` +
      `Run "midnight help ${args.command}" for the flags it accepts.`,
    );
  }
  const misplaced = findMisplacedFlags(args, registry);
  if (misplaced.length > 0) {
    const listed = misplaced.map(({ flag, subcommands }) => `${shown(flag)} (only for ${subcommands.join(', ')})`).join(', ');
    throw new UsageError(
      `Not a flag of "midnight ${args.command} ${args.subcommand}": ${listed}\n` +
      `Run "midnight help ${args.command}" for the flags each subcommand takes.`,
    );
  }
}
