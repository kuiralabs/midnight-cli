// A contract call that gives the contract a shielded coin, priced as the
// wallet balances it: the recorded call (fixtures/shielded-coin-call.ts), the
// shielded wallet's balancing of it, and the transaction the chain took. The
// Dust part is mn's own transacting on the two-coin fixture wallet, with mn's
// fee settings; the shielded wallet is the SDK's boundary, answering with the
// balancing it made for this call.

import { describe, expect, it } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
import { newFeePricing } from '@kuiralabs/midnight-cli-core/engine';
import { ConvergingDustTransacting } from '../dust-wallet.ts';
import { estimateFeeAsBalanced, type BalancingWallets } from '../fee-as-balanced.ts';
import { CAPTURED_AT, ledgerParams, secretKey, state, transacting } from './helpers/dust-balancing-case.ts';
import { COIN_CALL_LANDED_HEX, COIN_CALL_SHIELDED_BALANCING_HEX, COIN_CALL_UNPROVEN_HEX } from './fixtures/shielded-coin-call.ts';
import { TTL } from '../../../../test-support/ledger-tx.ts';

type Tx = ledger.FinalizedTransaction;
const unproven = (hex: string) => ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(hex, 'hex')) as unknown as Tx;
const CALL = unproven(COIN_CALL_UNPROVEN_HEX);
const BALANCING = unproven(COIN_CALL_SHIELDED_BALANCING_HEX);
const LANDED = ledger.Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(COIN_CALL_LANDED_HEX, 'hex')) as unknown as Tx;
const MARGIN = newFeePricing().feeBlocksMargin;

/** The Dust wallet's estimate: mn's transacting on the fixture wallet, as the SDK's Dust wallet runs it. */
const mine = transacting(ConvergingDustTransacting, { costParameters: newFeePricing() });
const dust: BalancingWallets<Tx, Tx>['dust'] = {
  estimateFee: async (transactions) => {
    const fee = mine.estimateFee(secretKey, state, [...transactions], TTL, CAPTURED_AT, ledgerParams);
    if (fee._tag === 'Left') throw fee.left;
    return fee.right;
  },
};

/** The shielded wallet, answering with the balancing it made for the call (none for anything else), and what it was asked to release. */
function shieldedWallet() {
  const released: Tx[] = [];
  return {
    released,
    balanceTransaction: async (tx: Tx) => (tx === CALL ? BALANCING : undefined),
    revertTransaction: async (tx: Tx) => { released.push(tx); },
  };
}

describe('a call that gives a contract a shielded coin, priced as the wallet balances it', () => {
  it('is priced at what the wallet commits for the transaction the chain took, where the call priced alone falls short of its fee even with the margin', async () => {
    const shielded = shieldedWallet();
    const asBalanced = await estimateFeeAsBalanced({ shielded, dust }, CALL, TTL);
    // What the wallet commits for the transaction the chain took: its fee with mn's margin, at the same prices.
    const committedForLanded = LANDED.feesWithMargin(ledgerParams, MARGIN);

    // The regression: the call alone (the facade's estimateTransactionFee) is under the landed transaction's fee itself.
    const alone = await dust.estimateFee([CALL]);
    expect(alone).toBeLessThan(LANDED.fees(ledgerParams));

    // With the shielded balancing: within 2% of what the wallet commits for the landed transaction, and above its fee.
    expect(asBalanced).toBeGreaterThan(LANDED.fees(ledgerParams));
    expect(Math.abs(Number(asBalanced - committedForLanded)) / Number(committedForLanded)).toBeLessThan(0.02);
    expect(shielded.released).toEqual([BALANCING]);
  });

  it('prices a transaction that owes no shielded coin alone, booking nothing', async () => {
    const shielded = shieldedWallet();
    const plain = unproven(COIN_CALL_SHIELDED_BALANCING_HEX);
    expect(await estimateFeeAsBalanced({ shielded, dust }, plain, TTL)).toBe(await dust.estimateFee([plain]));
    expect(shielded.released).toEqual([]);
  });

  it('releases the booked coins when the estimate fails, and throws the estimate\'s failure', async () => {
    const shielded = shieldedWallet();
    const short = new Error('Insufficient Funds: could not balance dust');
    const failing = { estimateFee: async () => { throw short; } };
    await expect(estimateFeeAsBalanced({ shielded, dust: failing }, CALL, TTL)).rejects.toBe(short);
    expect(shielded.released).toEqual([BALANCING]);
  });

  it('throws the estimate\'s failure even when the release fails too', async () => {
    const short = new Error('Insufficient Funds: could not balance dust');
    const shielded = { balanceTransaction: async () => BALANCING, revertTransaction: async () => { throw new Error('release failed'); } };
    await expect(estimateFeeAsBalanced({ shielded, dust: { estimateFee: async () => { throw short; } } }, CALL, TTL)).rejects.toBe(short);
  });
});
