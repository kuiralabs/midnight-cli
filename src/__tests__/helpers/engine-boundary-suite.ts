// What an engine hands the rest of mn when the SDK or the node fails: the
// engine contract's typed error, carrying its code, with the SDK's message (a
// node's refusal in the node's words) and the SDK's error as its cause. The
// SDK's errors are its own classes, from the engine's own copy of the SDK,
// failing an Effect as the SDK's promises do (they reject with a FiberFailure);
// they come in where the engine reads the indexer, the seam its repository
// takes for a test standing in for the network.
//
// This file loads no engine: each test file that runs it passes one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The wallet SDK's copy of Effect.
import { Effect } from 'effect';
import { type Engine, type NetworkConfig, createHost, classifyError, DustRequiredError, InsufficientBalanceError, ProofFailureError, TransactionRefusedError } from '@kuiralabs/midnight-cli-core';
import type { EngineHost } from '@kuiralabs/midnight-cli-core/engine';
import { installedCommands } from '../../lib/installed-commands.ts';

/** What the suite takes from an engine: how to make it with its repository's seams, and the SDK's error classes from its own copy. */
export interface BoundaryEngine {
  set: string;
  createEngine(host: EngineHost, options: { repository: { fetchUnshielded: () => Promise<never>; fetchTip: () => Promise<string> } }): Engine;
  SubmissionError: new (args: { message: string; cause?: unknown }) => Error;
  ProvingError: new (args: { message: string; cause: Error }) => Error;
  InsufficientFundsError: new (args: { message: string; tokenType: string }) => Error;
  /** The SDK's message for a balance it could not make of a token, as its balancer words it. */
  couldNotBalance(tokenType: string): string;
}

const NETWORK: NetworkConfig = { indexer: 'http://test/indexer', indexerWS: 'ws://test/indexer/ws', node: 'ws://test/node', proofServer: 'http://test/proof', networkId: 'Undeployed' };
const ADDRESS = 'mn_addr_undeployed1boundary';
const NIGHT = '0'.repeat(64);

/** The SDK's promise rejection for a failed Effect: a FiberFailure holding the error. */
function sdkRejection(error: Error): Promise<never> {
  const failure = Effect.runPromise(Effect.fail(error));
  failure.catch(() => {});
  return failure as Promise<never>;
}

export function engineBoundarySuite(engine: BoundaryEngine): void {
  describe(`the ${engine.set} engine's failures, as it reports them`, () => {
    let root: string;
    beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mn-engine-boundary-')); });
    afterAll(() => { rmSync(root, { recursive: true, force: true }); });

    /** What the engine's wallet rejects with when the SDK fails with `failure` under it. */
    async function reported(failure: () => Promise<never>): Promise<Error> {
      const host = createHost({ paths: { stateRoot: root, home: root } });
      const made = engine.createEngine(host, { repository: { fetchUnshielded: failure, fetchTip: async () => 'tip-1' } });
      return made.wallet.unshieldedBalance(ADDRESS, NETWORK, { forceFresh: true }).then(
        () => { throw new Error('expected the engine to fail'); },
        (err: Error) => err,
      );
    }
    const refusal = (reason: string) => () => sdkRejection(new engine.SubmissionError({ message: 'Transaction submission error', cause: new Error(reason) }));

    it.each([
      ['1010: Invalid Transaction: Custom error: 115', 'STALE_UTXO'],
      ['1010: Invalid Transaction: Custom error: 170', 'INVALID_DUST_PROOF'],
      ['1010: Invalid Transaction: Custom error: 199', 'TX_REJECTED'],
    ])("reports the node's refusal \"%s\" in the node's words, as %s", async (reason, code) => {
      const err = await reported(refusal(reason));
      expect(err).toBeInstanceOf(TransactionRefusedError);
      expect(err.message).toBe(`The node refused the transaction: ${reason}`);
      expect((err as TransactionRefusedError).code).toBe(code);
      expect(classifyError(err, installedCommands)).toStrictEqual({ errorCode: code, exitCode: 6 });
    });

    it("reports the proof server's failure as PROOF_FAILURE, with the SDK's message", async () => {
      const err = await reported(() => sdkRejection(new engine.ProvingError({ message: 'Failed to prove transaction', cause: new Error('connect ECONNREFUSED 127.0.0.1:6300') })));
      expect(err).toBeInstanceOf(ProofFailureError);
      expect(err.message).toBe('Failed to prove transaction');
      expect(classifyError(err, installedCommands)).toStrictEqual({ errorCode: 'PROOF_FAILURE', exitCode: 6 });
    });

    it("reports the SDK's Dust shortage as DUST_REQUIRED, and its shortage of NIGHT as INSUFFICIENT_BALANCE", async () => {
      const dust = await reported(() => sdkRejection(new engine.InsufficientFundsError({ message: engine.couldNotBalance('dust'), tokenType: 'dust' })));
      expect(dust).toBeInstanceOf(DustRequiredError);
      expect(dust.message).toBe(engine.couldNotBalance('dust'));
      expect(classifyError(dust, installedCommands)).toStrictEqual({ errorCode: 'DUST_REQUIRED', exitCode: 5 });

      const night = await reported(() => sdkRejection(new engine.InsufficientFundsError({ message: engine.couldNotBalance(NIGHT), tokenType: NIGHT })));
      expect(night).toBeInstanceOf(InsufficientBalanceError);
      expect(night.message).toBe(engine.couldNotBalance(NIGHT));
      expect(classifyError(night, installedCommands)).toStrictEqual({ errorCode: 'INSUFFICIENT_BALANCE', exitCode: 5 });
    });

    it('keeps the SDK\'s error as the cause, and leaves a failure it does not name as it was', async () => {
      const failure = new engine.SubmissionError({ message: 'Transaction submission error', cause: new Error('1010: Invalid Transaction: Custom error: 115') });
      const err = await reported(() => sdkRejection(failure));
      expect(err.cause).toBeInstanceOf(Error);
      const unnamed = new Error('Something the SDK says that mn has no code for');
      expect(await reported(() => Promise.reject(unnamed))).toBe(unnamed);
    });
  });
}
