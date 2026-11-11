// isDustShortage: recognises the wallet running out of dust for a fee, and
// nothing else. Errors are built in the shape wallet-sdk 2.0 raises them
// (an Effect tagged error carrying tokenType), not just matching strings.

import { describe, it, expect } from 'vitest';
import { Brand, Effect, Either, Option } from 'effect';
import { ProtocolVersion, WalletTransaction } from '@midnightntwrk/wallet-sdk';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { NodeClientError } from '@midnightntwrk/wallet-sdk/node-client/effect';
import { DustRequiredError, InsufficientBalanceError, NetworkError, ProofFailureError, StaleWalletStateError, SyncTimeoutError, TransactionInvalidatedError, TransactionRefusedError, WalletBehindForkError, walletsBehindForkMessage } from '../lib/errors.ts';
import { isDroppedFromPool } from '../lib/fee-margin.ts';
import { classifyError } from '../lib/exit-codes.ts';
import { createApiError } from '../lib/connector-api.ts';
import { isTransportFailure } from '../lib/transport-failure.ts';
import { dustShortfallOf, isColdStartRace, isDustShortage, mnCodeOf, nodeRefusalOf, refusalCodeOf, toEngineError, withDustShortfall, withEngineCode, withNodeReason } from '../lib/sdk-errors.ts';
import { ProofTimeoutError } from '../lib/errors.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

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
    expect(classifyError(reported, CORE_CODES)).toEqual({ exitCode: 6, errorCode: 'INVALID_DUST_PROOF' });
    // Unexplained, the same error is UNKNOWN.
    expect(classifyError(thrown, CORE_CODES).errorCode).toBe('UNKNOWN');
  });

  it("is the node client's own words when the node gave none", async () => {
    const thrown = await caught(refusal(new NodeClientError.TransactionInvalidError({ message: 'Transaction is invalid and was rejected by the node', txData: TX_DATA })));
    expect(nodeRefusalOf(thrown)).toBe('Transaction is invalid and was rejected by the node');
    expect(classifyError(withNodeReason(thrown), CORE_CODES)).toEqual({ exitCode: 6, errorCode: 'TX_REJECTED' });
  });

  it('reports a transaction the node took into its pool and then dropped as TX_INVALIDATED, saying another payment from the wallet spent its Dust or coin first', async () => {
    const thrown = await caught(refusal(new NodeClientError.TransactionInvalidError({ message: 'Transaction is invalid and was rejected by the node', txData: TX_DATA })));
    expect(isDroppedFromPool(thrown)).toBe(true);
    const reported = toEngineError(thrown) as Error;
    expect(reported).toBeInstanceOf(TransactionInvalidatedError);
    expect(reported.cause).toBe(thrown);
    expect(reported.message).toContain('another transaction from this wallet');
    expect(reported.message).toContain('Nothing of this one was spent');
    expect(classifyError(reported, CORE_CODES)).toEqual({ exitCode: 6, errorCode: 'TX_INVALIDATED' });
    // A DApp connector's answer carries the code beside its own.
    expect(mnCodeOf(withEngineCode(thrown))).toBe('TX_INVALIDATED');
    // A refusal with the node's own reason is not one, nor any other failure.
    expect(isDroppedFromPool(await caught(refusal(new NodeClientError.SubmissionError({ message: 'Transaction submission failed', txData: TX_DATA, cause: new Error('1010: Invalid Transaction: Custom error: 196') }))))).toBe(false);
    expect(isDroppedFromPool(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('classifies a reason no rule knows as TX_REJECTED, with the reason in the message', async () => {
    const reported = withNodeReason(await caught(refusal(new NodeClientError.SubmissionError({ message: 'Transaction submission failed', txData: TX_DATA, cause: new Error('1010: Invalid Transaction: Custom error: 199') }))));
    expect(reported.message).toContain('Custom error: 199');
    expect(classifyError(reported, CORE_CODES)).toEqual({ exitCode: 6, errorCode: 'TX_REJECTED' });
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

describe("the engine contract's reading of a failure", () => {
  const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');
  const fiberFailure = (error: object, message: string) => Object.assign(new Error(message), { [FIBER_FAILURE_CAUSE]: { _tag: 'Fail', error } });

  it("codes a node's refusal by its reason", () => {
    expect(refusalCodeOf('1010: Invalid Transaction: Custom error: 115')).toBe('STALE_UTXO');
    expect(refusalCodeOf('1010: Invalid Transaction: Custom error: 170')).toBe('INVALID_DUST_PROOF');
    expect(refusalCodeOf('InvalidDustSpendProof')).toBe('INVALID_DUST_PROOF');
    expect(refusalCodeOf('Transaction is invalid and was rejected by the node')).toBe('TX_REJECTED');
  });

  it('reports a failure it names as the typed error for its code, with the message and the failure as its cause', () => {
    const dust = fiberFailure({ _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' }, 'Insufficient Funds: could not balance dust');
    const reported = toEngineError(dust) as Error;
    expect(reported).toBeInstanceOf(DustRequiredError);
    expect(reported.message).toBe(dust.message);
    expect(reported.cause).toBe(dust);

    const night = fiberFailure({ _tag: 'Wallet.InsufficientFunds', tokenType: '0'.repeat(64) }, 'Insufficient Funds: could not balance 0000');
    expect(toEngineError(night)).toBeInstanceOf(InsufficientBalanceError);
    // The ledger's words when a saved state is resumed on an indexer that numbers its events differently.
    const resumed = toEngineError(new Error('Failed applying dust events: commitment inserted non-linearly')) as Error;
    expect(resumed).toBeInstanceOf(StaleWalletStateError);
    expect(classifyError(resumed, CORE_CODES)).toStrictEqual({ errorCode: 'STALE_CACHE', exitCode: 6 });
  });

  it("leaves an error that carries its own code, a refusal already reported, and one it doesn't name, as they are", () => {
    const own = new ProofTimeoutError();
    expect(toEngineError(own)).toBe(own);
    const refused = new TransactionRefusedError('Custom error: 115', { code: 'STALE_UTXO' });
    expect(toEngineError(refused)).toBe(refused);
    const unnamed = new Error('Something unexpected happened');
    expect(toEngineError(unnamed)).toBe(unnamed);
    expect(toEngineError('a string')).toBe('a string');
  });

  it('reports a connection the SDK could not make as a NetworkError, last among what it names', async () => {
    // A socket's own error carries the transport's code, not mn's.
    const socket = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8088'), { code: 'ECONNREFUSED' });
    const fromSocket = toEngineError(socket) as Error;
    expect(fromSocket).toBeInstanceOf(NetworkError);
    expect(fromSocket.message).toBe(socket.message);
    expect(fromSocket.cause).toBe(socket);
    // fetch says only "fetch failed"; what failed is its cause (ECONNREFUSED).
    const fetched = await fetch(`http://127.0.0.1:${await closedPort()}/`).then(() => { throw new Error('expected fetch to fail'); }, (e: Error) => e);
    expect(fetched.message).toBe('fetch failed');
    expect(isTransportFailure(Object.assign(new Error('the SDK said no more'), { cause: fetched }))).toBe(true);
    expect(classifyError(toEngineError(fetched) as Error, CORE_CODES)).toStrictEqual({ errorCode: 'NETWORK_ERROR', exitCode: 4 });
    expect(classifyError(toEngineError(new Error('WebSocket connection to ws://127.0.0.1:8088 failed')) as Error, CORE_CODES)).toStrictEqual({ errorCode: 'NETWORK_ERROR', exitCode: 4 });
    // A proof server out of reach is a failed proof, as the SDK says first.
    expect(toEngineError(new Error('Failed to prove transaction', { cause: socket }))).toBeInstanceOf(ProofFailureError);
    // An error with a code of its own keeps it, whatever its cause.
    const own = new SyncTimeoutError('Wallet sync timed out', { cause: socket });
    expect(toEngineError(own)).toBe(own);
  });

  it("reports a connector error marked with mn's code as the typed error for it, in its own words", () => {
    const api = createApiError('InternalError', "Not enough Dust available for this transaction's fee", 'DUST_REQUIRED');
    const reported = toEngineError(api) as Error;
    expect(reported).toBeInstanceOf(DustRequiredError);
    expect(reported.message).toBe(api.message);
    expect(reported.cause).toBe(api);
    // An API error with no mn code stays the connector's.
    const plain = createApiError('InvalidRequest', 'tx is required');
    expect(toEngineError(plain)).toBe(plain);
  });

  it("marks a connector's failure with mn's code, the error itself unchanged for the dApp", () => {
    const dust = fiberFailure({ _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' }, 'Insufficient Funds: could not balance dust');
    const marked = withEngineCode(dust) as Error;
    expect(marked).toBe(dust);
    expect(marked.message).toBe('Insufficient Funds: could not balance dust');
    expect(mnCodeOf(marked)).toBe('DUST_REQUIRED');
    expect(Object.keys(marked)).not.toContain('mnCode');
    const api = createApiError('Rejected', 'User rejected the request', 'TX_REJECTED');
    expect(mnCodeOf(withEngineCode(api))).toBe('TX_REJECTED');
    expect(mnCodeOf(withEngineCode(new Error('Something unexpected happened')))).toBeUndefined();
  });
});

describe('a transaction built on the other side of the ledger-9 fork than the wallet acts on', () => {
  // The SDK's own refusal, as its facade raised it on preprod (regression: reported as UNKNOWN):
  // a registration the unshielded and Dust wallets built on ledger 9, read by a facade whose shielded wallet was on ledger 8.
  const refusal = (authoredFor: bigint, accepted: readonly [bigint, bigint]): unknown => Option.getOrThrow(Either.getLeft(WalletTransaction.unwrapWithin(
    WalletTransaction.adopt('Unproven', { serialize: () => new Uint8Array() }, ProtocolVersion.ProtocolVersion(authoredFor)),
    ProtocolVersion.makeRange(ProtocolVersion.ProtocolVersion(accepted[0]), ProtocolVersion.ProtocolVersion(accepted[1])),
  )));

  it('is WALLET_BEHIND_FORK (exit 4), saying the wallet is still on ledger 8 and to run it again', () => {
    const sdk = refusal(2_000_000n, [0n, 2_000_000n]);
    const err = toEngineError(sdk) as Error & { code: string };
    expect(err).toBeInstanceOf(WalletBehindForkError);
    expect(err.code).toBe('WALLET_BEHIND_FORK');
    expect(err.cause).toBe(sdk);
    expect(err.message).toContain('built on ledger 9 (protocol version 2000000)');
    expect(err.message).toContain('still acts on ledger 8');
    expect(err.message).toContain('Run the command again');
    expect(classifyError(err, CORE_CODES)).toEqual({ exitCode: 4, errorCode: 'WALLET_BEHIND_FORK' });
  });

  it('is recognised under the errors that carry it, and marked for a DApp connector', () => {
    const sdk = refusal(2_000_000n, [0n, 2_000_000n]);
    expect(toEngineError(new Error('Failed to finalize the recipe', { cause: sdk }))).toBeInstanceOf(WalletBehindForkError);
    expect(mnCodeOf(withEngineCode(sdk))).toBe('WALLET_BEHIND_FORK');
  });

  it('says a ledger-8 transaction is to be built again on ledger 9 when the wallet crossed meanwhile', () => {
    const err = toEngineError(refusal(22_000n, [2_000_000n, 9_999_999n])) as Error;
    expect(err).toBeInstanceOf(WalletBehindForkError);
    expect(err.message).toContain('built on ledger 8 (protocol version 22000)');
    expect(err.message).toContain('build it on ledger 9');
  });

  it('names a version mismatch on one side of the fork without naming ledgers', () => {
    const err = toEngineError(refusal(2_001_100n, [2_000_000n, 2_001_000n])) as Error;
    expect(err).toBeInstanceOf(WalletBehindForkError);
    expect(err.message).toContain('built for protocol version 2001100');
    expect(err.message).not.toContain('ledger 8');
  });

  it('names the wallets behind the fork, each with its version and why, and how long mn waited', () => {
    const message = walletsBehindForkMessage([{ wallet: 'shielded', protocolVersion: 22_000n, reason: 'reading its shielded history first failed: socket closed' }], 2_000_000n, 60);
    expect(message).toContain('after 60 s, the shielded wallet is at protocol version 22000 (reading its shielded history first failed: socket closed), below the chain\'s fork to ledger 9 (2000000)');
  });
});
