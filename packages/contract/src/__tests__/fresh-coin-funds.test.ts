// A call whose fresh coins the wallet's shielded balance can't cover: the
// SDK's bare "Insufficient funds" becomes INSUFFICIENT_BALANCE saying what
// the coins came to.

import { describe, expect, it } from 'vitest';
import { InsufficientBalanceError } from '@kuiralabs/midnight-cli-core';
import { expandCoinShorthands } from '../lib/contract/coin-shorthand.ts';
import { freshCoinTotals, namingFreshCoinShortfall } from '../lib/contract/fresh-coin-funds.ts';
import { mapSizeText } from '../commands/contract.ts';

const COIN_TYPE = { 'type-name': 'Struct', name: 'ShieldedCoinInfo', elements: [
  { name: 'nonce', type: { 'type-name': 'Bytes', length: 32 } },
  { name: 'color', type: { 'type-name': 'Bytes', length: 32 } },
  { name: 'value', type: { 'type-name': 'Uint', maxval: 2 ** 64 - 1 } },
] } as never;
const OTHER = 'ab'.repeat(32);

const expanded = expandCoinShorthands(
  [{ '@coin': { amount: '100' } }, [{ '@coin': { amount: '0.5', token: 'NIGHT' } }, { '@coin': { amount: '7', token: OTHER } }]],
  [{ name: 'coin', type: COIN_TYPE }, { name: 'coins', type: { 'type-name': 'Vector', length: 2, type: COIN_TYPE } as never }],
);

describe('freshCoinTotals', () => {
  it('adds the fresh coins up by token, in each one\'s smallest unit (NIGHT by default)', () => {
    expect(freshCoinTotals(expanded.args, expanded.freshCoins)).toEqual(new Map([['NIGHT', 100_500_000n], [OTHER, 7n]]));
  });
});

describe('namingFreshCoinShortfall', () => {
  const sdkRefusal = new Error('Insufficient funds');

  it('names what the fresh coins came to and where to see the shielded balance', () => {
    const named = namingFreshCoinShortfall(sdkRefusal, expanded.args, expanded.freshCoins, 'alice');
    expect(named).toBeInstanceOf(InsufficientBalanceError);
    expect((named as Error).message).toBe(`The wallet's shielded balance doesn't cover the fresh coins this call gives the contract: 100.500000 NIGHT and 7 of token ${OTHER}, paid from shielded coins (the fee is paid in Dust). mn balance --wallet alice shows its shielded NIGHT; on the local network, mn airdrop <amount> --shielded adds some.`);
    expect((named as Error).cause).toBe(sdkRefusal);
  });

  it('leaves a Dust shortage, another failure and a call with no fresh coin as they are', () => {
    const dust = new Error('Insufficient Funds: could not balance dust');
    expect(namingFreshCoinShortfall(dust, expanded.args, expanded.freshCoins, undefined)).toBe(dust);
    const other = new Error('Version mismatch');
    expect(namingFreshCoinShortfall(other, expanded.args, expanded.freshCoins, undefined)).toBe(other);
    expect(namingFreshCoinShortfall(sdkRefusal, [1], [], undefined)).toBe(sdkRefusal);
  });
});

describe('mapSizeText', () => {
  it('says one entry, many entries, or that the size is unknown', () => {
    expect(mapSizeText(1)).toBe('Map (1 entry)');
    expect(mapSizeText(0)).toBe('Map (0 entries)');
    expect(mapSizeText(3)).toBe('Map (3 entries)');
    expect(mapSizeText(null)).toBe('Map (size unknown)');
  });
});
