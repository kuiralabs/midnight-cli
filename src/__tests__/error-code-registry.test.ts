// Error codes owned per package: each package defines its own, the installed
// packages' codes assemble into one lookup (a plugin's with them), and no code
// is defined twice.

import { describe, expect, it } from 'vitest';
import { CodeDefinitionError, defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { CommandDefinitionError, createCommandRegistry, createPackageRegistry, type CommandPackage } from '@kuiralabs/midnight-cli-core/lib/command-definition';
import { classifyError, ERROR_CODES } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands/core.codes';
import { chainCodes } from '@kuiralabs/midnight-chain/commands/chain.codes';
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
