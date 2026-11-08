// What an owner is told when an account deploy stops for want of Dust.

import { describe, expect, it } from 'vitest';
import { ERROR_CODES, EXIT_INSUFFICIENT_BALANCE, classifyError, DustRequiredError } from '@kuiralabs/midnight-cli-core';
import { MEASURED_ACCOUNT_DEPLOY, deployShortOfDustNote } from '../lib/grant/deploy-cost.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';
import { DUST_COST_OVERHEAD, DUST_FEE_BLOCKS_MARGIN } from '@kuiralabs/midnight-cli-core/engine';

/** The ledger-9 parameters' maxPriceAdjustment (price_adjustment_a 100). */
const MAX_PRICE_RISE_PER_BLOCK = 1.0459511985013459;

describe('deployShortOfDustNote', () => {
  it('says what a deploy takes, what the wallet had, and that running again carries on', () => {
    const note = deployShortOfDustNote(789_792_293_850_357n);
    expect(note).toContain('about 47 DUST from the wallet over 5 transactions, the largest about 16.1 DUST at once');
    expect(note).toContain('This wallet had 0.789792293850357 DUST when the deploy began.');
    expect(note).toContain('midnight dust status');
    expect(note).toContain('carries on from where it stopped');
  });

  // What leaves the wallet for a fee: the fee with mn's margin, at most 4.6% a block for DUST_FEE_BLOCKS_MARGIN blocks, plus the overhead.
  const fromWallet = (fee: number) => fee * MAX_PRICE_RISE_PER_BLOCK ** DUST_FEE_BLOCKS_MARGIN + Number(DUST_COST_OVERHEAD) / 1e15;
  const MEASURED_FEES = [
    [12.2349, 9.8673, 10.0001, 1.3712, 0.2631],
    [13.4002, 10.7393, 10.8193, 1.5282, 0.2673],
    [14.0202, 11.0552, 10.7728, 4.0526, 0.2787],
  ];

  it('covers both measured deploys, rounded up, never down', () => {
    for (const fees of MEASURED_FEES) {
      expect(fees).toHaveLength(MEASURED_ACCOUNT_DEPLOY.transactions);
      expect(MEASURED_ACCOUNT_DEPLOY.totalDust).toBeGreaterThanOrEqual(fees.reduce((total, fee) => total + fromWallet(fee), 0));
      expect(MEASURED_ACCOUNT_DEPLOY.largestDust).toBeGreaterThanOrEqual(fromWallet(Math.max(...fees)));
    }
  });

  it('leaves the error it is added to a Dust shortage, with the same exit code', () => {
    const fromServe = 'The wallet has no Dust available that covers this transaction\'s fee (Insufficient Funds: could not balance dust), and no balanced transaction is holding any back on this server.';
    // As grant deploy throws it: the shortage, with the note.
    expect(classifyError(new DustRequiredError(`${fromServe}\n\n${deployShortOfDustNote(0n)}`), CORE_CODES))
      .toEqual({ exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.DUST_REQUIRED });
  });
});
