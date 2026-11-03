// What a command run by a test ended with, held to what its definition
// declares: the code of an error it ends with, as the shell and the MCP server
// classify it, is one of its own (errors.codes) or one every command can end
// with. src/__tests__/declared-codes.test.ts checks the declarations against
// the code; this checks them against what the commands the tests run do.

import { expect } from 'vitest';
import { declaredCodes } from '@kuiralabs/midnight-cli-core/lib/command-definition';
import { EVERY_COMMAND } from '@kuiralabs/midnight-cli-core/commands/core.codes';
import { asReported } from '@kuiralabs/midnight-cli-core/lib/errors';
import { classifyError } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { installedCommands } from '../../lib/installed-commands.ts';

/**
 * The codes `command` can end with: its own, every command's, and
 * COMMAND_FAILED when it declares outcomes (under MCP, a handler that returns
 * a non-zero exit code fails with it).
 */
export function endableCodes(command: string): string[] {
  const definition = installedCommands.find(command);
  if (definition === undefined) throw new Error(`No installed command "${command}"`);
  return [...declaredCodes(definition), ...EVERY_COMMAND, ...(definition.errors.outcomes === undefined ? [] : ['COMMAND_FAILED'])];
}

/** Fails unless `code`, which `command` ended with, is one it can end with. */
export function expectDeclaredCode(command: string, code: unknown): void {
  expect(endableCodes(command), `${command} ended with ${String(code)}, which its definition doesn't declare`).toContain(code);
}

/** Fails unless the error `command` ended with carries a code it can end with, classified as the shell classifies it. */
export function expectDeclared(command: string, err: unknown): void {
  const reported = asReported(err instanceof Error ? err : new Error(String(err)));
  expectDeclaredCode(command, classifyError(reported, installedCommands).errorCode);
}

/** The call of `command`, its rejection checked by expectDeclared and passed on, its fulfilment as it is. */
export async function declaredOutcome<T>(command: string, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    expectDeclared(command, err);
    throw err;
  }
}

/** For an MCP tool's result: when it is an error (`error: true`), its code is one the tool's command can end with. */
export function expectDeclaredToolResult(tool: string, result: Readonly<Record<string, unknown>>): void {
  if (result.error !== true) return;
  const registered = installedCommands.tools.find((each) => each.name === tool);
  if (registered === undefined) throw new Error(`No installed tool "${tool}"`);
  expectDeclaredCode(registered.command.name, result.code);
}
