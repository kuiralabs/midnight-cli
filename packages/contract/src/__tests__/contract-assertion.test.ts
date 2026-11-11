// A contract's own `assert` that fails while a script runs its circuit or
// constructor. compact-runtime throws a CompactError ("failed assert: <text>"),
// and midnight-js reports it as its ContractExecutionError, whose code mn
// doesn't define: it came back as UNKNOWN. The script here throws what
// midnight-js throws, built from the real runtime and protocol packages, and
// runs as mn runs one; mn reports CONTRACT_ASSERTION_FAILED, the runner naming
// the contract and the circuit, and saying nothing was sent or paid.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assert as compactAssert, assertDefined } from '@midnight-ntwrk/compact-runtime';
import { ContractExecutionError } from '@midnight-ntwrk/midnight-js-protocol';
import { classifyError, EXIT_INVALID_ARGS } from '@kuiralabs/midnight-cli-core';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';
import { SCRIPT_PRELUDE, executeScript } from '../lib/contract/runner.ts';
import { ContractAssertionError, failedAssertionOf, namingFailedAssertion } from '../lib/contract/assertion.ts';
import { contractCodes } from '../commands/contract.codes.ts';
import { codeRegistry } from '../../../../test-support/core-codes.ts';

const require = createRequire(import.meta.url);
const RUNTIME = pathToFileURL(require.resolve('@midnight-ntwrk/compact-runtime')).href;
const PROTOCOL = pathToFileURL(require.resolve('@midnight-ntwrk/midnight-js-protocol')).href;
const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };
const CONTRACT_CODES = codeRegistry(coreCodes, contractCodes);

/** What a circuit's assert throws, as compact-runtime throws it. */
function compactAssertion(text: string): unknown {
  try {
    compactAssert(false, text);
  } catch (err) {
    return err;
  }
  throw new Error('compact-runtime did not throw');
}

/**
 * What midnight-js throws for it: compact-js's "Error executing circuit"
 * with the CompactError as its cause, lifted into a ContractExecutionError.
 */
function executionFailure(circuit: string, text: string): ContractExecutionError {
  const assertion = compactAssertion(text) as Error;
  return new ContractExecutionError(assertion.message, { cause: new Error(`Error executing circuit '${circuit}'`, { cause: assertion }) });
}

/** A script that fails as midnight-js does when the circuit's assert fails. */
const failingScript = `${SCRIPT_PRELUDE}
import { assert } from ${JSON.stringify(RUNTIME)};
import { ContractExecutionError } from ${JSON.stringify(PROTOCOL)};
let assertion;
try { assert(false, 'Still locked'); } catch (err) { assertion = err; }
process.stderr.write('Calling withdraw...\\n');
throw new ContractExecutionError(assertion.message, { cause: new Error("Error executing circuit 'withdraw'", { cause: assertion }) });
`;

describe('failedAssertionOf', () => {
  it("reads the assert's own text from midnight-js's error, through its causes", () => {
    expect(failedAssertionOf(executionFailure('withdraw', 'Still locked'))).toBe('Still locked');
  });

  it('reads it from the CompactError itself, and from an error listing it', () => {
    expect(failedAssertionOf(compactAssertion('Nothing to lock'))).toBe('Nothing to lock');
    expect(failedAssertionOf({ message: 'two failures', errors: [new Error('other'), compactAssertion('No such escrow')] })).toBe('No such escrow');
  });

  it('is undefined for a CompactError that is no assert, and for plain errors', () => {
    let notAnAssert: unknown;
    try { assertDefined(undefined, 'coin'); } catch (err) { notAnAssert = err; }
    expect(failedAssertionOf(notAnAssert)).toBeUndefined();
    // The words alone are not enough: only compact-runtime's own error counts.
    expect(failedAssertionOf(new Error('failed assert: Still locked'))).toBeUndefined();
    expect(failedAssertionOf(undefined)).toBeUndefined();
  });

  it('stops on a cause chain that loops', () => {
    const looped = new Error('outer') as Error & { cause?: unknown };
    looped.cause = looped;
    expect(failedAssertionOf(looped)).toBeUndefined();
  });
});

describe('a contract script whose circuit fails an assert', () => {
  it('fails as CONTRACT_ASSERTION_FAILED with the assert text, which the runner names (exit 2)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-assertion-'));
    try {
      const failure = await executeScript({ dir, script: failingScript, overlaySdk: false, packages: NO_PACKAGES }).then(() => undefined, (e: unknown) => e);
      expect(failure).toMatchObject({ code: 'CONTRACT_ASSERTION_FAILED', message: 'Still locked' });

      const named = namingFailedAssertion(failure, 'escrow', 'withdraw');
      expect(named).toBeInstanceOf(ContractAssertionError);
      expect(named).toMatchObject({ contract: 'escrow', circuit: 'withdraw', assertion: 'Still locked' });
      expect((named as Error).message).toBe(
        'escrow\'s circuit withdraw refused the call: assert failed: "Still locked".\n'
        + 'Nothing was sent or paid: the contract runs on this machine before its transaction is proven or submitted, and it stopped there.',
      );
      expect(classifyError(named as Error, CONTRACT_CODES)).toEqual({ errorCode: 'CONTRACT_ASSERTION_FAILED', exitCode: EXIT_INVALID_ARGS });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names a constructor's assert as the deploy's", () => {
    const named = namingFailedAssertion(Object.assign(new Error('The limit must be above zero'), { code: 'CONTRACT_ASSERTION_FAILED' }), 'gate', undefined);
    expect(named).toMatchObject({ contract: 'gate', circuit: undefined, assertion: 'The limit must be above zero' });
    expect((named as Error).message).toMatch(/^gate's constructor refused the deploy: assert failed: "The limit must be above zero"\.\nNothing was sent or paid/);
  });

  it('leaves any other failure as it is', () => {
    const other = Object.assign(new Error('Cannot connect to mn serve'), { code: 'NETWORK_ERROR' });
    expect(namingFailedAssertion(other, 'escrow', 'withdraw')).toBe(other);
  });
});
