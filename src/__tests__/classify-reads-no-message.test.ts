// Classification reads an error's code and nothing else: an error whose
// message can't even be read is classified, and the modules that classify
// (exit-codes.ts, error-codes.ts) never read a message, which the source
// itself shows.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { classifyError } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { DustRequiredError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { installedCommands } from '../lib/installed-commands.ts';

/** `error` with a message getter that throws, as an object from a broken bridge can have. */
function unreadable<E extends Error>(error: E): E {
  return Object.defineProperty(error, 'message', { get() { throw new Error('the message cannot be read'); } });
}

describe('classifying an error whose message cannot be read', () => {
  it('classifies it by its code', () => {
    const err = unreadable(new DustRequiredError('Dust not available'));
    expect(() => err.message).toThrow('the message cannot be read');
    expect(classifyError(err, installedCommands)).toStrictEqual({ errorCode: 'DUST_REQUIRED', exitCode: 5 });
  });

  it('classifies one with no code as UNKNOWN', () => {
    expect(classifyError(unreadable(new Error('Wallet file not found')), installedCommands)).toStrictEqual({ errorCode: 'UNKNOWN', exitCode: 1 });
  });
});

const CORE_LIB = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'packages', 'cli-core', 'src', 'lib');

/** Each place the source reads a property named `message`: `x.message`, `x?.message`, `x['message']`, or `{ message } = x`. */
function messageReads(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const reads = (ts.isPropertyAccessExpression(node) && node.name.text === 'message')
      || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'message')
      || (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(source) === 'message');
    if (reads) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.getText(source)}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the modules that classify', () => {
  it.each(['exit-codes.ts', 'error-codes.ts'])('%s reads no message', (name) => {
    expect(messageReads(join(CORE_LIB, name))).toStrictEqual([]);
  });

  it('would find a message read', () => {
    // The check itself, on a module that does read messages (the engine boundary).
    expect(messageReads(join(CORE_LIB, 'sdk-errors.ts')).length).toBeGreaterThan(0);
  });
});
