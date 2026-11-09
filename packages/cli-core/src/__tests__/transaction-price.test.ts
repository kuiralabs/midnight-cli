// A transaction's price before it is proven. The wallet's fee estimate and
// its Dust state are the SDK's, at the interface boundary: an estimate that
// answers or refuses as the SDK does (a shortage marked with what the fee
// takes), and a balance that grows linearly as registered NIGHT generates it.

import { describe, it, expect } from 'vitest';
import { priceTransaction, transactionPriceFromWire, transactionPriceToWire } from '../lib/transaction-price.ts';
import { MN_RPC_METHOD_PREFIX, PRICE_TRANSACTION_METHOD } from '../lib/constants.ts';
import { withDustShortfall } from '../lib/sdk-errors.ts';

const NOW = new Date('2026-11-08T05:00:00Z');
/** A balance of `start` specks at NOW, growing `perSecond` specks a second. */
const growing = (start: bigint, perSecond: bigint) => ({
  balance: (at: Date) => start + perSecond * BigInt(Math.max(0, Math.floor((at.getTime() - NOW.getTime()) / 1000))),
});
// 1000 NIGHT registered, 0.35 DUST held: +0.0083 DUST a second.
const WALLET = growing(350_000_000_000_000n, 8_300_000_000_000n);
// A counter deploy's fee with 3 blocks of margin on a ledger-9 local chain.
const COMMITTED = 1_236_000_000_000_000n;
/** The SDK's refusal of a fee the wallet's Dust doesn't cover, as mn's fee planner marks it. */
const shortOf = (needed: bigint, available: bigint) => withDustShortfall(Object.assign(new Error('Insufficient Funds: could not balance dust'), {
  _tag: 'Wallet.InsufficientFunds', tokenType: 'dust',
}), { needed, available });

describe('PRICE_TRANSACTION_METHOD', () => {
  it('is one of mn serve\'s own methods, apart from the DApp connector API\'s', () => {
    expect(PRICE_TRANSACTION_METHOD).toBe('mn_priceTransaction');
    expect(PRICE_TRANSACTION_METHOD.startsWith(MN_RPC_METHOD_PREFIX)).toBe(true);
  });
});

describe('priceTransaction', () => {
  it('prices a fee the wallet covers: what it commits, what it has, no wait', async () => {
    const rich = growing(5_000_000_000_000_000n, 0n);
    expect(await priceTransaction(async () => COMMITTED, rich, 3, NOW)).toEqual({
      committed: COMMITTED, have: 5_000_000_000_000_000n, covers: true, waitMs: 0, marginBlocks: 3,
    });
  });

  it('prices a fee the wallet falls short of at what the fee takes, with the time its NIGHT needs for the rest', async () => {
    // 0.886 DUST short at 0.0083 a second: 107 seconds.
    const price = await priceTransaction(async () => { throw shortOf(COMMITTED, 350_000_000_000_000n); }, WALLET, 3, NOW);
    expect(price).toEqual({ committed: COMMITTED, have: 350_000_000_000_000n, covers: false, waitMs: 107_000, marginBlocks: 3 });
  });

  it('times the growth the shortfall needs, not a balance to reach: the wallet\'s clock for the chain needn\'t be this machine\'s', async () => {
    // The wallet priced at a chain time when its coins held 0.2 DUST; at NOW the balance reads 0.35. The wait is still for 1.036 DUST more.
    const price = await priceTransaction(async () => { throw shortOf(COMMITTED, 200_000_000_000_000n); }, WALLET, 3, NOW);
    expect(price.have).toBe(200_000_000_000_000n);
    expect(price.waitMs).toBe(125_000);
  });

  it('says null for a wait past a day: the wallet generates too little', async () => {
    const trickle = growing(0n, 1_000n);
    const price = await priceTransaction(async () => { throw shortOf(COMMITTED, 0n); }, trickle, 5, NOW);
    expect(price).toEqual({ committed: COMMITTED, have: 0n, covers: false, waitMs: null, marginBlocks: 5 });
  });

  it('throws any other failure of the estimate as it is', async () => {
    const offline = new Error('Wallet not synced yet');
    await expect(priceTransaction(async () => { throw offline; }, WALLET, 3, NOW)).rejects.toBe(offline);
    // A shortage with no shortfall says nothing to price with.
    const unmarked = Object.assign(new Error('Insufficient Funds: could not balance dust'), { _tag: 'Wallet.InsufficientFunds' });
    await expect(priceTransaction(async () => { throw unmarked; }, WALLET, 3, NOW)).rejects.toBe(unmarked);
  });
});

describe('the price on the wire', () => {
  it('crosses JSON-RPC as decimal strings of Specks and comes back the same', () => {
    const price = { committed: COMMITTED, have: 350_000_000_000_000n, covers: false, waitMs: 107_000, marginBlocks: 3 };
    const wire = transactionPriceToWire(price);
    expect(wire).toEqual({ committed: '1236000000000000', have: '350000000000000', covers: false, waitMs: 107_000, marginBlocks: 3 });
    expect(transactionPriceFromWire(JSON.parse(JSON.stringify(wire)))).toEqual(price);
  });

  it('keeps a null wait', () => {
    expect(transactionPriceFromWire({ committed: '1', have: '0', covers: false, waitMs: null, marginBlocks: 3 }).waitMs).toBeNull();
  });

  it('refuses what is not a price, naming the method', () => {
    for (const bad of [
      undefined,
      { committed: 1236, have: '0', covers: true, waitMs: 0, marginBlocks: 3 },
      { committed: '-1', have: '0', covers: true, waitMs: 0, marginBlocks: 3 },
      { committed: '1', have: '0', covers: 'yes', waitMs: 0, marginBlocks: 3 },
      { committed: '1', have: '0', covers: true, waitMs: -5, marginBlocks: 3 },
      { committed: '1', have: '0', covers: true, waitMs: 0, marginBlocks: 2.5 },
    ]) {
      expect(() => transactionPriceFromWire(bad)).toThrow(`mn serve answered ${PRICE_TRANSACTION_METHOD} with something that is not a price`);
    }
  });
});
