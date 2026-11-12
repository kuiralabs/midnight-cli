// A circuit's or constructor's argument the contract refuses as the wrong
// type ("abc" or 1.5 for a Uint, a Uint over its range) or a wrong count of
// them. compact-runtime throws a CompactError whose words count the context
// midnight-js passes first ("argument 1 (argument 2 as invoked from
// Typescript)"), and midnight-js reports it under its own code, which mn
// doesn't define: it came back as UNKNOWN. mn reports INVALID_ARGS, naming the
// argument once, by its position among the arguments the user gave and its
// name.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CompactError, typeError } from '@midnight-ntwrk/compact-runtime';
import { ContractExecutionError } from '@midnight-ntwrk/midnight-js-protocol';
import { classifyError, EXIT_INVALID_ARGS, UsageError } from '@kuiralabs/midnight-cli-core';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';
import { SCRIPT_PRELUDE, executeScript } from '../lib/contract/runner.ts';
import { invalidArgumentOf, namingInvalidArgument } from '../lib/contract/argument-error.ts';
import { contractCodes } from '../commands/contract.codes.ts';
import { codeRegistry } from '../../../../test-support/core-codes.ts';

const require = createRequire(import.meta.url);
const RUNTIME = pathToFileURL(require.resolve('@midnight-ntwrk/compact-runtime')).href;
const PROTOCOL = pathToFileURL(require.resolve('@midnight-ntwrk/midnight-js-protocol')).href;
const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };
const CONTRACT_CODES = codeRegistry(coreCodes, contractCodes);

/** What a circuit's generated type check throws for its first argument, as the compiler writes it. */
function typeCheckFailure(who: string, value: unknown): unknown {
  try {
    typeError(who, 'argument 1 (argument 2 as invoked from Typescript)', 'vault.compact line 21 char 1', 'Uint<0..65535>', value);
  } catch (err) {
    return err;
  }
  throw new Error('compact-runtime did not throw');
}

/** midnight-js's report of it: the CompactError under "Error executing circuit", in a ContractExecutionError. */
const executionFailure = (inner: unknown): ContractExecutionError =>
  new ContractExecutionError((inner as Error).message, { cause: new Error("Error executing circuit 'increment'", { cause: inner }) });

const VAULT = {
  name: 'vault',
  circuits: [{ name: 'increment', arguments: [{ name: 'by' }] }, { name: 'tag', arguments: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }],
};

describe('invalidArgumentOf', () => {
  it('reads a type check that failed, naming the argument once by its position among those given', () => {
    expect(invalidArgumentOf(executionFailure(typeCheckFailure('increment', 'abc'))))
      .toBe('argument 1 of increment: expected a value of type Uint<0..65535> (vault.compact line 21 char 1)');
  });

  it('reads a count of arguments, without the context midnight-js passes first', () => {
    expect(invalidArgumentOf(new CompactError('Contract state constructor: expected 2 arguments (as invoked from Typescript), received 1')))
      .toBe('Contract state constructor takes 1 argument, 0 given');
    expect(invalidArgumentOf(new CompactError('tag: expected 4 arguments (as invoked from Typescript), received 2'))).toBe('tag takes 3 arguments, 1 given');
  });

  it('leaves out a check of the context itself, a plain error with the same words, and other CompactErrors', () => {
    let context: unknown;
    try { typeError('increment', 'argument 1 (as invoked from Typescript)', 'x.compact line 1 char 1', 'CircuitContext', 1); } catch (err) { context = err; }
    expect(invalidArgumentOf(context)).toBeUndefined();
    expect(invalidArgumentOf(new Error('tag: expected 4 arguments (as invoked from Typescript), received 2'))).toBeUndefined();
    expect(invalidArgumentOf(new CompactError('failed assert: Still locked'))).toBeUndefined();
    expect(invalidArgumentOf(undefined)).toBeUndefined();
  });
});

describe('namingInvalidArgument', () => {
  const reported = (message: string) => Object.assign(new Error(message), { code: 'INVALID_ARGS' });

  it('names a circuit\'s argument once, by its position and name: INVALID_ARGS, exit 2', () => {
    const named = namingInvalidArgument(reported('argument 1 of increment: expected a value of type Uint<0..65535> (vault.compact line 21 char 1)'), VAULT, 'increment', []);
    expect(named).toBeInstanceOf(UsageError);
    expect((named as Error).message).toBe(
      "vault's circuit increment refused argument 1 (by): it is not a value of type Uint<0..65535> (vault.compact line 21 char 1). Nothing was sent or paid.",
    );
    expect((named as Error).message).not.toContain('as invoked');
    expect(classifyError(named as Error, CONTRACT_CODES)).toEqual({ errorCode: 'INVALID_ARGS', exitCode: EXIT_INVALID_ARGS });
  });

  it('names a constructor\'s argument with the names its declaration gives, and its count', () => {
    expect((namingInvalidArgument(reported('argument 1 of Contract state constructor: expected a value of type Uint<0..65536> (vault.compact line 12 char 1)'), VAULT, undefined, ['start']) as Error).message)
      .toBe("vault's constructor refused argument 1 (start): it is not a value of type Uint<0..65536> (vault.compact line 12 char 1). Nothing was sent or paid.");
    expect((namingInvalidArgument(reported('Contract state constructor takes 1 argument, 0 given'), VAULT, undefined, ['start']) as Error).message)
      .toBe("vault's constructor takes 1 argument (start); 0 were given.");
  });

  it('leaves any other failure as it is', () => {
    const other = Object.assign(new Error('Cannot connect to mn serve'), { code: 'NETWORK_ERROR' });
    expect(namingInvalidArgument(other, VAULT, 'increment', [])).toBe(other);
  });
});

describe('a contract script given an argument of the wrong type', () => {
  it('fails as INVALID_ARGS with the argument named once, the value left out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-argument-'));
    const script = `${SCRIPT_PRELUDE}
import { typeError } from ${JSON.stringify(RUNTIME)};
import { ContractExecutionError } from ${JSON.stringify(PROTOCOL)};
let refused;
try { typeError('increment', 'argument 1 (argument 2 as invoked from Typescript)', 'vault.compact line 21 char 1', 'Uint<0..65535>', 'abc'); } catch (err) { refused = err; }
throw new ContractExecutionError(refused.message, { cause: new Error("Error executing circuit 'increment'", { cause: refused }) });
`;
    try {
      const failure = await executeScript({ dir, script, overlaySdk: false, packages: NO_PACKAGES }).then(() => undefined, (e: unknown) => e);
      expect(failure).toMatchObject({ code: 'INVALID_ARGS', message: 'argument 1 of increment: expected a value of type Uint<0..65535> (vault.compact line 21 char 1)' });
      expect(classifyError(namingInvalidArgument(failure, VAULT, 'increment', []) as Error, CONTRACT_CODES)).toEqual({ errorCode: 'INVALID_ARGS', exitCode: EXIT_INVALID_ARGS });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
