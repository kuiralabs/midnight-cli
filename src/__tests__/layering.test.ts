// The package layering, checked on every run of the suite: every file of src/
// has a package, and no import crosses the layering the planned split needs.

import { describe, expect, it } from 'vitest';
import { findLayeringProblems, importRule } from '../../scripts/check-layering.mjs';

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
    expect(importRule('mcp-server.ts', 'lib/run-command.ts')).toBeUndefined();
    expect(importRule('mcp-server.ts', 'lib/serve-payer.ts')).toBeUndefined();
    expect(importRule('lib/mcp/registry-tools.ts', 'lib/command-definition.ts')).toBeUndefined();
    expect(importRule('mcp-server.ts', 'lib/facade.ts')).toBe('mcp → wallet');
    expect(importRule('lib/mcp/skills.ts', 'lib/contract/runner.ts')).toBe('mcp → contract');
    expect(importRule('mcp-server.ts', 'lib/grant/prepare.ts')).toBe('mcp → grant');
  });

  it('keeps every package off the shell and the MCP server', () => {
    expect(importRule('lib/facade.ts', 'lib/run-command.ts')).toBe('wallet → shell');
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

  it('lets only an engine import the SDK', () => {
    // findLayeringProblems above finds none elsewhere; core, chain and every package are held to it alike.
    expect(importRule('lib/wallet-create.ts', 'engine/rc/derivation.ts')).toBe('wallet → engine (reach it through lib/installed-engines.ts)');
  });
});
