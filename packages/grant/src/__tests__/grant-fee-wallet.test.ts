// A grant payment whose fee the wallet's node refused as too low runs again
// at the wallet's larger margin. The wallet is reached through the DApp
// connector API's submit, the fee wallet's boundary: here it answers as mn
// serve answers (FEE_REPRICED while it has a larger margin, FEE_TOO_LOW past
// the largest). The payments stand in for the account package's calls, which
// report a refused submit through midnight-js with its message alone, and
// record each step so that a run after an interruption carries on from it.

import { describe, expect, it } from 'vitest';
import { DustDoubleSpentError, FeeRepricedError, FeeTooLowError, RERUN_DOUBLE_SPENT_STATUS, RERUN_REPRICED_STATUS, dustShortError } from '@kuiralabs/midnight-cli-core';
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
    // The wallet holds the margin it raised, so the steps after the refused one go through.
    const { submitted, submit } = wallet(['h1', new FeeRepricedError(3, 5), 'h2', 'h3']);
    const payments = repricingPayments(submit);
    const deploy = recordedDeploy(3, payments.submit);

    expect(await payments.repricing(deploy.run, () => {}, undefined)).toBe('account-address');

    expect(submitted).toEqual(['step-1', 'step-2', 'step-2', 'step-3']);
    expect(deploy.landed()).toBe(3);
  });

  it('stops after two re-runs, however many steps land between them: a re-run that makes a step again never loops', async () => {
    // As a grant issue under a wallet that went back to its first margin after each landing: each re-run makes its first step
    // again (it lands), and the next is refused.
    const answers: Array<Error | string> = [];
    for (let i = 0; i < 6; i++) answers.push(`landed-${i}`, new FeeRepricedError(3, 5));
    const { submitted, submit } = wallet(answers);
    const payments = repricingPayments(submit);
    const issue = async () => { await payments.submit('prepare'); await payments.submit('issue'); return 'issued'; };

    const err = await payments.repricing(issue, () => {}, undefined).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'FEE_REPRICED' });
    expect(submitted).toEqual(['prepare', 'issue', 'prepare', 'issue', 'prepare', 'issue']);
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

  it('runs a payment again after DUST_DOUBLE_SPENT, at most twice, then reports it', async () => {
    const { submitted, submit } = wallet([new DustDoubleSpentError(0), new DustDoubleSpentError(0)]);
    const payments = repricingPayments(submit);
    const statuses: string[] = [];
    expect(await payments.repricing(recordedDeploy(1, payments.submit).run, (status) => statuses.push(status), undefined)).toBe('account-address');
    expect(submitted).toHaveLength(3);
    expect(statuses).toEqual([RERUN_DOUBLE_SPENT_STATUS, RERUN_DOUBLE_SPENT_STATUS]);

    const third = new DustDoubleSpentError(0);
    const again = wallet([new DustDoubleSpentError(0), new DustDoubleSpentError(0), third]);
    const more = repricingPayments(again.submit);
    await expect(more.repricing(recordedDeploy(1, more.submit).run, () => {}, undefined)).rejects.toBe(third);
  });

  it("reports the wallet's Dust shortage as it balanced, not midnight-js's redacted provider failure", async () => {
    // The wallet's balance refused: 1 DUST held, 16.1 needed, generated in about 6 minutes (past the 5 a command waits).
    const short = dustShortError(1_000_000_000_000_000n, 16_100_000_000_000_000n, 6 * 60_000);
    const payments = repricingPayments(async () => 'never', async () => { throw short; });
    const deploy = async () => {
      try {
        await payments.balance('the-deploy');
      } catch (err) {
        // midnight-js's ProviderFailedError: its message, with the provider's own failure redacted.
        throw new Error("balanceTx rejected the transaction. The provider's own failure is on `cause`, with its message redacted", { cause: new Error('[redacted]') });
      }
      return 'account-address';
    };

    const err = await payments.repricing(deploy, () => {}, undefined).catch((e: unknown) => e);

    expect(err).toBe(short);
    expect(err).toMatchObject({ code: 'DUST_REQUIRED' });
    expect((err as Error).message).toContain('Available: 1.000000 DUST, need ≥16.100000 DUST.');
    expect((err as Error).message).toContain("This wallet's NIGHT generates that in about 6 minutes; retry then.");
  });
});
