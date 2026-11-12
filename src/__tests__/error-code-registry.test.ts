// Error codes owned per package: each package defines its own, the installed
// packages' codes assemble into one lookup (a plugin's with them), and no code
// is defined twice.

import { describe, expect, it } from 'vitest';
import { CodeDefinitionError, defineCodeSet, defineCodes, CommandDefinitionError, commandErrorCodes, commandExitCodes, createCommandRegistry, createPackageRegistry, declaredCodes, type CommandDefinition, type CommandPackage, classifyError, ERROR_CODES } from '@kuiralabs/midnight-cli-core';
import { coreCodes, ENGINE_SYNC, EVERY_COMMAND } from '@kuiralabs/midnight-cli-core/commands';
import { chainCodes, READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { installedCommands } from '../lib/installed-commands.ts';

/** A package with no commands and no guidance: only codes. */
const codesOnly = (name: string, codes: CommandPackage['codes']): CommandPackage => ({ name, commands: [], guidance: { pieces: [] }, codes });

const PLUGIN_CODES = defineCodes([
  { code: 'PLUGIN_ORACLE_DOWN', exitCode: 4, summary: "The plugin's price oracle did not answer.", recovery: 'Retry later.' },
]);

/** An error a plugin throws, carrying its own code. */
class OracleDownError extends Error {
  readonly code = 'PLUGIN_ORACLE_DOWN';
}

describe('defineCodes', () => {
  it('refuses a code a package defines twice', () => {
    expect(() => defineCodes([
      { code: 'TWICE', exitCode: 1, summary: 'once' },
      { code: 'TWICE', exitCode: 2, summary: 'again' },
    ])).toThrow(new CodeDefinitionError('Error code "TWICE" is defined twice'));
  });
});

describe('the package registry\'s codes', () => {
  it('refuses a code two packages define', () => {
    expect(() => createPackageRegistry([
      codesOnly('one', defineCodes([{ code: 'SHARED', exitCode: 1, summary: 'from one' }])),
      codesOnly('two', defineCodes([{ code: 'SHARED', exitCode: 1, summary: 'from two' }])),
    ], [])).toThrow(new CommandDefinitionError('error code "SHARED" is defined twice'));
  });

  it('refuses a plugin that defines a code an installed package owns', () => {
    expect(() => createPackageRegistry([
      ...installedCommands.packages,
      codesOnly('plugin', defineCodes([{ code: 'WALLET_NOT_FOUND', exitCode: 3, summary: 'mine too' }])),
    ], installedCommands.globalFlags)).toThrow(new CommandDefinitionError('error code "WALLET_NOT_FOUND" is defined twice'));
  });

  it('assembles the codes of several packages, each found as its package defines it', () => {
    const registry = createPackageRegistry([codesOnly('core', coreCodes), codesOnly('chain', chainCodes)], []);
    expect(registry.code('INVALID_ARGS')).toBe(coreCodes.find((c) => c.code === 'INVALID_ARGS'));
    expect(registry.code('CHAIN_CLOCK_BEHIND')).toBe(chainCodes.find((c) => c.code === 'CHAIN_CLOCK_BEHIND'));
    expect(registry.code('WALLET_NOT_FOUND')).toBeUndefined();
  });

  it('finds every code mn has published in the installed packages, the new ones with them', () => {
    const missing = Object.values(ERROR_CODES).filter((code) => installedCommands.code(code) === undefined);
    expect(missing).toStrictEqual([]);
    expect(installedCommands.code('NO_NODE_RUNTIME')).toMatchObject({ code: 'NO_NODE_RUNTIME', exitCode: 1 });
    expect(installedCommands.code('COMMAND_FAILED')).toMatchObject({ code: 'COMMAND_FAILED', exitCode: 1 });
  });

  it('keeps every code the installed packages define in the deprecated ERROR_CODES, as it promises', () => {
    const published = new Set<string>(Object.values(ERROR_CODES));
    const defined = installedCommands.packages.flatMap((pkg) => (pkg.codes ?? []).map(({ code }) => code));
    expect(defined.filter((code) => !published.has(code))).toStrictEqual([]);
  });

  it('finds a plugin package\'s codes, and classifies its errors by them', () => {
    const registry = createPackageRegistry([...installedCommands.packages, codesOnly('plugin', PLUGIN_CODES)], installedCommands.globalFlags);
    expect(registry.code('PLUGIN_ORACLE_DOWN')).toBe(PLUGIN_CODES[0]);
    expect(classifyError(new OracleDownError('no answer'), registry)).toStrictEqual({ exitCode: 4, errorCode: 'PLUGIN_ORACLE_DOWN' });
    // Without the plugin installed, its code is no one's: the error is unclassified.
    expect(classifyError(new OracleDownError('no answer'), installedCommands)).toStrictEqual({ exitCode: 1, errorCode: 'UNKNOWN' });
  });

  it('knows no code in a registry made from bare commands', () => {
    expect(createCommandRegistry([], []).code('INVALID_ARGS')).toBeUndefined();
  });
});

/** A command that declares `codes` (and `outcomes`), in a package of its own. */
const declaring = (codes: CommandDefinition['errors']['codes'], outcomes?: CommandDefinition['errors']['outcomes']): CommandDefinition => ({
  name: 'declaring',
  order: 9_999,
  flags: [],
  needsWalletSdk: false,
  shell: {},
  errors: { codes, ...(outcomes === undefined ? {} : { outcomes }) },
  load: async () => ({ default: async () => {} }),
});
const withCommand = (command: CommandDefinition, codes: CommandPackage['codes'] = []): CommandPackage => ({ name: 'declaring', commands: [command], guidance: { pieces: [] }, codes });

describe('the codes a definition declares', () => {
  it('spreads the sets it names, in the order declared', () => {
    expect(declaredCodes(declaring([READS_CHAIN, 'CHAIN_CLOCK_BEHIND', ENGINE_SYNC]))).toStrictEqual([
      'UNSUPPORTED_LEDGER', 'LOCAL_STACK_UNREACHABLE', 'CHAIN_CLOCK_BEHIND', 'NETWORK_ERROR', 'SYNC_TIMEOUT', 'STALE_CACHE', 'WALLET_BEHIND_FORK',
    ]);
  });

  it('refuses a code no installed package defines', () => {
    expect(() => createPackageRegistry([codesOnly('core', coreCodes), withCommand(declaring(['PLUGIN_ORACLE_DOWN']))], []))
      .toThrow(new CommandDefinitionError('declaring declares PLUGIN_ORACLE_DOWN, which no installed package defines'));
    // Installed with the plugin that defines it, the same declaration holds.
    expect(createPackageRegistry([codesOnly('core', coreCodes), withCommand(declaring(['PLUGIN_ORACLE_DOWN']), PLUGIN_CODES)], []).code('PLUGIN_ORACLE_DOWN')).toBe(PLUGIN_CODES[0]);
  });

  it('refuses a code every command can end with, and a code declared twice', () => {
    expect(() => createPackageRegistry([codesOnly('core', coreCodes), withCommand(declaring(['CANCELLED']))], []))
      .toThrow(new CommandDefinitionError('declaring declares CANCELLED, which every command can end with'));
    expect(() => createPackageRegistry([codesOnly('core', coreCodes), withCommand(declaring([ENGINE_SYNC, 'NETWORK_ERROR']))], []))
      .toThrow(new CommandDefinitionError('declaring: error code "NETWORK_ERROR" is defined twice'));
  });

  it("shows a command's codes in the code tables' order, and its exit codes from them, every command's and its outcomes", () => {
    const registry = createPackageRegistry([codesOnly('core', coreCodes), codesOnly('chain', chainCodes), withCommand(declaring([READS_CHAIN, ENGINE_SYNC], [{ exitCode: 9, when: 'it says so' }]))], []);
    const command = registry.find('declaring')!;
    expect(commandErrorCodes(registry, command).map((definition) => [definition.code, definition.exitCode])).toStrictEqual([
      ['NETWORK_ERROR', 4], ['SYNC_TIMEOUT', 4], ['WALLET_BEHIND_FORK', 4], ['STALE_CACHE', 6], ['UNSUPPORTED_LEDGER', 4], ['LOCAL_STACK_UNREACHABLE', 4],
    ]);
    // Success, its codes' (4, 6), every command's (INVALID_ARGS 2, CANCELLED 7, the rest 1), and its outcome's.
    expect(commandExitCodes(registry, command)).toStrictEqual([0, 1, 2, 4, 6, 7, 9]);
  });

  it('refuses two sets of codes with one name', () => {
    const other = defineCodeSet('chain', ['CHAIN_CLOCK_BEHIND']);
    expect(() => createPackageRegistry([codesOnly('core', coreCodes), codesOnly('chain', chainCodes), withCommand(declaring([READS_CHAIN])), {
      name: 'second', commands: [{ ...declaring([other]), name: 'second', order: 9_998 }], guidance: { pieces: [] },
    }], [])).toThrow(new CommandDefinitionError('two code sets are named "chain"'));
  });

  it('names five codes every command can end with, all defined by core', () => {
    expect([...EVERY_COMMAND]).toStrictEqual(['INVALID_ARGS', 'CANCELLED', 'UNKNOWN', 'UNSUPPORTED_NODE', 'NO_STATE_ROOT']);
    for (const code of EVERY_COMMAND) expect(coreCodes.some((definition) => definition.code === code), code).toBe(true);
  });
});
