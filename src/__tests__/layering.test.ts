// The package layering, checked on every run of the suite: every file of src/
// has a package, and no import crosses the layering the planned split needs.

import { describe, expect, it } from 'vitest';
import { PENDING_ENGINE, findLayeringProblems, importRule } from '../../scripts/check-layering.mjs';

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

  it('lets only core\'s loader reach an engine, and an engine reach only core and chain', () => {
    expect(importRule('lib/engine.ts', 'engine/rc/index.ts')).toBeUndefined();
    expect(importRule('commands/address.ts', 'engine/rc/derive-address.ts')).toBe('wallet → engine (reach it through lib/engine.ts)');
    expect(importRule('lib/wallet-create.ts', 'engine/rc/index.ts')).toBe('wallet → engine (reach it through lib/engine.ts)');
    expect(importRule('engine/rc/derive-address.ts', 'lib/network.ts')).toBeUndefined();
    expect(importRule('engine/rc/index.ts', 'lib/facade.ts')).toBe('engine → wallet');
  });

  // Each module here still imports the SDK itself. Taking one off is the
  // point of moving it behind the engine; adding one is refused.
  it('has no module importing the SDK outside the engine but those still waiting to move', () => {
    expect([...PENDING_ENGINE].sort()).toStrictEqual([
      'commands/airdrop.ts',
      'commands/balance.ts',
      'commands/dust.ts',
      'commands/transfer.ts',
      'lib/contract/providers.ts',
      'lib/contract/runner.ts',
      'lib/dapp-connector.ts',
      'lib/dust-wallet.ts',
      'lib/facade.ts',
      'lib/fork-schedule.ts',
      'lib/grant/sealed-account.ts',
      'lib/sign-recipe.ts',
      'lib/test/prep-runner.ts',
      'lib/transfer-request.ts',
      'lib/transfer.ts',
      'lib/wallet-data-repository.ts',
      'lib/ws-rpc.ts',
    ]);
    expect(importRule('lib/wallet-create.ts', 'engine/rc/derivation.ts')).toBe('wallet → engine (reach it through lib/engine.ts)');
  });
});
