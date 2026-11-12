// The offer reader on the rc engine: the shared suite (test-support/offer-reader-suite.ts), and the identifier a sealed transaction's submit returns.

import { describe, expect, it } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
import { readOffer, spentNullifiers, transactionIdentifier } from '../offer-reader.ts';
import { offerReaderSuite } from '../../../../test-support/offer-reader-suite.ts';
import { TAKEN_SWAP_HEX, TAKEN_SWAP_TX_HASH } from '../../../../test-support/fixtures/taken-swap.ts';

offerReaderSuite({ set: 'rc', ledger, readOffer, spentNullifiers });

describe('transactionIdentifier', () => {
  // Regression: a taken offer's transaction was named by its hash, where the take printed this identifier as its txHash.
  it("reads a sealed transaction's bytes as the identifier its submit returned, the txHash mn printed for it", () => {
    expect(transactionIdentifier(TAKEN_SWAP_HEX)).toBe(TAKEN_SWAP_TX_HASH);
    // Not the first of its identifiers: a swap has several, and the submit's is its last.
    const identifiers = ledger.Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(TAKEN_SWAP_HEX, 'hex')).identifiers();
    expect(identifiers.length).toBeGreaterThan(1);
    expect(identifiers[0]).not.toBe(TAKEN_SWAP_TX_HASH);
  });

  it('refuses bytes that are no sealed transaction', () => {
    expect(() => transactionIdentifier('00ff')).toThrow();
  });
});
