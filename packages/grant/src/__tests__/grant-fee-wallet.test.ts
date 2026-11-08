// A grant payment whose fee the wallet's node refused as too low runs again
// at the wallet's larger margin. The wallet is reached through the DApp
// connector API's submit, the fee wallet's boundary: here it answers as mn
// serve answers (FEE_REPRICED while it has a larger margin, FEE_TOO_LOW past
// the largest). The payments stand in for the account package's calls, which
// report a refused submit through midnight-js with its message alone, and
// record each step so that a run after an interruption carries on from it.

import { describe, expect, it } from 'vitest';
import { FeeRepricedError, FeeTooLowError, RERUN_REPRICED_STATUS } from '@kuiralabs/midnight-cli-core';
import { repricingPayments } from '../lib/grant/fee-wallet.ts';

/** A wallet whose submit answers each transaction in turn with the next of `answers` (an error, or its hash); every later one goes through. */
function wallet(answers: Array<Error | string>) {
  const submitted: string[] = [];
  const submit = async (tx: string): Promise<string> => {
    submitted.push(tx);
    const answer = answers.shift() ?? `hash-of-${tx}`;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { submitted, submit };
}

/** A failure as the account package reports a refused submit: midnight-js keeps the provider's message only. */
const asMidnightJsReports = (err: unknown): Error => new Error(`submitTx rejected the transaction. ${(err as Error).message}`);

/** A deploy in `steps` transactions, each recorded once it lands: run again, it carries on from the first that didn't. */
function recordedDeploy(steps: number, submit: (tx: string) => Promise<string>) {
  let landed = 0;
  const run = async (): Promise<string> => {
    while (landed < steps) {
      try {
        await submit(`step-${landed + 1}`);
      } catch (err) {
        throw asMidnightJsReports(err);
      }
      landed++;
    }
    return 'account-address';
  };
  return { run, landed: () => landed };
}

describe('repricingPayments', () => {
  it('runs a payment again after FEE_REPRICED, at most once per larger margin, saying so', async () => {
    const { submitted, submit } = wallet([new FeeRepricedError(3, 5), new FeeRepricedError(5, 8)]);
    const payments = repricingPayments(submit);
    const deploy = recordedDeploy(1, payments.submit);
    const statuses: string[] = [];

    expect(await payments.repricing(deploy.run, (status) => statuses.push(status), undefined)).toBe('account-address');

    expect(submitted).toEqual(['step-1', 'step-1', 'step-1']);
    expect(statuses).toEqual([RERUN_REPRICED_STATUS, RERUN_REPRICED_STATUS]);
  });

  it('carries a deploy on from the refused step: the steps that landed are not submitted again', async () => {
    // The wallet's margin goes back to the first after each transaction lands, so each step can be repriced in turn.
    const { submitted, submit } = wallet(['h1', new FeeRepricedError(3, 5), 'h2', new FeeRepricedError(3, 5), new FeeRepricedError(5, 8), 'h3']);
    const payments = repricingPayments(submit);
    const deploy = recordedDeploy(3, payments.submit);

    expect(await payments.repricing(deploy.run, () => {}, undefined)).toBe('account-address');

    expect(submitted).toEqual(['step-1', 'step-2', 'step-2', 'step-3', 'step-3', 'step-3']);
    expect(deploy.landed()).toBe(3);
  });

  it("fails with the wallet's FEE_TOO_LOW past the largest margin, its code kept", async () => {
    const tooLow = new FeeTooLowError(738_727_721_894_531n, 8);
    const { submitted, submit } = wallet([new FeeRepricedError(3, 5), new FeeRepricedError(5, 8), tooLow]);
    const payments = repricingPayments(submit);

    const err = await payments.repricing(recordedDeploy(1, payments.submit).run, () => {}, undefined).catch((e: unknown) => e);

    expect(err).toBe(tooLow);
    expect(err).toMatchObject({ code: 'FEE_TOO_LOW', marginBlocks: 8 });
    expect(submitted).toHaveLength(3);
  });

  it('does not run a payment again for any other failure', async () => {
    const refused = new Error('The node refused the transaction: 1010: Invalid Transaction: Custom error: 115');
    const { submitted, submit } = wallet([refused]);
    const payments = repricingPayments(submit);

    const err = await payments.repricing(recordedDeploy(1, payments.submit).run, () => {}, undefined).catch((e: unknown) => e);

    expect((err as Error).message).toBe(`submitTx rejected the transaction. ${refused.message}`);
    expect(submitted).toHaveLength(1);
  });
});
