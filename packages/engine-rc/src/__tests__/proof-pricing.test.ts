// A dApp's proven contract call, priced by the wallet as it balances it. The
// SDK prices it proof-erased, each contract proof as 4832 bytes; mn prices it
// with its real proofs. Two calls a local chain took: a grant step whose proof
// is 6364 bytes, and a counter increment whose proof is 3852. The SDK's own
// transacting, mn's, and the ledger, on the two-coin fixture wallet.

import { describe, expect, it } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
import { Transacting } from '@midnightntwrk/wallet-sdk/dust/v2';
import { newFeePricing } from '@kuiralabs/midnight-cli-core/engine';
import { ConvergingDustTransacting } from '../dust-wallet.ts';
import { proofBytesUnpriced } from '../proof-pricing.ts';
import { CAPTURED_AT, coinsAt, ledgerParams, secretKey, state, transacting } from './helpers/dust-balancing-case.ts';
import { ACCOUNT_ISSUE_CALL_HEX, COUNTER_INCREMENT_CALL_HEX } from './fixtures/proven-contract-calls.ts';
import { TTL } from '../../../../test-support/ledger-tx.ts';

const proven = (hex: string) => ledger.Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(hex, 'hex')) as unknown as ledger.FinalizedTransaction;
const GRANT_CALL = proven(ACCOUNT_ISSUE_CALL_HEX);
const COUNTER_CALL = proven(COUNTER_INCREMENT_CALL_HEX);
const MARGIN = newFeePricing().feeBlocksMargin;

/** What the SDK's transacting and mn's price `tx` at, with mn's fee settings: alone, and with the wallet's smallest coin spent for it. */
function priced(tx: ledger.FinalizedTransaction) {
  const sdk = transacting(Transacting.TransactingCapabilityImplementation, { costParameters: newFeePricing() });
  const mine = transacting(ConvergingDustTransacting, { costParameters: newFeePricing() });
  const spend = [coinsAt(CAPTURED_AT)[0]!];
  return {
    sdkAlone: sdk.dryRunFee([], [tx], secretKey, state, TTL, CAPTURED_AT, ledgerParams),
    mineAlone: mine.dryRunFee([], [tx], secretKey, state, TTL, CAPTURED_AT, ledgerParams),
    sdkWithSpend: sdk.dryRunFee(spend, [tx], secretKey, state, TTL, CAPTURED_AT, ledgerParams),
    mineWithSpend: mine.dryRunFee(spend, [tx], secretKey, state, TTL, CAPTURED_AT, ledgerParams),
  };
}

/** Within a part in a million: the price is scaled in floating point, the ledger's in fixed point. */
const near = (actual: bigint, expected: bigint) => expect(Math.abs(Number(actual - expected)) / Number(expected)).toBeLessThan(1e-6);

describe('a proven contract call, priced as the wallet balances it', () => {
  it('counts the bytes its proofs differ from the erased estimate by', () => {
    expect(proofBytesUnpriced([GRANT_CALL], ledgerParams)).toBe(1640n);
    expect(proofBytesUnpriced([COUNTER_CALL], ledgerParams)).toBe(-871n);
    // A transaction whose proofs are not made yet has nothing more to count.
    expect(proofBytesUnpriced([GRANT_CALL.eraseProofs() as never], ledgerParams)).toBe(0n);
  });

  it('prices a call whose proof is larger than 4832 bytes at its real fee, where the SDK prices it under the fee even with the margin', () => {
    const real = GRANT_CALL.feesWithMargin(ledgerParams, MARGIN);
    const { sdkAlone, mineAlone } = priced(GRANT_CALL);

    // The regression: the SDK's price, margin included, is below what the call costs with its margin, and below its fee without one.
    expect(sdkAlone).toBeLessThan(real);
    expect(sdkAlone).toBeLessThan(GRANT_CALL.fees(ledgerParams));
    near(mineAlone, real);
  });

  it('prices a call whose proof is smaller than 4832 bytes lower, at its real fee', () => {
    const real = COUNTER_CALL.feesWithMargin(ledgerParams, MARGIN);
    const { sdkAlone, mineAlone } = priced(COUNTER_CALL);

    expect(sdkAlone).toBeGreaterThan(real);
    near(mineAlone, real);
  });

  it('prices the Dust spend that pays for it on top, the call still at its real size', () => {
    const { sdkWithSpend, mineAlone, mineWithSpend } = priced(GRANT_CALL);

    expect(mineWithSpend).toBeGreaterThan(mineAlone);
    expect(mineWithSpend).toBeGreaterThan(sdkWithSpend);
  });
});
