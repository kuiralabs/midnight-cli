// The package layering, checked on every run of the suite: every file of src/
// has a package, and no import crosses the layering the planned split needs.
// A workspace package is imported by its entry points alone, in code, tests
// and scripts.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountImportRule, findLayeringProblems, importRule, importedModules, processCodeRule, testProblems } from '../../scripts/check-layering.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'layering');
const fromRoot = (file: string) => file.slice(ROOT.length + 1);

describe('the layering', () => {
  it('holds across src/', () => {
    const { unhomed, violations } = findLayeringProblems();
    expect(unhomed).toEqual([]);
    expect(violations.map((v) => `${v.rule}: ${v.where} ${v.specifier}`)).toEqual([]);
  });

  it('lets the shell install every package and start the MCP server', () => {
    expect(importRule('lib/installed-commands.ts', 'commands/grant.definition.ts')).toBeUndefined();
    expect(importRule('lib/installed-commands.ts', 'commands/wallet.guidance.ts')).toBeUndefined();
    expect(importRule('wallet.ts', 'lib/grant/account-protector.ts')).toBeUndefined();
    expect(importRule('wallet.ts', 'mcp-server.ts')).toBeUndefined();
  });

  it('keeps the MCP server to core, the shell and the serve payer', () => {
    expect(importRule('mcp-server.ts', 'lib/cli-host.ts')).toBeUndefined();
    expect(importRule('mcp-server.ts', 'lib/serve-payer.ts')).toBeUndefined();
    expect(importRule('lib/mcp/registry-tools.ts', 'lib/command-definition.ts')).toBeUndefined();
    expect(importRule('mcp-server.ts', 'lib/facade.ts')).toBe('mcp → wallet');
    expect(importRule('lib/mcp/skills.ts', 'lib/contract/runner.ts')).toBe('mcp → contract');
    expect(importRule('mcp-server.ts', 'lib/grant/prepare.ts')).toBe('mcp → grant');
  });

  it('keeps every package off the shell and the MCP server', () => {
    expect(importRule('lib/facade.ts', 'lib/cli-host.ts')).toBe('wallet → shell');
    expect(importRule('lib/argv.ts', 'lib/mcp/known-params.ts')).toBe('core → mcp');
    expect(importRule('commands/grant.ts', 'mcp-server.ts')).toBe('grant → mcp');
  });

  it('lets no library or other package call a command', () => {
    expect(importRule('lib/dev/deploy.ts', 'commands/contract.ts')).toBe('library → contract command');
    expect(importRule('commands/dev.ts', 'commands/contract.ts')).toBe('command → contract command');
  });

  it("lets a definition name the code sets of a package below it, and no package above's", () => {
    expect(importRule('commands/balance.definition.ts', 'commands/core.codes.ts')).toBeUndefined();
    expect(importRule('commands/balance.definition.ts', 'commands/chain.codes.ts')).toBeUndefined();
    expect(importRule('lib/command-definition.ts', 'commands/core.codes.ts')).toBeUndefined();
    expect(importRule('commands/balance.definition.ts', 'commands/grant.codes.ts')).toBe('wallet → grant');
  });

  it('lets only the shell\'s list of engines reach an engine, and an engine reach only core and chain', () => {
    expect(importRule('lib/installed-engines.ts', 'engine/rc/index.ts')).toBeUndefined();
    expect(importRule('lib/engine.ts', 'engine/rc/index.ts')).toBe('core → engine (reach it through lib/installed-engines.ts)');
    expect(importRule('commands/address.ts', 'engine/rc/derive-address.ts')).toBe('wallet → engine (reach it through lib/installed-engines.ts)');
    expect(importRule('lib/wallet-create.ts', 'engine/rc/index.ts')).toBe('wallet → engine (reach it through lib/installed-engines.ts)');
    expect(importRule('engine/rc/derive-address.ts', 'lib/network.ts')).toBeUndefined();
    expect(importRule('engine/rc/index.ts', 'lib/facade.ts')).toBe('engine → wallet');
  });

  it("lets only an engine, and core's wallet session and Dust wait, read the SDK's errors", () => {
    expect(importRule('engine/rc/transfer.ts', 'lib/sdk-errors.ts')).toBeUndefined();
    expect(importRule('engine/beta/dapp-connector.ts', 'lib/sdk-errors.ts')).toBeUndefined();
    expect(importRule('lib/wallet-session.ts', 'lib/sdk-errors.ts')).toBeUndefined();
    expect(importRule('lib/dust-wait.ts', 'lib/sdk-errors.ts')).toBeUndefined();
    expect(importRule('wallet.ts', 'lib/sdk-errors.ts')).toBe("shell → the SDK's errors (only an engine reads them)");
    expect(importRule('lib/ws-rpc.ts', 'lib/sdk-errors.ts')).toBe("connect → the SDK's errors (only an engine reads them)");
    expect(importRule('lib/exit-codes.ts', 'lib/sdk-errors.ts')).toBe("core → the SDK's errors (only an engine reads them)");
  });

  it("lets an engine install the account package, and grant reach its code only through one", () => {
    expect(accountImportRule('engine', '@kuiralabs/midnight-account-chain/owner', false)).toBeUndefined();
    expect(accountImportRule('grant', '@kuiralabs/midnight-account-chain/owner', true)).toBeUndefined();
    expect(accountImportRule('grant', '@kuiralabs/midnight-account-chain/owner', false)).toBe("grant → account chain's code (grant reaches it through the network's engine, and imports its types alone)");
    expect(accountImportRule('grant', '@kuiralabs/midnight-account', false)).toBeUndefined();
    expect(accountImportRule('wallet', '@kuiralabs/midnight-account-chain/owner', true)).toBe('wallet → account chain');
    expect(accountImportRule('core', '@kuiralabs/midnight-account', false)).toBe('core → account chain');
  });

  it("lets only the shell reach core's process code, by name or by path, and no package even through a barrel", () => {
    const CORE = join(ROOT, 'packages', 'cli-core', 'src');
    const reached = (file: string, specifier: string) => importedModules(file, { specifier, typeOnly: false, names: null })!.modules!;
    const byName = (file: string) => reached(file, '@kuiralabs/midnight-cli-core/process');
    // The shell installs the guard and takes the heap advice.
    expect(processCodeRule(join(ROOT, 'src', 'lib', 'cli-host.ts'), 'shell', byName(join(ROOT, 'src', 'lib', 'cli-host.ts')))).toBeUndefined();
    // A package by name, an engine among them.
    const facade = join(ROOT, 'packages', 'wallet', 'src', 'lib', 'facade.ts');
    expect(processCodeRule(facade, 'wallet', byName(facade))).toBe(`wallet → core's process code (only a host calls it, through "./process")`);
    const engine = join(ROOT, 'packages', 'engine-rc', 'src', 'wallet.ts');
    expect(processCodeRule(engine, 'engine', byName(engine))).toBe(`engine → core's process code (only a host calls it, through "./process")`);
    // Core's own library by path, and core's "." barrel re-exporting it.
    const host = join(CORE, 'lib', 'host.ts');
    expect(processCodeRule(host, 'core', reached(host, '../process/sdk-process-guard.ts'))).toBe(`core → core's process code (only a host calls it, through "./process")`);
    const index = join(CORE, 'index.ts');
    expect(processCodeRule(index, 'core', reached(index, './process/sync-heap.ts'))).toBe(`core → core's process code (only a host calls it, through "./process")`);
    // The entry point listing it, and the process code's own imports.
    const entry = join(CORE, 'process.ts');
    expect(processCodeRule(entry, 'core', reached(entry, './process/sdk-process-guard.ts'))).toBeUndefined();
  });

  it('lets only an engine import the SDK', () => {
    // findLayeringProblems above finds none elsewhere; core, chain and every package are held to it alike.
    expect(importRule('lib/wallet-create.ts', 'engine/rc/derivation.ts')).toBe('wallet → engine (reach it through lib/installed-engines.ts)');
  });
});

describe('a workspace package imported by its entry points', () => {
  it('refuses a deep import across packages, naming the entry points', () => {
    expect(testProblems(join(FIXTURES, 'deep-import.ts')).map((v) => `${v.rule}: ${v.where} ${v.specifier}`)).toStrictEqual([
      'deep import into @kuiralabs/midnight-cli-core (its entry points: ., ./engine, ./ui, ./commands, ./process): src/__tests__/fixtures/layering/deep-import.ts:5 @kuiralabs/midnight-cli-core/lib/errors',
    ]);
  });

  it("refuses a test reaching into another package's source by path", () => {
    expect(testProblems(join(FIXTURES, 'by-path.ts')).map((v) => `${v.rule}: ${v.where}`)).toStrictEqual([
      'test → another package by path (a test imports another package by its entry points): src/__tests__/fixtures/layering/by-path.ts:4',
    ]);
  });

  it('passes an import of an entry point', () => {
    expect(testProblems(join(FIXTURES, 'by-entry-point.ts'))).toStrictEqual([]);
  });

  it('judges an import of a barrel by the modules defining the names it imports', () => {
    const file = join(ROOT, 'src', 'lib', 'facade.ts');
    const modules = (names: { name: string; typeOnly: boolean }[] | null) =>
      importedModules(file, { specifier: '@kuiralabs/midnight-cli-core/engine', typeOnly: false, names })!.modules!.map((each) => fromRoot(each.file));
    expect(modules([{ name: 'toEngineError', typeOnly: false }])).toStrictEqual(['packages/cli-core/src/lib/sdk-errors.ts']);
    expect(modules([{ name: 'toHex', typeOnly: false }, { name: 'EngineHost', typeOnly: true }])).toStrictEqual(['packages/cli-core/src/lib/tx-serde.ts', 'packages/cli-core/src/lib/engine.ts']);
    // So a package that may not read the SDK's errors is refused them through the barrel too.
    expect(importRule('lib/facade.ts', 'lib/sdk-errors.ts')).toBe("wallet → the SDK's errors (only an engine reads them)");
    expect(modules(null)).toContain('packages/cli-core/src/lib/wallet-cache.ts');
  });
});
