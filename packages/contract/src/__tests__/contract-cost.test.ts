// What a contract deploy or call costs before it is proven: the fee worked back
// from what the wallet commits, the cost as --json gives it, and in words.

import { describe, it, expect } from 'vitest';
import { contractCostJson, contractCostOf, costRecorder, costSentence, dustWaitPhrase, unpricedSentence, type ContractPriced } from '../lib/contract/cost.ts';

const SPECK = 1_000_000_000_000_000n;
// The ledger's largest price rise in a block in ledger 9's initial parameters: prices can rise 4.6% a block.
const ADJUSTMENT = 1.0459511985013459;
/** A counter deploy's fee on a ledger-9 local chain, 1.081 DUST, and what the wallet commits to it with 3 blocks of margin. */
const FEE = 1_081_000_000_000_000n;
const COMMITTED = BigInt(Math.floor(Number(FEE) * ADJUSTMENT ** 3));

describe('contractCostOf', () => {
  it('works the fee back from what the wallet commits: over the price rise to the power of the margin', () => {
    const cost = contractCostOf({ committed: COMMITTED, have: 5n * SPECK, covers: true, waitMs: 0, marginBlocks: 3 }, ADJUSTMENT);
    // Within a Speck in a thousand of the fee (the committed amount was rounded down to the Speck).
    expect(Number(cost.fee - FEE)).toBeLessThan(1_000);
    expect(Number(FEE - cost.fee)).toBeLessThan(1_000);
    expect(cost).toMatchObject({ committed: COMMITTED, have: 5n * SPECK, covers: true, waitSeconds: 0, marginBlocks: 3 });
  });

  it('is the committed amount itself with no margin', () => {
    expect(contractCostOf({ committed: COMMITTED, have: 0n, covers: false, waitMs: null, marginBlocks: 0 }, ADJUSTMENT).fee).toBe(COMMITTED);
  });

  it('keeps the wait in whole seconds, up, and a wait past a day as null', () => {
    const at = (waitMs: number | null) => contractCostOf({ committed: COMMITTED, have: 0n, covers: false, waitMs, marginBlocks: 3 }, ADJUSTMENT).waitSeconds;
    expect(at(107_000)).toBe(107);
    expect(at(107_001)).toBe(108);
    expect(at(null)).toBeNull();
  });

  it('divides a fee past 2^53 Specks exactly enough', () => {
    const large = 40n * SPECK;
    const cost = contractCostOf({ committed: large, have: 0n, covers: false, waitMs: null, marginBlocks: 3 }, ADJUSTMENT);
    const expected = Number(large) / ADJUSTMENT ** 3;
    expect(Math.abs(Number(cost.fee) - expected) / expected).toBeLessThan(1e-9);
  });
});

describe('contractCostJson', () => {
  it('gives the amounts as DUST in decimal strings, NIGHT-style, and the rest as they are', () => {
    const cost = { fee: FEE, committed: 1_236_830_000_000_000n, have: 350_000_000_000_000n, covers: false, waitSeconds: 107, marginBlocks: 3 };
    expect(contractCostJson(cost)).toEqual({ fee: '1.081000', committed: '1.236830', have: '0.350000', covers: false, waitSeconds: 107, marginBlocks: 3 });
  });
});

describe('dustWaitPhrase', () => {
  it('says how long the rest takes, and whether mn waits that long (up to 5 minutes)', () => {
    expect(dustWaitPhrase(107)).toBe('its registered NIGHT generates the rest in about 2 minutes, which mn waits for');
    expect(dustWaitPhrase(3_600)).toBe('its registered NIGHT generates the rest in about 60 minutes, longer than the about 5 minutes mn waits');
  });

  it('says to register more NIGHT when the rest is more than a day away', () => {
    expect(dustWaitPhrase(null)).toBe('its registered NIGHT won\'t generate the rest within a day (register more: midnight dust register)');
  });
});

describe('costSentence', () => {
  it('names the fee, what the wallet commits and holds, and that it covers it', () => {
    expect(costSentence({ fee: '1.081000', committed: '1.236830', have: '5.000000', covers: true, waitSeconds: 0, marginBlocks: 3 })).toBe(
      'Expected fee 1.081000 DUST at the chain\'s prices now; the wallet commits 1.236830 DUST to it (3 blocks of margin, all of it burned) and holds 5.000000 DUST, which covers it',
    );
  });

  it('says how long a wallet short of it waits', () => {
    expect(costSentence({ fee: '1.081000', committed: '1.236830', have: '0.350000', covers: false, waitSeconds: 107, marginBlocks: 3 })).toBe(
      'Expected fee 1.081000 DUST at the chain\'s prices now; the wallet commits 1.236830 DUST to it (3 blocks of margin, all of it burned) and holds 0.350000 DUST, '
      + 'short of it: its registered NIGHT generates the rest in about 2 minutes, which mn waits for',
    );
  });
});

describe('unpricedSentence', () => {
  it('says why the cost is missing in the failure\'s first line, with no full stop of its own', () => {
    const noNight = new Error('Wallet has 0 NIGHT on undeployed.\n\n  Fund your wallet before deploying:\n    Run: midnight airdrop 1000\n');
    expect(unpricedSentence(noNight)).toBe('Its cost could not be worked out first (Wallet has 0 NIGHT on undeployed)');
    expect(unpricedSentence('connect ECONNREFUSED 127.0.0.1:1')).toBe('Its cost could not be worked out first (connect ECONNREFUSED 127.0.0.1:1)');
  });
});

describe('costRecorder', () => {
  it('turns each price into a cost, says it, and keeps the last', () => {
    const said: ContractPriced[] = [];
    const recorder = costRecorder(ADJUSTMENT, (event) => said.push(event));
    expect(recorder.cost()).toBeUndefined();
    recorder.onPrice({ committed: COMMITTED, have: 5n * SPECK, covers: true, waitMs: 0, marginBlocks: 3 });
    recorder.onPrice({ committed: 2n * COMMITTED, have: 5n * SPECK, covers: true, waitMs: 0, marginBlocks: 3 });
    expect(said.map((event) => event.kind)).toEqual(['contract-priced', 'contract-priced']);
    expect(recorder.cost()).toEqual(said[1]!.cost);
    expect(recorder.cost()!.committed).toBe(2n * COMMITTED);
  });
});
