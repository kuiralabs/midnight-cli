// mn's coin picker: which shielded coin a spend takes next, skipping open
// offers' coins outside their cancel and preferring a coin of the exact amount.

import { describe, expect, it } from 'vitest';
import { createCoinPicking, pickCoin, type CoinRule } from '../lib/coin-picker.ts';
import { OfferCoinsInUseError, type OpenOffer } from '../lib/open-offers.ts';
import { heldCoinRefusalOf, isColdStartRace, toEngineError, withEngineCode } from '../lib/sdk-errors.ts';

const T = 'aa'.repeat(32);
const U = 'bb'.repeat(32);
interface Coin { type: string; value: bigint; nonce: string }
const coin = (nonce: string, value: bigint, type = T): Coin => ({ type, value, nonce });
// A coin's nullifier, here its nonce upper-cased: the picker compares nullifiers without case.
const nullifierOf = (c: Coin) => `N${c.nonce}`.toUpperCase();
const avoid = (held: Record<string, string> = {}): CoinRule => ({ kind: 'avoid', held: new Map(Object.entries(held)) });
const offer = (id: string, nullifiers: string[]): OpenOffer => ({
  id, nullifiers, terms: { give: { token: T, amount: 1n }, want: { token: U, amount: 1n } }, madeAt: new Date(0), expiresAt: new Date(1),
});

describe('pickCoin', () => {
  it('takes a coin of exactly the amount needed over a smaller one', () => {
    const coins = [coin('a', 1n), coin('b', 5n), coin('c', 9n)];
    expect(pickCoin(coins, T, 5n, nullifierOf, avoid())?.nonce).toBe('b');
  });

  it('takes the smallest coin of the token when none is exact, as the SDK does', () => {
    const coins = [coin('a', 7n), coin('b', 3n, U), coin('c', 4n)];
    expect(pickCoin(coins, T, 10n, nullifierOf, avoid())?.nonce).toBe('c');
  });

  it("skips an open offer's coin even when it is the smallest or the exact one", () => {
    const coins = [coin('a', 1n), coin('b', 998n)];
    expect(pickCoin(coins, T, 1n, nullifierOf, avoid({ na: 'offer-1' }))?.nonce).toBe('b');
  });

  it("refuses with the holding offers when only open offers' coins of the token are left", () => {
    const coins = [coin('a', 1n), coin('b', 2n), coin('c', 50n, U)];
    let thrown: unknown;
    try { pickCoin(coins, T, 3n, nullifierOf, avoid({ na: 'offer-1', nb: 'offer-2' })); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(OfferCoinsInUseError);
    expect((thrown as OfferCoinsInUseError).offerIds.sort()).toEqual(['offer-1', 'offer-2']);
  });

  it('is undefined when the wallet holds none of the token at all (the SDK reports the shortage)', () => {
    expect(pickCoin([coin('a', 5n, U)], T, 1n, nullifierOf, avoid({ na: 'offer-1' }))).toBeUndefined();
  });

  it("in a cancel, takes only the cancelled offers' coins, and is undefined once they are used", () => {
    const coins = [coin('a', 1n), coin('b', 2n), coin('c', 3n)];
    const only: CoinRule = { kind: 'only', allowed: new Set(['nb']) };
    expect(pickCoin(coins, T, 6n, nullifierOf, only)?.nonce).toBe('b');
    expect(pickCoin(coins.filter((c) => c.nonce !== 'b'), T, 4n, nullifierOf, only)).toBeUndefined();
  });
});

describe('createCoinPicking', () => {
  it('reads the open offers at each pick, so an offer made since is skipped', () => {
    let open: OpenOffer[] = [];
    const picking = createCoinPicking(() => open, nullifierOf);
    const coins = [coin('a', 1n), coin('b', 998n)];
    expect(picking.pick(coins, T, 1n)?.nonce).toBe('a');
    open = [offer('offer-1', ['NA'])];
    expect(picking.pick(coins, T, 1n)?.nonce).toBe('b');
  });

  it("lets a cancel spend only its offers' coins, and goes back to skipping them after", async () => {
    const open = [offer('offer-1', ['NA']), offer('offer-2', ['NB'])];
    const picking = createCoinPicking(() => open, nullifierOf);
    const coins = [coin('a', 1n), coin('b', 1n), coin('c', 5n)];
    const inCancel = await picking.cancelling([open[0]!], async () => picking.pick(coins, T, 1n)?.nonce);
    expect(inCancel).toBe('a');
    expect(picking.pick(coins, T, 1n)?.nonce).toBe('c');
  });

  it('goes back to skipping after a cancel that fails', async () => {
    const open = [offer('offer-1', ['NA'])];
    const picking = createCoinPicking(() => open, nullifierOf);
    await expect(picking.cancelling(open, async () => { throw new Error('proof failed'); })).rejects.toThrow('proof failed');
    expect(picking.pick([coin('a', 1n), coin('c', 5n)], T, 1n)?.nonce).toBe('c');
  });
});

describe("the picker's refusal through the SDK's wrapping", () => {
  // As the shielded wallet wraps what its balancer throws: an OtherWalletError
  // with it as the cause, inside an Effect FiberFailure.
  const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');
  const wrapped = () => {
    const refusal = new OfferCoinsInUseError(['ab'.repeat(32)]);
    const other = Object.assign(new Error('Balancing guaranteed section failed'), { _tag: 'Wallet.Other', cause: refusal });
    const fiber = Object.assign(new Error('(FiberFailure) Wallet.Other: Balancing guaranteed section failed'), { [FIBER_FAILURE_CAUSE]: { _tag: 'Fail', error: other } });
    return { refusal, fiber };
  };

  it('is found among the causes', () => {
    const { refusal, fiber } = wrapped();
    expect(heldCoinRefusalOf(fiber)).toBe(refusal);
    expect(heldCoinRefusalOf(new Error('Insufficient funds'))).toBeUndefined();
  });

  it('reaches mn as OFFER_COINS_IN_USE, and over the connector marked with it', () => {
    const { refusal, fiber } = wrapped();
    expect(toEngineError(fiber)).toBe(refusal);
    expect((withEngineCode(wrapped().fiber) as { mnCode?: string }).mnCode).toBe('OFFER_COINS_IN_USE');
  });

  it('is not the cold-start race, so the wallet is not reopened for it', () => {
    const { refusal } = wrapped();
    const tagged = Object.assign(new Error('Insufficient funds'), { _tag: 'Wallet.InsufficientFunds', tokenType: T, cause: refusal });
    expect(isColdStartRace(tagged)).toBe(false);
  });
});
