// What became of a transaction, from the indexer: the lookup, the wait, and
// the receipt a submitting command reports. The indexer's answers are
// test-support/fixtures/tx-status.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { CancelledError, UsageError, type ProgressEvent } from '@kuiralabs/midnight-cli-core';
import { IndexerQueryError } from '../lib/indexer-graphql.ts';
import { fetchTransactionStatus, parseTxReference, transactionStatus, waitForTransactionStatus } from '../lib/tx-status.ts';
import { receiptJson, receiptOf, transactionStatusJson } from '../lib/tx-receipt.ts';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';
import { BLOCK, HASH, IDENTIFIER, answer, regular } from '../../../../test-support/fixtures/tx-status.ts';

let indexer: LocalIndexer | undefined;
afterEach(async () => { await indexer?.close(); indexer = undefined; });

describe('parseTxReference', () => {
  it('reads 64 hex characters as a hash and 66 as an identifier, with or without 0x, in any case', () => {
    expect(parseTxReference(HASH)).toEqual({ hash: HASH });
    expect(parseTxReference(IDENTIFIER)).toEqual({ identifier: IDENTIFIER });
    expect(parseTxReference(`0x${HASH.toUpperCase()}`)).toEqual({ hash: HASH });
  });

  it.each(['', 'xyz', HASH.slice(1), `${IDENTIFIER}00`, `${HASH.slice(0, 63)}g`])('refuses %j as a usage error', (text) => {
    expect(() => parseTxReference(text)).toThrow(UsageError);
  });
});

describe('fetchTransactionStatus', () => {
  it('finds a transaction by its identifier: final, with its result, fee in specks and block', async () => {
    indexer = await startLocalIndexer(() => answer([regular('SUCCESS')]));
    const status = await fetchTransactionStatus(indexer.url, { identifier: IDENTIFIER });
    expect(status).toEqual({
      state: 'final', kind: 'regular', hash: HASH, identifiers: [IDENTIFIER], result: 'SUCCESS', feeSpecks: 845170285714286n,
      block: { height: BLOCK.height, hash: BLOCK.hash, time: new Date('2026-11-03T08:55:18.000Z') },
    });
    expect(indexer.requests[0]!.variables).toEqual({ offset: { identifier: IDENTIFIER } });
  });

  it('asks by hash when given a hash', async () => {
    indexer = await startLocalIndexer(() => answer([regular('SUCCESS')]));
    await fetchTransactionStatus(indexer.url, { hash: HASH });
    expect(indexer.requests[0]!.variables).toEqual({ offset: { hash: HASH } });
  });

  it('lists the segments of a partial success, and only of one', async () => {
    indexer = await startLocalIndexer(() => answer([regular('PARTIAL_SUCCESS', [{ id: 0, success: true }, { id: 1, success: false }])]));
    const status = await fetchTransactionStatus(indexer.url, { hash: HASH });
    expect(status).toMatchObject({ result: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 1, success: false }] });
  });

  it('reports a failed transaction as final, with the fee it paid', async () => {
    indexer = await startLocalIndexer(() => answer([regular('FAILURE')]));
    expect(await fetchTransactionStatus(indexer.url, { hash: HASH })).toMatchObject({ state: 'final', result: 'FAILURE', feeSpecks: 845170285714286n });
  });

  it('reports a system transaction with its block, and no result or fee', async () => {
    indexer = await startLocalIndexer(() => answer([{ __typename: 'SystemTransaction', hash: HASH, block: BLOCK }]));
    const status = await fetchTransactionStatus(indexer.url, { hash: HASH });
    expect(status).toEqual({ state: 'final', kind: 'system', hash: HASH, identifiers: [], block: { height: BLOCK.height, hash: BLOCK.hash, time: new Date(BLOCK.timestamp) } });
  });

  it('reports a transaction the indexer does not have as not found', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    expect(await fetchTransactionStatus(indexer.url, { identifier: IDENTIFIER })).toEqual({ state: 'notFound' });
  });

  it('throws IndexerQueryError when the indexer refuses the query', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ errors: [{ message: 'invalid transaction hash' }] }));
    await expect(fetchTransactionStatus(indexer.url, { hash: HASH })).rejects.toThrow(IndexerQueryError);
  });
});

describe('waitForTransactionStatus', () => {
  it('asks until the indexer lists the transaction', async () => {
    let asked = 0;
    indexer = await startLocalIndexer(() => (++asked < 3 ? answer([]) : answer([regular('SUCCESS')])));
    const status = await waitForTransactionStatus(indexer.url, { identifier: IDENTIFIER }, 5_000, undefined, 20);
    expect(status.state).toBe('final');
    expect(asked).toBe(3);
  });

  it('gives not found once the timeout passes', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    const started = Date.now();
    expect(await waitForTransactionStatus(indexer.url, { identifier: IDENTIFIER }, 150, undefined, 20)).toEqual({ state: 'notFound' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(indexer.requests.length).toBeGreaterThan(1);
  });

  it('stops with CancelledError when its call is cancelled', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(waitForTransactionStatus(indexer.url, { identifier: IDENTIFIER }, 10_000, controller.signal, 20)).rejects.toThrow(CancelledError);
  });
});

describe('transactionStatus', () => {
  it('asks once, saying so, and gives what the indexer knows', async () => {
    indexer = await startLocalIndexer(() => answer([regular('SUCCESS')]));
    const said: ProgressEvent[] = [];
    const status = await transactionStatus({ indexer: indexer.url, ref: { hash: HASH }, onProgress: (event) => said.push(event) });
    expect(status).toMatchObject({ state: 'final', result: 'SUCCESS', feeSpecks: 845170285714286n, block: { height: BLOCK.height } });
    expect(indexer.requests).toHaveLength(1);
    expect(said).toEqual([{ kind: 'start', message: 'Asking the indexer...' }, { kind: 'done', message: 'Final' }]);
  });

  it('with wait, asks until the time passes, and says it was not found', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    const said: ProgressEvent[] = [];
    const status = await transactionStatus({ indexer: indexer.url, ref: { identifier: IDENTIFIER }, wait: true, timeoutMs: 100, onProgress: (event) => said.push(event) });
    expect(status).toEqual({ state: 'notFound' });
    expect(said).toEqual([{ kind: 'start', message: 'Waiting for the indexer to list it...' }, { kind: 'done', message: 'Not found' }]);
  });

  it('never asks when its call is cancelled already', async () => {
    indexer = await startLocalIndexer(() => answer([regular('SUCCESS')]));
    const said: ProgressEvent[] = [];
    await expect(transactionStatus({ indexer: indexer.url, ref: { hash: HASH }, signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toThrow(CancelledError);
    expect(indexer.requests).toEqual([]);
    expect(said).toEqual([]);
  });

  it('throws IndexerQueryError when the indexer refuses', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ errors: [{ message: 'invalid transaction hash' }] }));
    await expect(transactionStatus({ indexer: indexer.url, ref: { hash: HASH } })).rejects.toBeInstanceOf(IndexerQueryError);
  });
});

describe('receiptOf', () => {
  it('gives the transaction once listed, and its JSON with the fee in DUST exactly', async () => {
    indexer = await startLocalIndexer(() => answer([regular('SUCCESS')]));
    const receipt = await receiptOf(indexer.url, IDENTIFIER);
    expect(receiptJson(receipt)).toEqual({
      receipt: {
        kind: 'regular', hash: HASH, identifiers: [IDENTIFIER], result: 'SUCCESS', fee: '0.845170285714286', feeSpecks: '845170285714286',
        blockHeight: BLOCK.height, blockHash: BLOCK.hash, blockTime: '2026-11-03T08:55:18.000Z',
      },
    });
  });

  it('says the indexer has not listed it yet, never throwing', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    expect(receiptJson(await receiptOf(indexer.url, IDENTIFIER, undefined, 100))).toEqual({ receipt: null, receiptMissing: 'the indexer has not listed it after 0 s' });
  });

  it('says the indexer did not answer, never throwing', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ errors: [{ message: 'overloaded' }] }));
    expect(receiptJson(await receiptOf(indexer.url, IDENTIFIER))).toEqual({ receipt: null, receiptMissing: 'the indexer did not answer: overloaded' });
  });

  it('says it was cancelled, never throwing: the transaction is submitted already', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(receiptJson(await receiptOf(indexer.url, IDENTIFIER, controller.signal))).toEqual({ receipt: null, receiptMissing: 'cancelled while waiting for the indexer' });
  });
});

describe('transactionStatusJson', () => {
  it('gives not found as its state alone', () => {
    expect(transactionStatusJson({ state: 'notFound' })).toEqual({ state: 'notFound' });
  });
});

