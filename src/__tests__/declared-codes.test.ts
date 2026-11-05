// Each command declares the error codes its modules can throw, no more and no
// fewer: scripts/code-reach.mjs walks its handler and everything that runs
// from it (imports, the engine parts it uses, the shell's payer and
// protectors), and every code found must be declared or one every command can
// end with, and every declared code found. The scan's tables for codes that
// are not literals in the code are held to what that code does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CUT_IMPORTS,
  DYNAMIC_CLASSES,
  DYNAMIC_MODULES,
  ENGINE_PARTS,
  codeReach,
  commandEntries,
  declaredCodeProblems,
} from '../../scripts/code-reach.mjs';
import { importTarget, importedModules, importsOf } from '../../scripts/check-layering.mjs';
import { declaredCodes, type CommandDefinition, CancelledError, CommandFailedError, DustRequiredError, TransactionRefusedError, withTransportCode } from '@kuiralabs/midnight-cli-core';
import { EVERY_COMMAND, READS_OFFERS } from '@kuiralabs/midnight-cli-core/commands';
import { refusalCodeOf, toEngineError } from '@kuiralabs/midnight-cli-core/engine';
import { ContractScriptError } from '@kuiralabs/midnight-contract';
import { PrepStepFailedError } from '@kuiralabs/midnight-dev';
import { installedCommands } from '../lib/installed-commands.ts';
import { WalletNotFoundError } from '@kuiralabs/midnight-wallet';
import { expectDeclared, expectDeclaredToolResult } from './helpers/expect-declared.ts';
import { fixtureDefinition } from './fixtures/code-reach/fixture.definition.ts';
import { barrelFixtureDefinition } from './fixtures/code-reach/barrel.definition.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'code-reach', 'fixture.definition.ts');
const BARREL_FIXTURE = join(import.meta.dirname, 'fixtures', 'code-reach', 'barrel.definition.ts');

/** The problems the check finds with `definition` declaring what it does, its entries read from its file. */
function problemsOf(definition: CommandDefinition, file: string): string[] {
  const [entry] = commandEntries([file]);
  return declaredCodeProblems(definition.name, declaredCodes(definition), codeReach(entry!.entries), EVERY_COMMAND);
}

describe('each installed command', () => {
  const entries = commandEntries();

  it('is found with its handler and what the shell gives it', () => {
    expect(entries.map((entry) => entry.name).sort()).toStrictEqual(installedCommands.commands.map((command) => command.name).sort());
    for (const command of installedCommands.commands) {
      const entry = entries.find((each) => each.name === command.name)!;
      expect(entry.provisions, command.name).toStrictEqual([
        ...(command.shell.payer === true ? ['payer'] : []),
        ...(command.shell.protectors === true ? ['protectors'] : []),
      ]);
    }
  });

  it('declares every code its modules can throw, and none they can\'t', () => {
    const problems = installedCommands.commands.flatMap((command) => {
      const entry = entries.find((each) => each.name === command.name)!;
      return declaredCodeProblems(command.name, declaredCodes(command), codeReach(entry.entries), EVERY_COMMAND);
    });
    expect(problems).toStrictEqual([]);
  });

  it('declares the exit codes its handler returns without throwing', () => {
    for (const command of installedCommands.commands) {
      const entry = entries.find((each) => each.name === command.name)!;
      // Every non-zero `return { exitCode: n }` in its handler's module.
      const returned = [...readFileSync(join(ROOT, entry.handler), 'utf8').matchAll(/return\s*\{\s*exitCode:\s*(\d+)\s*\}/g)].map((match) => Number(match[1])).filter((code) => code !== 0);
      expect((command.errors.outcomes ?? []).map((outcome) => outcome.exitCode).sort(), command.name).toStrictEqual([...new Set(returned)].sort());
    }
  });
});

describe('a definition whose handler can throw a code it does not declare', () => {
  it('is refused, the code named with the modules that reach it', () => {
    expect(problemsOf(fixtureDefinition, FIXTURE)).toStrictEqual([
      'code-reach-fixture: reaches NOT_AN_OFFER (src/__tests__/fixtures/code-reach/handler.ts → src/__tests__/fixtures/code-reach/refuses.ts), which it doesn\'t declare',
      'code-reach-fixture: reaches TERMS_MISMATCH (src/__tests__/fixtures/code-reach/handler.ts → src/__tests__/fixtures/code-reach/refuses.ts → packages/cli-core/src/lib/swap-offer.ts), which it doesn\'t declare',
    ]);
  });

  it('holds once it declares them, and is refused for a code it declares and cannot reach', () => {
    expect(problemsOf({ ...fixtureDefinition, errors: { codes: [READS_OFFERS] } }, FIXTURE)).toStrictEqual([]);
    expect(problemsOf({ ...fixtureDefinition, errors: { codes: [READS_OFFERS, 'WALLET_NOT_FOUND'] } }, FIXTURE)).toStrictEqual([
      'code-reach-fixture: declares WALLET_NOT_FOUND, which none of its modules can throw',
    ]);
  });
});

describe('a handler that imports a name through a barrel', () => {
  it('reaches the module defining that name, and none of the others the barrel lists', () => {
    expect(problemsOf(barrelFixtureDefinition, BARREL_FIXTURE)).toStrictEqual([
      'code-reach-barrel-fixture: reaches NOT_AN_OFFER (src/__tests__/fixtures/code-reach/barrel-handler.ts → src/__tests__/fixtures/code-reach/refuses.ts), which it doesn\'t declare',
      'code-reach-barrel-fixture: reaches TERMS_MISMATCH (src/__tests__/fixtures/code-reach/barrel-handler.ts → src/__tests__/fixtures/code-reach/refuses.ts → packages/cli-core/src/lib/swap-offer.ts), which it doesn\'t declare',
    ]);
  });

  it('reaches every module the barrel lists when it imports the whole barrel', () => {
    const handler = join(import.meta.dirname, 'fixtures', 'code-reach', 'barrel-handler.ts');
    const whole = importsOf(handler).map((each) => ({ ...each, names: null }));
    expect(whole.flatMap((each) => importedModules(handler, each)!.modules!.map((module) => module.file.slice(ROOT.length + 1)))).toStrictEqual([
      'src/__tests__/fixtures/code-reach/refuses.ts',
      'src/__tests__/fixtures/code-reach/unpaid.ts',
    ]);
  });
});

describe("the scan's tables", () => {
  it('name only codes the installed packages define', () => {
    for (const site of [...Object.values(DYNAMIC_CLASSES), ...Object.values(DYNAMIC_MODULES)]) {
      for (const code of site.codes) expect(installedCommands.code(code), code).toBeDefined();
    }
  });

  it("give toEngineError the codes it names an SDK or node failure by, as its engine's errors and a contract script's carry", () => {
    const failures = ['ZK proof timeout', 'Custom error: 115', 'Custom error: 170', 'chain reset detected', 'Failed to prove transaction', 'sync timed out', 'No dust available', 'Insufficient funds', 'Transaction rejected', 'fetch failed'];
    const named = new Set(failures.map((message) => (toEngineError(new Error(message)) as { code?: string }).code));
    const sdkErrors = DYNAMIC_MODULES['packages/cli-core/src/lib/sdk-errors.ts']!;
    expect(new Set(sdkErrors.codes)).toStrictEqual(named);
    expect(DYNAMIC_CLASSES.EngineError!.codes).toStrictEqual(sdkErrors.codes);
    // A script reports the code its failure carried: mn serve's (withEngineCode marks it with the same codes), or NETWORK_ERROR.
    expect(DYNAMIC_CLASSES.ContractScriptError!.codes).toStrictEqual(sdkErrors.codes);
    // The code a script's marked line carries becomes the error's (the contract package's contract-script-errors.test.ts reads one).
    expect(new ContractScriptError({ message: 'refused', code: 'PROOF_FAILURE' }).code).toBe('PROOF_FAILURE');
  });

  it("give a node's refusal its three codes, a transport failure NETWORK_ERROR, and a prep step its cause's code", () => {
    expect(new Set(['Custom error: 115', 'Custom error: 170', 'BalanceCheckOverspend'].map(refusalCodeOf))).toStrictEqual(new Set(DYNAMIC_CLASSES.TransactionRefusedError!.codes));
    expect(new TransactionRefusedError('anything').code).toBe('TX_REJECTED');
    expect((withTransportCode(new Error('fetch failed')) as { code?: string }).code).toBe('NETWORK_ERROR');
    expect(DYNAMIC_MODULES['packages/cli-core/src/lib/transport-failure.ts']!.codes).toStrictEqual(['NETWORK_ERROR']);
    expect(new PrepStepFailedError('cache-clear', new DustRequiredError('short')).code).toBe('DUST_REQUIRED');
    expect(DYNAMIC_CLASSES.PrepStepFailedError!.codes).toStrictEqual([]);
  });

  it("split each engine's assembler into the parts it puts together, every module it imports in one of them", () => {
    const parts = new Set(Object.values(ENGINE_PARTS).flat());
    for (const set of ['rc', 'beta']) {
      const index = join(ROOT, 'packages', `engine-${set}`, 'src', `${set}-engine.ts`);
      const own = importsOf(index).filter((each) => !each.typeOnly && each.specifier.startsWith('./')).map((each) => importTarget(index, each.specifier)!.slice(join(ROOT, 'packages', `engine-${set}`, 'src').length + 1));
      expect(new Set(own), set).toStrictEqual(parts);
      expect(CUT_IMPORTS.filter(([from]) => from === `packages/engine-${set}/src/${set}-engine.ts`).map(([, to]) => to.split('/').pop()).sort(), set).toStrictEqual([...parts].sort());
    }
  });
});

describe('the check of what a command a test runs ends with', () => {
  it('passes a code the command declares or every command can end with, and fails any other', () => {
    expect(() => expectDeclared('balance', new WalletNotFoundError('no alice'))).not.toThrow();
    expect(() => expectDeclared('help', new CancelledError())).not.toThrow();
    expect(() => expectDeclared('help', new Error('no code: UNKNOWN'))).not.toThrow();
    expect(() => expectDeclared('help', new WalletNotFoundError('no alice'))).toThrow('help ended with WALLET_NOT_FOUND');
  });

  it("reads a node's refusal among an error's causes, as the shell reports it", () => {
    const wrapped = new Error('deploy failed', { cause: new TransactionRefusedError('stale', { code: 'STALE_UTXO' }) });
    expect(() => expectDeclared('contract', wrapped)).not.toThrow();
    expect(() => expectDeclared('config', wrapped)).toThrow('config ended with STALE_UTXO');
  });

  it("lets COMMAND_FAILED through only for a command that declares outcomes, and checks a tool's error by its command", () => {
    expect(() => expectDeclared('test', new CommandFailedError('test', 1, {}))).not.toThrow();
    expect(() => expectDeclared('balance', new CommandFailedError('balance', 1, {}))).toThrow('balance ended with COMMAND_FAILED');
    expect(() => expectDeclaredToolResult('midnight_balance', { error: true, code: 'NETWORK_ERROR' })).not.toThrow();
    expect(() => expectDeclaredToolResult('midnight_config_get', { error: true, code: 'NETWORK_ERROR' })).toThrow('config ended with NETWORK_ERROR');
    expect(() => expectDeclaredToolResult('midnight_config_get', { network: 'undeployed' })).not.toThrow();
  });
});
