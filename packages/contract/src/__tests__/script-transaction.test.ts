// The transaction a deploy or call script reports, as mn reports it: txHash is
// the transaction's identifier (66 hex characters), as transfer, airdrop,
// dust register and swap give it and `mn tx status` takes it, and the receipt
// carries the hash. A deploy and a call gave the hash as txHash before.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportedTransaction } from '../lib/contract/script-transaction.ts';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';

const HASH = '767b7dc4edf81005bdf31c5275a251e18208691aad1661c148528c9e0a464711';
const IDENTIFIER = '00c4b3d50546f0dc0c9aa9cfb9a3a4f01285c2bf70f7dec0bdc52fa5401ca09464';
const OTHER_IDENTIFIER = '000466933a0880514c024447c362adb208644c40bc6bfacc337bc4eb49d499885f';

let indexer: LocalIndexer;
// An indexer that lists the transaction, found by either reference.
beforeEach(async () => {
  indexer = await startLocalIndexer(() => JSON.stringify({ data: { transactions: [{
    __typename: 'RegularTransaction', hash: HASH, block: { height: 70871, hash: 'ab'.repeat(32), timestamp: 1_700_000_000_000 },
    identifiers: [OTHER_IDENTIFIER, IDENTIFIER], fee: '5819659804898556', transactionResult: { status: 'SUCCESS' },
  }] } }));
});
afterEach(() => indexer.close());

describe('reportedTransaction', () => {
  it('gives the identifier as txHash, looks the receipt up by it, and the receipt keeps the hash', async () => {
    const reported = await reportedTransaction({ txHash: HASH, txId: IDENTIFIER }, indexer.url);
    expect(reported.txHash).toBe(IDENTIFIER);
    expect(reported.txHash).toHaveLength(66);
    expect(indexer.requests[0]!.variables).toEqual({ offset: { identifier: IDENTIFIER } });
    expect(reported.receipt).toMatchObject({ listed: true, transaction: { hash: HASH, identifiers: [OTHER_IDENTIFIER, IDENTIFIER] } });
  });

  it('gives nothing when the script reported no transaction (a dry run)', async () => {
    expect(await reportedTransaction({}, indexer.url)).toEqual({});
    expect(indexer.requests).toEqual([]);
  });
});
