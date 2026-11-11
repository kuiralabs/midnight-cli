// Unknown-flag rejection. mn used to ignore any flag it didn't recognise, so a
// malformed argument (an unsplit "--network x --node y" string) was dropped
// and the command fell back to default endpoints, landing a transaction on
// the wrong chain. These tests pin the rejection, and keep the registry of
// accepted flags in lockstep with the flags each command's code really reads.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sourceFiles } from '../../scripts/check-layering.mjs';
import { join } from 'node:path';
import { parseArgs, UsageError, findUnknownFlags as findUnknownFlagsIn, findMisplacedFlags as findMisplacedFlagsIn, assertKnownFlags as assertKnownFlagsIn, type ParsedArgs } from '@kuiralabs/midnight-cli-core';
import { installedCommands } from '../lib/installed-commands.ts';

// The refusal reads the installed commands' registry, as the CLI's does.
const findUnknownFlags = (args: ParsedArgs) => findUnknownFlagsIn(args, installedCommands);
const assertKnownFlags = (args: ParsedArgs) => assertKnownFlagsIn(args, installedCommands);

describe('assertKnownFlags', () => {
  it('rejects an unsplit multi-flag argument (one token containing spaces), before anything runs', () => {
    const args = parseArgs([
      'airdrop', '100', '--shielded', '--wallet', 'alice',
      '--network undeployed --node ws://localhost:9944 --indexer-ws ws://localhost:8088/api/v4/graphql/ws',
    ]);
    let err: unknown;
    try { assertKnownFlags(args); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain('--network undeployed --node ws://localhost:9944');
    expect((err as Error).message).toContain('midnight help airdrop');
  });

  it('accepts every flag a command really reads', () => {
    const args = parseArgs([
      'airdrop', '100', '--shielded', '--wallet', 'alice', '--network', 'undeployed',
      '--node', 'ws://n', '--indexer-ws', 'ws://i', '--proof-server', 'http://p', '--verbose', '--json',
    ]);
    expect(() => assertKnownFlags(args)).not.toThrow();
  });

  it('accepts --verbose on swap, as on the other commands that open a wallet', () => {
    for (const subcommand of ['make', 'take', 'cancel', 'inspect', 'list']) {
      expect(() => assertKnownFlags(parseArgs(['swap', subcommand, '--verbose'])), subcommand).not.toThrow();
    }
  });

  it('accepts the global flags on every command', () => {
    for (const { name: command } of installedCommands.commands) {
      const args = parseArgs([command, ...installedCommands.globalFlags.map(({ name: f }) => (f.length === 1 ? `-${f}` : `--${f}`))]);
      expect(findUnknownFlags(args), command).toEqual([]);
    }
  });

  it('rejects a real flag on a command that does not use it, and names every unknown flag', () => {
    const args = parseArgs(['localnet', 'up', '--seed', 'abc', '--node', 'ws://n']);
    expect(findUnknownFlags(args)).toEqual(['seed', 'node']);
    expect(() => assertKnownFlags(args)).toThrow(/--seed.*--node|--node.*--seed/s);
  });

  it('leaves an unknown command to the dispatcher, which reports it by name', () => {
    expect(findUnknownFlags(parseArgs(['no-such-command', '--anything']))).toEqual([]);
  });
});

describe('a flag that belongs to another subcommand', () => {
  const misplaced = (...argv: string[]) => findMisplacedFlagsIn(parseArgs(argv), installedCommands);

  it('is refused, naming the subcommands it is for, before the command runs', () => {
    const args = parseArgs(['dust', 'register', '--seed', 'ab']);
    expect(findMisplacedFlagsIn(args, installedCommands)).toEqual([{ flag: 'seed', subcommands: ['export'] }]);
    expect(() => assertKnownFlags(args)).toThrow(new UsageError('Not a flag of "midnight dust register": --seed (only for export)\nRun "midnight help dust" for the flags each subcommand takes.'));
  });

  it('names every one', () => {
    expect(misplaced('wallet', 'use', 'alice', '--force', '--entropy')).toEqual([{ flag: 'force', subcommands: ['generate'] }, { flag: 'entropy', subcommands: ['seed'] }]);
  });

  it('reads an alias as its subcommand', () => {
    expect(misplaced('wallet', 'ls', '--network', 'preprod')).toEqual([]);
    expect(misplaced('wallet', 'rm', 'bob', '--force')).toEqual([{ flag: 'force', subcommands: ['generate'] }]);
  });

  it('lets through a flag its subcommand reads, and every flag of a command without subcommands', () => {
    expect(misplaced('wallet', 'list', '--network', 'preprod')).toEqual([]);
    expect(misplaced('wallet', 'info', 'bob', '--network', 'preprod')).toEqual([]);
    expect(misplaced('test', 'results', '--suite', 'e2e')).toEqual([]);
    expect(misplaced('dust', 'status', '--no-cache')).toEqual([]);
    expect(misplaced('balance', 'mn_addr_undeployed1x', '--shielded')).toEqual([]);
  });

  it('leaves a missing or unknown subcommand to the handler', () => {
    expect(misplaced('dust', '--seed', 'ab')).toEqual([]);
    expect(misplaced('dust', 'regster', '--seed', 'ab')).toEqual([]);
  });
});

describe('the accepted flags match the code', () => {
  // A flag a command reads but the registry lacks would be rejected even
  // though it works; a registry entry no code reads would be accepted and
  // silently ignored (the bug this guards against). Derive each command's
  // flags from its source and require equality.
  const LITERAL_READ = /(?:getFlagValues|getFlag|hasFlag|requireFlag)\(\s*\w+\s*,\s*['"]([a-z0-9-]+)['"]/g;
  // Shared helpers that read flags on the command's behalf.
  const HELPER_FLAGS: Record<string, string[]> = {
    // resolveNetwork also takes each endpoint from its flag before config.
    'resolveNetwork(': ['network', 'node', 'indexer-ws', 'proof-server'],
    'resolveNetworkName(': ['network'],
    'resolvePayingTarget(': ['network', 'node', 'indexer-ws', 'proof-server'],
    'networkChoiceFromArgs(': ['network', 'node', 'indexer-ws', 'proof-server'],
    // Reads the request's flags, and the network and endpoints.
    'prepareGrant(': ['backup', 'cap', 'expires-in', 'max-coin', 'per-call', 'token', 'yes', 'network', 'node', 'indexer-ws', 'proof-server', 'wallet'],
    // The swap request's terms and expiry, and the network and endpoints.
    'prepareMake(': ['give', 'give-token', 'want', 'want-token', 'expires-in', 'out', 'network', 'node', 'indexer-ws', 'proof-server'],
    'prepareTake(': ['give', 'give-token', 'want', 'want-token', 'network', 'node', 'indexer-ws', 'proof-server'],
    // The same, without the network: the handler gives it to the library function.
    'makeTermsOf(': ['give', 'give-token', 'want', 'want-token', 'expires-in', 'out'],
    'termsOf(': ['give', 'give-token', 'want', 'want-token'],
    'resolveSeedSource(': ['seed', 'wallet'],
    'resolveSeed(': ['seed', 'wallet'],
    'walletSourceOf(': ['seed', 'wallet'],
    'isVerbose(': ['verbose'],
    // The call's diagnostics are verbose when its --verbose is given: a command that writes them, or hands them to a library, reads it.
    'ctx.diagnostics.': ['verbose'],
    'rejectNoCacheForWrites(': ['no-cache'],
    'resolveTransferRequest(': ['shielded', 'force-shielded', 'wallet', 'network', 'to-file'],
    'resolveScanDir(': ['managed', 'path'],
    'resolveDappDir(': ['path'],
    'resolveContractDeployRequest(': ['path', 'managed', 'name', 'args', 'args-file', 'secret-key'],
    'resolveContractCallRequest(': ['path', 'managed', 'name', 'address', 'circuit', 'args', 'args-file'],
  };

  function flagsReadBy(source: string): Set<string> {
    const flags = new Set<string>();
    for (const m of source.matchAll(LITERAL_READ)) flags.add(m[1]!);
    for (const [call, implied] of Object.entries(HELPER_FLAGS)) {
      if (source.includes(call)) implied.forEach((f) => flags.add(f));
    }
    for (const g of installedCommands.globalFlags) flags.delete(g.name);
    return flags;
  }

  // A command's definition (<name>.definition.ts) sits beside it and is not a
  // command, nor is a package's agent guidance (<package>.guidance.ts) or its
  // error codes (<package>.codes.ts) or its registry entry (<package>.package.ts).
  // Commands sit in commands/ under src/ or a workspace package.
  const commandPaths = new Map(sourceFiles()
    .filter((f) => /\/commands\/[^/]+\.ts$/.test(f) && !f.endsWith('.definition.ts') && !f.endsWith('.guidance.ts') && !f.endsWith('.codes.ts') && !f.endsWith('.package.ts'))
    .map((f) => [basename(f), f]));
  const commandFiles = [...commandPaths.keys()];

  it('has an entry for every command file, and no entry without one', () => {
    expect(installedCommands.commands.map((c) => c.name).sort()).toEqual(commandFiles.map((f) => f.replace(/\.ts$/, '')).sort());
  });

  it.each(commandFiles.map((f) => f.replace(/\.ts$/, '')))('%s: registry equals the flags its code reads', (command) => {
    const source = readFileSync(commandPaths.get(`${command}.ts`)!, 'utf-8');
    expect(installedCommands.find(command)!.flags.map((f) => f.name).sort()).toEqual([...flagsReadBy(source)].sort());
  });
});
