// {"@coin": {"amount": "3", "token": "NIGHT"}} is a fresh shielded coin: a
// random nonce, the token's colour and the amount in its smallest unit,
// checked against the type the circuit gives the argument.

import { describe, expect, it } from 'vitest';
import { UsageError } from '@kuiralabs/midnight-cli-core';
import { coerceArg } from '../lib/contract/arg-coerce.ts';
import { expandCoinShorthands, hasCoinShorthand, type TypedArgument } from '../lib/contract/coin-shorthand.ts';
import type { CompactType } from '../lib/contract/inspect.ts';

const BYTES32: CompactType = { 'type-name': 'Bytes', length: 32 };
const COIN: CompactType = {
  'type-name': 'Struct', name: 'ShieldedCoinInfo',
  elements: [{ name: 'nonce', type: BYTES32 }, { name: 'color', type: BYTES32 }, { name: 'value', type: { 'type-name': 'Uint', maxval: 2 ** 128 } }],
};
const UINT64: CompactType = { 'type-name': 'Uint', maxval: 2 ** 64 };
const LOCK: TypedArgument[] = [{ name: 'coin', type: COIN }, { name: 'unlock', type: UINT64 }];
/** Nonces counted up from 1, so each expansion is known. */
const counting = (): ((size: number) => Uint8Array) => {
  let next = 0;
  return (size) => new Uint8Array(size).fill(++next);
};

describe('expandCoinShorthands', () => {
  it('makes a fresh NIGHT coin: a random nonce, the zero colour, the amount in micro-NIGHT; the circuit then gets bytes and a bigint', () => {
    const { args, freshCoins } = expandCoinShorthands([{ '@coin': { amount: '3', token: 'NIGHT' } }, 1794378400], LOCK, counting());
    expect(args).toEqual([{ nonce: new Array(32).fill(1), color: new Array(32).fill(0), value: '3000000n' }, 1794378400]);
    expect(freshCoins).toEqual([{ argument: 'coin', nonce: '01'.repeat(32) }]);
    expect(coerceArg(args[0])).toEqual({ nonce: new Uint8Array(32).fill(1), color: new Uint8Array(32), value: 3_000_000n });
  });

  it('takes NIGHT as the default token, decimals down to one micro-NIGHT, and an amount as a number', () => {
    expect(expandCoinShorthands([{ '@coin': { amount: '0.000001' } }, 1], LOCK, counting()).args[0]).toMatchObject({ value: '1n' });
    expect(expandCoinShorthands([{ '@coin': { amount: 2.5, token: 'night' } }, 1], LOCK, counting()).args[0]).toMatchObject({ value: '2500000n' });
  });

  it('takes another token by its raw type, its amount in the token\'s smallest unit', () => {
    const color = 'c0'.repeat(32);
    const { args } = expandCoinShorthands([{ '@coin': { amount: '42', token: `0x${color}` } }, 1], LOCK, counting());
    expect(args[0]).toEqual({ nonce: new Array(32).fill(1), color: new Array(32).fill(0xc0), value: '42n' });
  });

  it('expands every shorthand anywhere the circuit takes a coin, each with its own nonce', () => {
    const PAIR: TypedArgument[] = [
      { name: 'bet', type: { 'type-name': 'Struct', name: 'Bet', elements: [{ name: 'coin', type: COIN }, { name: 'color', type: UINT64 }] } },
      { name: 'coins', type: { 'type-name': 'Vector', length: 2, type: COIN } },
    ];
    const { args, freshCoins } = expandCoinShorthands([
      { coin: { '@coin': { amount: '1' } }, color: 1 },
      [{ '@coin': { amount: '2' } }, { '@coin': { amount: '3' } }],
    ], PAIR, counting());
    expect(freshCoins).toEqual([
      { argument: 'bet.coin', nonce: '01'.repeat(32) },
      { argument: 'coins[0]', nonce: '02'.repeat(32) },
      { argument: 'coins[1]', nonce: '03'.repeat(32) },
    ]);
    expect((args[1] as { value: string }[]).map((coin) => coin.value)).toEqual(['2000000n', '3000000n']);
  });

  it('leaves arguments without a shorthand as they are, and makes no coin', () => {
    expect(expandCoinShorthands([{ nonce: [1], color: [0], value: '5n' }, 7], LOCK)).toEqual({ args: [{ nonce: [1], color: [0], value: '5n' }, 7], freshCoins: [] });
    expect(hasCoinShorthand([{ coin: 1 }, [2]])).toBe(false);
    expect(hasCoinShorthand([1, { a: [{ '@coin': {} }] }])).toBe(true);
  });

  it.each([
    [[1, { '@coin': { amount: '3' } }], 'unlock: "@coin" stands only where the circuit takes a ShieldedCoinInfo, and unlock is a Uint.'],
    [[{ '@coin': { amount: '3' }, extra: 1 }, 1], 'coin: a "@coin" object has no other keys (found "extra").'],
    [[{ '@coin': '3' }, 1], 'coin: "@coin" takes an object'],
    [[{ '@coin': { amount: '3', colour: 'NIGHT' } }, 1], 'coin: "@coin" takes "amount" and "token" only (found "colour").'],
    [[{ '@coin': { token: 'NIGHT' } }, 1], 'coin: "amount" is missing or not a number.'],
    [[{ '@coin': { amount: '0' } }, 1], 'coin: "amount" must be more than 0.'],
    [[{ '@coin': { amount: '1.0000001' } }, 1], 'coin: "amount" has more than 6 decimals'],
    [[{ '@coin': { amount: '-3' } }, 1], 'coin: "amount" is not a NIGHT amount.'],
    [[{ '@coin': { amount: '3.5', token: 'ab'.repeat(32) } }, 1], 'coin: "amount" of a token given by its raw type is a whole number'],
    [[{ '@coin': { amount: '18446744073709551616', token: 'ab'.repeat(32) } }, 1], 'coin: "amount" is more than a coin can hold'],
    [[{ '@coin': { amount: '3', token: 'DUST' } }, 1], 'coin: "token" is "NIGHT" or a token\'s raw type as 64 hex characters'],
  ])('refuses %j as a usage mistake, quoting no amount or token', (args, message) => {
    const run = () => expandCoinShorthands(args, LOCK, counting());
    expect(run).toThrow(UsageError);
    expect(run).toThrow(message);
    try { run(); } catch (err) {
      expect((err as Error).message).not.toMatch(/1\.0000001|18446744073709551616|DUST|3\.5/);
    }
  });

  it('refuses a shorthand where the types are unknown: a constructor\'s', () => {
    expect(() => expandCoinShorthands([{ '@coin': { amount: '3' } }], undefined)).toThrow('a constructor\'s argument types aren\'t in contract-info.json');
    expect(expandCoinShorthands([1, 'x'], undefined)).toEqual({ args: [1, 'x'], freshCoins: [] });
  });
});
