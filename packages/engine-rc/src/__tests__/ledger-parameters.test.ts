// What the engine reads from a chain's ledger parameters, with the engine's own
// ledger-v9: the parameters' bytes as the indexer serves them, and a real
// transaction priced with them.

import { describe, it, expect } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
import { maxPriceAdjustmentOf } from '../ledger-parameters.ts';
import { agentPaysMerchant } from '../../../../test-support/ledger-tx.ts';

const PARAMS = ledger.LedgerParameters.initialParameters();
const PARAMS_HEX = Buffer.from(PARAMS.serialize()).toString('hex');

describe('maxPriceAdjustmentOf', () => {
  it('reads the most fee prices rise in a block from the parameters\' bytes', () => {
    const factor = maxPriceAdjustmentOf(PARAMS_HEX);
    expect(factor).toBe(PARAMS.maxPriceAdjustment());
    expect(factor).toBeGreaterThan(1);
  });

  it('is the factor a fee with n blocks of margin is the fee times, to the nth: what a cost\'s fee is worked back from', () => {
    const tx = agentPaysMerchant();
    const fee = tx.fees(PARAMS);
    const factor = maxPriceAdjustmentOf(PARAMS_HEX);
    for (const margin of [0, 3, 5, 8]) {
      const withMargin = tx.feesWithMargin(PARAMS, margin);
      // Both are rounded down to the Speck from the same fixed-point cost.
      expect(Number(withMargin)).toBeCloseTo(Number(fee) * factor ** margin, -2);
    }
  });

  it('refuses bytes that are not ledger parameters', () => {
    expect(() => maxPriceAdjustmentOf('00ff')).toThrow();
  });
});
