// A contract script whose fee mn serve's node refused as too low runs again:
// mn serve answers FEE_REPRICED (it now prices with a larger margin), and the
// script reports that code as it reports any of mn serve's (ContractScriptError).

import { describe, expect, it } from 'vitest';
import { ContractScriptError } from '../lib/contract/runner.ts';
import { runRepricing } from '../lib/contract/served-wallet.ts';
import { RERUN_DOUBLE_SPENT_STATUS, RERUN_REPRICED_STATUS } from '@kuiralabs/midnight-cli-core';

const repriced = () => new ContractScriptError({ message: 'The node refused the fee as too low (priced with 3 blocks of margin). The wallet now prices fees with 5 blocks: balance the transaction again and submit it.', code: 'FEE_REPRICED' });

/** A script run that fails with each of `failures` in turn, then reports `result`. */
function scriptRun(failures: Error[], result = 'deployed') {
  let runs = 0;
  return {
    run: async () => {
      const failure = failures[runs++];
      if (failure !== undefined) throw failure;
      return result;
    },
    runs: () => runs,
  };
}

describe('runRepricing', () => {
  it('runs the script again after each FEE_REPRICED, saying so', async () => {
    const script = scriptRun([repriced(), repriced()]);
    const statuses: string[] = [];

    expect(await runRepricing(script.run, (status) => statuses.push(status), undefined)).toBe('deployed');

    expect(script.runs()).toBe(3);
    expect(statuses).toEqual([
      RERUN_REPRICED_STATUS,
      RERUN_REPRICED_STATUS,
    ]);
  });

  it('stops after one run per margin mn serve can move to', async () => {
    const last = repriced();
    const script = scriptRun([repriced(), repriced(), last]);

    await expect(runRepricing(script.run, () => {}, undefined)).rejects.toBe(last);
    expect(script.runs()).toBe(3);
  });

  it('does not run again for any other failure, FEE_TOO_LOW included', async () => {
    const tooLow = new ContractScriptError({ message: 'The node refused the fee as too low (0.7 DUST, priced with 8 blocks of margin, the most mn tries).', code: 'FEE_TOO_LOW' });
    const script = scriptRun([tooLow]);

    await expect(runRepricing(script.run, () => {}, undefined)).rejects.toBe(tooLow);
    expect(script.runs()).toBe(1);
  });

  it('runs the script again after DUST_DOUBLE_SPENT, at most twice', async () => {
    const spent = () => new ContractScriptError({ message: 'Another transaction from this wallet spent the same Dust first', code: 'DUST_DOUBLE_SPENT' });
    const statuses: string[] = [];
    expect(await runRepricing(scriptRun([spent(), spent()]).run, (status) => statuses.push(status), undefined)).toBe('deployed');
    expect(statuses).toEqual([RERUN_DOUBLE_SPENT_STATUS, RERUN_DOUBLE_SPENT_STATUS]);

    const third = spent();
    const script = scriptRun([spent(), spent(), third]);
    await expect(runRepricing(script.run, () => {}, undefined)).rejects.toBe(third);
    expect(script.runs()).toBe(3);
  });
});
