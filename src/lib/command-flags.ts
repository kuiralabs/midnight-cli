// The unknown-flag refusal. The CLI rejects any flag a command doesn't accept
// before the command runs: an unrecognised flag used to be silently ignored, so
// a typo or a malformed argument fell back to defaults (for endpoints, a
// different chain). The accepted flags come from the command registry (plan
// 2C): each command's definition, and the registry's global flags.
//
// GLOBAL_FLAGS and COMMAND_FLAGS below are superseded by the registry; removal
// waits for Y13. Nothing reads them but their tests: one keeps each equal to
// the registry, the other to the flags each command's code reads.

import { type ParsedArgs } from './argv.ts';
import type { CommandRegistry } from './command-definition.ts';
import { UsageError } from './errors.ts';

/** Accepted on every command. Superseded by the registry's globalFlags; removal waits for Y13. */
export const GLOBAL_FLAGS: readonly string[] = ['help', 'h', 'json', 'version', 'v'];

const ENDPOINTS = ['node', 'indexer-ws', 'proof-server'] as const;

/** Superseded by the registry (each definition's flags); removal waits for Y13. */
export const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'address': ['index', 'network', 'seed', 'wallet'],
  'airdrop': ['network', 'no-cache', 'shielded', 'verbose', 'wallet', ...ENDPOINTS],
  'balance': ['force-shielded', 'network', 'no-cache', 'seed', 'shielded', 'verbose', 'wallet', ...ENDPOINTS],
  'cache': ['network', 'wallet'],
  'config': ['network'],
  'contract': ['address', 'args', 'circuit', 'managed', 'name', 'network', 'path', 'secret-key', 'wallet', ...ENDPOINTS],
  'dev': [],
  'dust': ['network', 'no-cache', 'seed', 'verbose', 'wallet', ...ENDPOINTS],
  'generate': ['force', 'mnemonic', 'network', 'output', 'seed'],
  'genesis-address': ['network'],
  'grant': ['backup', 'cap', 'expires-in', 'max-coin', 'network', 'per-call', 'wallet', 'yes', ...ENDPOINTS],
  'help': ['agent', 'intro', 'no-intro'],
  'info': ['network', 'wallet'],
  'inspect-cost': ['network', ...ENDPOINTS],
  'localnet': ['tail'],
  'manual': ['no-pager', 'raw'],
  'serve': ['approve-all', 'approve-fees', 'force-shielded', 'max-fee', 'max-pending', 'network', 'no-auto-approve-reads', 'no-cache', 'port', 'verbose', 'wallet', ...ENDPOINTS],
  'status': ['all', 'network', 'watch'],
  'test': [
    'all', 'browser-mode', 'build-cmd', 'build-dir', 'force', 'goal', 'name', 'network', 'no-ai',
    'path', 'port', 'redeploy', 'screen', 'strategy', 'suite', 'url', ...ENDPOINTS],
  'transfer': ['force-shielded', 'network', 'no-cache', 'shielded', 'verbose', 'wallet', ...ENDPOINTS],
  'wallet': ['entropy', 'force', 'mnemonic', 'network', 'seed', 'wallet'],
};

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
