// How a generated contract script reports failure: its prelude turns any
// error (a rejected top-level await included) into one marked stderr line, and
// mn reports that line, not the progress, warnings and source dump around it.
// The prelude runs for real in a child Node process.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { closedPort } from '../../../../test-support/closed-port.ts';
import { Effect } from 'effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { ContractScriptError, SCRIPT_ERROR_MARKER, SCRIPT_PRELUDE, executeScript, rpcClientCode, scriptFailureMessage, scriptFailureOf, scriptRuntime } from '../lib/contract/runner.ts';
import { scriptFailureAtServe } from './helpers/serve-script-failure.ts';
import { classifyError, createApiError, OPERATOR_REJECTED_MESSAGE } from '@kuiralabs/midnight-cli-core';
import { ProofTimeoutError, withEngineCode } from '@kuiralabs/midnight-cli-core/engine';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';
import { contractCodes } from '../commands/contract.codes.ts';
import { codeRegistry } from '../../../../test-support/core-codes.ts';

// What the shell classifies a contract run's errors by: core's codes and contract's.
const CONTRACT_CODES = codeRegistry(coreCodes, contractCodes);

function runScript(body: string): { stderr: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'mn-script-'));
  try {
    const file = join(dir, 'script.mjs');
    writeFileSync(file, SCRIPT_PRELUDE + body);
    const r = spawnSync('node', [file], { encoding: 'utf-8' });
    return { stderr: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated script failures', () => {
  it('reports a rejected top-level await as the error alone, without the warning before it', () => {
    const { stderr, status } = runScript(`
process.stderr.write('Warning: No witnesses module found — using vacant witnesses. Searched:\\n  - dist/witnesses.js\\n');
process.stderr.write('Deploying contract...\\n');
await Promise.reject(new TypeError('Expected an input string with byte length of 32, got 4.'));
`);
    expect(status).toBe(1);
    expect(scriptFailureMessage(stderr, status)).toBe('Expected an input string with byte length of 32, got 4.');
  });

  it('reports a thrown error the same way', () => {
    const { stderr, status } = runScript(`throw new Error('No contract found at address ab');`);
    expect(scriptFailureMessage(stderr, status)).toBe('No contract found at address ab');
  });

  it('reads a long error intact (the runner keeps stderr whole, however the pipe split it)', () => {
    const long = 'x'.repeat(5_000);
    const { stderr, status } = runScript(`throw new Error('${long}');`);
    expect(scriptFailureMessage(stderr, status)).toBe(long);
  });

  it('falls back to the whole stderr, then the exit code, when the script reported nothing', () => {
    expect(scriptFailureMessage('Segmentation fault\n', 139)).toBe('Segmentation fault');
    expect(scriptFailureMessage('', 2)).toBe('Script exited with code 2');
  });

  it('reports the code its failure carries beside the message', () => {
    const { stderr, status } = runScript(`throw Object.assign(new Error('Dust not available'), { code: 'DUST_REQUIRED' });`);
    expect(scriptFailureOf(stderr, status)).toStrictEqual({ message: 'Dust not available', code: 'DUST_REQUIRED' });
    expect(scriptFailureOf(runScript(`throw new Error('no code');`).stderr, 1)).toStrictEqual({ message: 'no code' });
  });

  it('reports a connection it could not make as NETWORK_ERROR, and a code it carries before that', async () => {
    const refused = runScript(`throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6300'), { code: 'ECONNREFUSED' });`);
    expect(scriptFailureOf(refused.stderr, refused.status)).toStrictEqual({ message: 'connect ECONNREFUSED 127.0.0.1:6300', code: 'NETWORK_ERROR' });
    // fetch says only "fetch failed"; its cause is the socket's ECONNREFUSED.
    const fetched = runScript(`await fetch('http://127.0.0.1:${await closedPort()}/');`);
    expect(scriptFailureOf(fetched.stderr, fetched.status)).toStrictEqual({ message: 'fetch failed', code: 'NETWORK_ERROR' });
    const served = runScript(`throw Object.assign(new Error('the WebSocket said a network error'), { code: 'DUST_REQUIRED' });`);
    expect(scriptFailureOf(served.stderr, served.status)).toStrictEqual({ message: 'the WebSocket said a network error', code: 'DUST_REQUIRED' });
  });

  it("reports mn serve out of reach as NETWORK_ERROR, from the script's own RPC client", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-script-unserved-'));
    try {
      const wsModule = pathToFileURL(createRequire(import.meta.url).resolve('ws')).href;
      const script = SCRIPT_PRELUDE + rpcClientCode(await closedPort(), wsModule) + 'await rpcConnect();\n';
      const err = await executeScript({ dir, script, overlaySdk: false, packages: { packages: [], packageFolder: () => null, set: 'rc' } }).then(
        () => { throw new Error('expected the script to fail'); },
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(ContractScriptError);
      expect(err.message).toMatch(/^Cannot connect to mn serve at ws:\/\/127\.0\.0\.1:\d+: connect ECONNREFUSED/);
      expect(classifyError(err, CONTRACT_CODES)).toStrictEqual({ errorCode: 'NETWORK_ERROR', exitCode: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads an older mn's script, which reported its message alone", () => {
    expect(scriptFailureOf('__MN_ERROR__ "the message"\n', 1)).toStrictEqual({ message: 'the message' });
  });

  it('gives the error the runner rejects with the code its marked line carries', () => {
    expect(new ContractScriptError(scriptFailureOf(`${SCRIPT_ERROR_MARKER} {"message":"refused","code":"PROOF_FAILURE"}\n`, 1)).code).toBe('PROOF_FAILURE');
  });
});

// The whole way a failure at mn serve takes, run for real: helpers/serve-script-failure.ts.
describe("a failure at mn serve, across the wire and the script's process", () => {
  const failedRun = scriptFailureAtServe;

  it("carries the connector's Dust refusal as DUST_REQUIRED, in the connector's words", async () => {
    const message = "Not enough Dust available for this transaction's fee: the wallet has 0.35 DUST and the fee takes 2.00.";
    const err = await failedRun(() => createApiError('InternalError', message, 'DUST_REQUIRED'));
    expect(err).toBeInstanceOf(ContractScriptError);
    expect(err.message).toBe(message);
    expect(classifyError(err, CONTRACT_CODES)).toStrictEqual({ errorCode: 'DUST_REQUIRED', exitCode: 5 });
  });

  it("carries a node's refusal by its reason (approved Y54: one with no rule's words was UNKNOWN)", async () => {
    const refused = async (reason: string) => {
      const sdkFailure = Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error(reason) })));
      const thrown = await sdkFailure.catch((e: Error) => e);
      // As the connector answers: its own words over the SDK's error, marked with mn's code.
      return failedRun(() => withEngineCode(new Error(`Transaction submission failed: [SubmissionError] Transaction submission error → ${reason}`, { cause: thrown })));
    };
    const other = await refused('1010: Invalid Transaction: Custom error: 199');
    expect(other.message).toBe('Transaction submission failed: [SubmissionError] Transaction submission error → 1010: Invalid Transaction: Custom error: 199');
    expect(classifyError(other, CONTRACT_CODES)).toStrictEqual({ errorCode: 'TX_REJECTED', exitCode: 6 });
    expect(classifyError(await refused('1010: Invalid Transaction: Custom error: 115'), CONTRACT_CODES)).toStrictEqual({ errorCode: 'STALE_UTXO', exitCode: 6 });
    expect(classifyError(await refused('1010: Invalid Transaction: Custom error: 170'), CONTRACT_CODES)).toStrictEqual({ errorCode: 'INVALID_DUST_PROOF', exitCode: 6 });
  });
});

// The error-code parity table's rows for a contract script and a contract run
// (src/__tests__/error-code-parity.test.ts lists every typed error where mn
// throws it; these are the contract runner's own), each with what mn reported
// before codes were owned per package (a record) and what it reports.
describe('a contract script and a contract run, in the error-code parity table', () => {
  /** What the runner rejects with when a generated script, its prelude first, runs `body` and fails. */
  async function scriptFailing(body: (port: number) => string): Promise<never> {
    const dir = mkdtempSync(join(tmpdir(), 'mn-code-parity-script-'));
    try {
      const wsModule = pathToFileURL(createRequire(import.meta.url).resolve('ws')).href;
      const port = await closedPort();
      await executeScript({ dir, script: SCRIPT_PRELUDE + rpcClientCode(port, wsModule) + body(port), overlaySdk: false, packages: { packages: [], packageFolder: () => null, set: 'rc' } });
      throw new Error('expected the script to fail');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** The connector's answer to a submission the node refused with `reason`: its own words over the SDK's error, marked with mn's code. */
  const connectorRefusal = async (reason: string) => {
    const failure = Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error(reason) })));
    const thrown = await failure.catch((e: Error) => e);
    return withEngineCode(new Error(`Transaction submission failed: [SubmissionError] Transaction submission error → ${reason}`, { cause: thrown }));
  };
  /** What the function throws; fails the test when it throws nothing. */
  async function thrownBy(run: () => unknown): Promise<Error> {
    try {
      await run();
    } catch (err) {
      return err as Error;
    }
    throw new Error('expected it to throw');
  }

  type Classified = { errorCode: string; exitCode: number };
  const as = (errorCode: string, exitCode: number): Classified => ({ errorCode, exitCode });
  /** [where it is thrown, how to throw it, what mn reported before codes were owned per package (a record), what it reports]. */
  type Row = [string, () => unknown, Classified, Classified];
  const ROWS: Row[] = [
    // Connections a contract script could not make, named where they are met.
    ['a contract script that cannot reach mn serve', () => scriptFailing(() => 'await rpcConnect();\n'), as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],
    ["a contract script's fetch failing (approved Y53: was UNKNOWN)", () => scriptFailing((port) => `await fetch('http://127.0.0.1:${port}/');\n`), as('UNKNOWN', 1), as('NETWORK_ERROR', 4)],
    // Balance: exit 5.
    ['a contract run short of Dust at mn serve', () => scriptFailureAtServe(() => createApiError('InternalError', "Not enough Dust available for this transaction's fee: the wallet has 0.35 DUST and the fee takes 2.00.", 'DUST_REQUIRED')).then((err) => { throw err; }), as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
    // A contract run: the connector at mn serve, the wire, and the script's process.
    ['a contract run the node refused at mn serve (approved Y54: was UNKNOWN)', async () => { const refusal = await connectorRefusal('1010: Invalid Transaction: Custom error: 199'); return scriptFailureAtServe(() => refusal).then((err) => { throw err; }); }, as('UNKNOWN', 1), as('TX_REJECTED', 6)],
    ['a contract run refused a spent coin at mn serve', async () => { const refusal = await connectorRefusal('1010: Invalid Transaction: Custom error: 115'); return scriptFailureAtServe(() => refusal).then((err) => { throw err; }); }, as('STALE_UTXO', 6), as('STALE_UTXO', 6)],
    ['a contract run whose proof timed out at mn serve (approved Y54: was UNKNOWN)', () => scriptFailureAtServe(() => new ProofTimeoutError()).then((err) => { throw err; }), as('UNKNOWN', 1), as('PROOF_TIMEOUT', 6)],
    ['a contract run the operator refused at mn serve', () => scriptFailureAtServe(() => createApiError('Rejected', OPERATOR_REJECTED_MESSAGE, 'TX_REJECTED')).then((err) => { throw err; }), as('TX_REJECTED', 6), as('TX_REJECTED', 6)],
    // General: exit 1.
    ['no Node.js for a contract script (approved: was UNKNOWN)', () => scriptRuntime({ execPath: '/opt/bun/bin/bun', isNode: false }, ''), as('UNKNOWN', 1), as('NO_NODE_RUNTIME', 1)],
  ];

  it.each(ROWS)('%s', async (_where, throwIt, _before, now) => {
    expect(classifyError(await thrownBy(throwIt), CONTRACT_CODES)).toStrictEqual(now);
  });

  it('marks every row whose code changed as approved', () => {
    const changed = ROWS.filter(([, , before, now]) => before.errorCode !== now.errorCode || before.exitCode !== now.exitCode);
    expect(changed.length).toBeGreaterThan(0);
    for (const [where] of changed) expect(where).toMatch(/\(approved\b/);
  });
});

// Regression: midnight-js 5 reports a provider's failure as its own
// ProviderFailedError and keeps only the provider error's message on `cause`,
// so a deploy short of Dust at mn serve came back UNKNOWN (exit 1) instead of
// DUST_REQUIRED (exit 5), its message replaced by the wrapper's.
describe("mn serve's refusal through midnight-js's provider wrapper", () => {
  const DUST_SHORT = "Not enough Dust available for this transaction's fee: the wallet has 0.16 DUST and the fee takes 1.20. Its registered NIGHT generates the rest in about 3 minutes.";

  it("is reported as mn serve's refusal: its message and its code", async () => {
    const err = await scriptFailureAtServe(() => createApiError('InternalError', DUST_SHORT, 'DUST_REQUIRED'), { wrapped: true });
    expect(err).toBeInstanceOf(ContractScriptError);
    expect(err.message).toBe(DUST_SHORT);
    expect(classifyError(err, CONTRACT_CODES)).toStrictEqual({ errorCode: 'DUST_REQUIRED', exitCode: 5 });
  });
});
