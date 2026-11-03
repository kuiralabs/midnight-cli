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
import { closedPort } from './helpers/closed-port.ts';
import { Effect } from 'effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { ContractScriptError, SCRIPT_PRELUDE, executeScript, rpcClientCode, scriptFailureMessage, scriptFailureOf } from '../lib/contract/runner.ts';
import { createApiError } from '../lib/ws-rpc.ts';
import { scriptFailureAtServe } from './helpers/serve-script-failure.ts';
import { classifyError } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { withEngineCode } from '@kuiralabs/midnight-cli-core/lib/sdk-errors';
import { installedCommands } from '../lib/installed-commands.ts';

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
      expect(classifyError(err, installedCommands)).toStrictEqual({ errorCode: 'NETWORK_ERROR', exitCode: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads an older mn's script, which reported its message alone", () => {
    expect(scriptFailureOf('__MN_ERROR__ "the message"\n', 1)).toStrictEqual({ message: 'the message' });
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
    expect(classifyError(err, installedCommands)).toStrictEqual({ errorCode: 'DUST_REQUIRED', exitCode: 5 });
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
    expect(classifyError(other, installedCommands)).toStrictEqual({ errorCode: 'TX_REJECTED', exitCode: 6 });
    expect(classifyError(await refused('1010: Invalid Transaction: Custom error: 115'), installedCommands)).toStrictEqual({ errorCode: 'STALE_UTXO', exitCode: 6 });
    expect(classifyError(await refused('1010: Invalid Transaction: Custom error: 170'), installedCommands)).toStrictEqual({ errorCode: 'INVALID_DUST_PROOF', exitCode: 6 });
  });
});
