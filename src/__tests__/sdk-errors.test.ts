// isDustShortage: recognises the wallet running out of dust for a fee, and
// nothing else. Errors are built in the shape wallet-sdk 2.0 raises them
// (an Effect tagged error carrying tokenType), not just matching strings.

import { describe, it, expect } from 'vitest';
import { Brand, Effect } from 'effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { NodeClientError } from '@midnightntwrk/wallet-sdk/node-client/effect';
import { dustShortfallOf, isColdStartRace, isDustShortage, nodeRefusalOf, withDustShortfall, withNodeReason } from '../lib/sdk-errors.ts';
import { TransactionRefusedError } from '../lib/errors.ts';
import { classifyError } from '../lib/exit-codes.ts';

/** wallet-sdk 2.0's dust InsufficientFundsError: tagged, with the token it could not balance. */
function sdkInsufficientFunds(tokenType: string): Error {
  return Object.assign(new Error(`Insufficient Funds: could not balance ${tokenType}`), {
    _tag: 'Wallet.InsufficientFunds',
    tokenType,
  });
}

describe('isDustShortage', () => {
  it('matches the SDK\'s dust InsufficientFunds error', () => {
    expect(isDustShortage(sdkInsufficientFunds('dust'))).toBe(true);
  });

  it('matches it when the facade wraps it as a cause', () => {
    const wrapped = Object.assign(new Error('Balancing failed'), { cause: sdkInsufficientFunds('dust') });
    expect(isDustShortage(wrapped)).toBe(true);
  });

  it('does not match a shortage of another token: waiting for dust would not fix it', () => {
    const night = '0000000000000000000000000000000000000000000000000000000000000000';
    expect(isDustShortage(sdkInsufficientFunds(night))).toBe(false);
    expect(isDustShortage(sdkInsufficientFunds('shielded'))).toBe(false);
  });

  it('still matches the ledger-8 SDK\'s wording', () => {
    expect(isDustShortage(new Error('No dust tokens found in the wallet state'))).toBe(true);
  });

  it('does not match unrelated errors or non-errors', () => {
    expect(isDustShortage(new Error('ZK proof generation timed out'))).toBe(false);
    expect(isDustShortage(undefined)).toBe(false);
    expect(isDustShortage('dust')).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: any = new Error('a');
    const b: any = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(isDustShortage(a)).toBe(false);
  });
});

describe('isDustShortage on what the real wallet SDK rejects with', () => {
  // The shape wallet-sdk 2.0.0-rc.0 rejected with on a ledger-9 localnet
  // (2026-10-02) when a fee wallet's only Dust coin was reserved by a pending
  // balance: an Effect FiberFailure named "(FiberFailure)
  // Wallet.InsufficientFunds", with nothing on the error itself but its
  // message; the tagged error is only in the Effect cause under this symbol.
  const FIBER_FAILURE = Symbol.for('effect/Runtime/FiberFailure');
  const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');
  function fiberFailure(cause: object, message: string): Error {
    const err = new Error(message);
    err.name = '(FiberFailure) Wallet.InsufficientFunds';
    return Object.assign(err, { [FIBER_FAILURE]: FIBER_FAILURE, [FIBER_FAILURE_CAUSE]: cause });
  }

  it('matches the FiberFailure of a dust shortage, which carries no tag of its own', () => {
    const err = fiberFailure(
      { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' } },
      'Insufficient Funds: could not balance dust',
    );
    expect(Object.keys(err)).toEqual(['name']); // as on the live error: no _tag, no tokenType
    expect(isDustShortage(err)).toBe(true);
  });

  it('does not match a FiberFailure whose cause is another token\'s shortage', () => {
    const err = fiberFailure(
      { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds', tokenType: '00'.repeat(32) } },
      'Insufficient Funds: could not balance 0000',
    );
    expect(isDustShortage(err)).toBe(false);
  });

  it('finds a dust shortage on either side of a combined (Sequential) cause', () => {
    const err = fiberFailure({
      _tag: 'Sequential',
      left: { _tag: 'Fail', error: { _tag: 'Other' } },
      right: { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' } },
    }, 'several failures');
    expect(isDustShortage(err)).toBe(true);
  });
});

describe('dustShortfallOf: what a Dust shortage says the wallet is short by', () => {
  const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');
  const shortage = () => sdkInsufficientFunds('dust');
  const shortfall = { needed: 1_600_000_000_000_000n, available: 350_000_000_000_000n };

  it('reads it from the shortage itself, and leaves the shortage a shortage', () => {
    const err = withDustShortfall(shortage(), shortfall);
    expect(dustShortfallOf(err)).toEqual(shortfall);
    expect(isDustShortage(err)).toBe(true);
  });

  it('finds it where the SDK puts the shortage: wrapped as a ledger error, inside a FiberFailure\'s cause', () => {
    const ledgerError = Object.assign(new Error('Error from ledger: Insufficient Funds: could not balance dust'), {
      _tag: 'LedgerError', cause: withDustShortfall(shortage(), shortfall),
    });
    const err = Object.assign(new Error('Error from ledger'), { [FIBER_FAILURE_CAUSE]: { _tag: 'Fail', error: ledgerError } });
    expect(dustShortfallOf(err)).toEqual(shortfall);
  });

  it('is undefined for a shortage that carries none, and for anything else', () => {
    expect(dustShortfallOf(shortage())).toBeUndefined();
    expect(dustShortfallOf(new Error('No dust tokens found in the wallet state'))).toBeUndefined();
    expect(dustShortfallOf(undefined)).toBeUndefined();
    expect(dustShortfallOf('Insufficient Funds')).toBeUndefined();
  });
});

describe('isColdStartRace', () => {
  // The FiberFailure shape wallet-sdk 2.0.0-rc.0 rejected with on a ledger-9 localnet.
  const fiberFailure = (tokenType: string) => {
    const err = new Error(`Insufficient Funds: could not balance ${tokenType}`);
    err.name = '(FiberFailure) Wallet.InsufficientFunds';
    return Object.assign(err, { [Symbol.for('effect/Runtime/FiberFailure/Cause')]: { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds', tokenType } } });
  };

  it('is a NIGHT shortage while the wallet holds NIGHT: restarting the facade fixes it', () => {
    expect(isColdStartRace(fiberFailure('0'.repeat(64)))).toBe(true);
    expect(isColdStartRace(new Error('Insufficient funds'))).toBe(true);
  });

  it('is not a Dust shortage, which only waiting for Dust fixes (found live: restarts crashed the ledger WASM)', () => {
    expect(isColdStartRace(fiberFailure('dust'))).toBe(false);
  });

  it('is not anything else', () => {
    expect(isColdStartRace(new Error('Transaction submission error'))).toBe(false);
  });
});

// A node's refusal, built as wallet-sdk 2.0 raises it: its submission
// service wraps the node client's error in a SubmissionError, and the promise
// rejects with an Effect FiberFailure that holds it.
describe("the node's reason for refusing a transaction", () => {
  // The transaction's bytes, branded as the SDK brands them (its SerializedTransaction is a nominal brand it doesn't export).
  type TxData = ConstructorParameters<typeof NodeClientError.SubmissionError>[0]['txData'];
  const TX_DATA = Brand.nominal<TxData>()(new Uint8Array([0]));
  const refusal = (nodeError: unknown): Promise<never> => {
    const failure = Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: nodeError })));
    failure.catch(() => {});
    return failure;
  };
  const caught = (promise: Promise<never>) => promise.catch((err: Error) => err);

  it('is found under the SDK\'s wrappers, and reported as a TransactionRefusedError classified by it', async () => {
    const thrown = await caught(refusal(new NodeClientError.SubmissionError({ message: 'Transaction submission failed', txData: TX_DATA, cause: new Error('1010: Invalid Transaction: Custom error: 170') })));
    expect(thrown.message).toBe('Transaction submission error');
    expect(nodeRefusalOf(thrown)).toBe('1010: Invalid Transaction: Custom error: 170');
    const reported = withNodeReason(thrown);
    expect(reported).toBeInstanceOf(TransactionRefusedError);
    expect(reported.message).toBe('The node refused the transaction: 1010: Invalid Transaction: Custom error: 170');
    expect(reported.cause).toBe(thrown);
    expect(classifyError(reported)).toEqual({ exitCode: 6, errorCode: 'INVALID_DUST_PROOF' });
    // Unexplained, the same error was UNKNOWN.
    expect(classifyError(thrown).errorCode).toBe('UNKNOWN');
  });

  it("is the node client's own words when the node gave none", async () => {
    const thrown = await caught(refusal(new NodeClientError.TransactionInvalidError({ message: 'Transaction is invalid and was rejected by the node', txData: TX_DATA })));
    expect(nodeRefusalOf(thrown)).toBe('Transaction is invalid and was rejected by the node');
    expect(classifyError(withNodeReason(thrown))).toEqual({ exitCode: 6, errorCode: 'TX_REJECTED' });
  });

  it('classifies a reason no rule knows as TX_REJECTED, with the reason in the message', async () => {
    const reported = withNodeReason(await caught(refusal(new NodeClientError.SubmissionError({ message: 'Transaction submission failed', txData: TX_DATA, cause: new Error('1010: Invalid Transaction: Custom error: 199') }))));
    expect(reported.message).toContain('Custom error: 199');
    expect(classifyError(reported)).toEqual({ exitCode: 6, errorCode: 'TX_REJECTED' });
  });

  it('leaves any other error as it is, and a submission error with nothing under its wrapper', async () => {
    const other = new Error('ECONNREFUSED');
    expect(nodeRefusalOf(other)).toBeUndefined();
    expect(withNodeReason(other)).toBe(other);
    const bare = await caught(refusal(undefined));
    expect(nodeRefusalOf(bare)).toBeUndefined();
    expect(withNodeReason(bare)).toBe(bare);
  });
});
