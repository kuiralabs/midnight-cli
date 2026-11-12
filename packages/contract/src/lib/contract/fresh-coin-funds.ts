// A call that gives a contract fresh coins ({"@coin": ...}) pays for them
// from the wallet's shielded balance. When that balance is short, the wallet
// SDK refuses with a bare "Insufficient funds"; this says what the coins
// came to and where the shielded balance is seen. The amounts are the
// user's own, said back to them on their terminal (or in the error of their
// own call), never anywhere else.

import { InsufficientBalanceError } from '@kuiralabs/midnight-cli-core';
import { toNight } from '@kuiralabs/midnight-cli-core/ui';
import type { FreshCoin } from './coin-shorthand.ts';

/** NIGHT's raw type: 32 zero bytes. */
const NIGHT_COLOR = '00'.repeat(32);

const hexOf = (bytes: unknown): string | undefined =>
  Array.isArray(bytes) && bytes.every((b) => typeof b === 'number') ? bytes.map((b: number) => b.toString(16).padStart(2, '0')).join('') : undefined;

/**
 * What the fresh coins in `callArgs` come to, by token (NIGHT, or the raw
 * type in hex), in each token's smallest unit: the coins mn made, found by
 * their nonces among the expanded arguments.
 */
export function freshCoinTotals(callArgs: readonly unknown[], freshCoins: readonly FreshCoin[]): Map<string, bigint> {
  const nonces = new Set(freshCoins.map((coin) => coin.nonce));
  const totals = new Map<string, bigint>();
  const pending: unknown[] = [...callArgs];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object') continue;
    const coin = value as { nonce?: unknown; color?: unknown; value?: unknown };
    const nonce = hexOf(coin.nonce);
    if (nonce !== undefined && nonces.has(nonce) && typeof coin.value === 'string') {
      const color = hexOf(coin.color) ?? '';
      const token = color === NIGHT_COLOR ? 'NIGHT' : color;
      totals.set(token, (totals.get(token) ?? 0n) + BigInt(coin.value.replace(/n$/, '')));
      continue;
    }
    pending.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return totals;
}

/** Whether `err` is the wallet's refusal for want of a token's coins (not of Dust, which the fee needs). */
function isShortOfCoins(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /insufficient funds/i.test(message) && !/dust/i.test(message);
}

/**
 * The call's failure as INSUFFICIENT_BALANCE naming what its fresh coins came
 * to, when the wallet refused for want of coins and the call gave fresh
 * coins; else `err` as it is.
 */
export function namingFreshCoinShortfall(err: unknown, callArgs: readonly unknown[], freshCoins: readonly FreshCoin[], wallet: string | undefined): unknown {
  if (freshCoins.length === 0 || !isShortOfCoins(err)) return err;
  const totals = freshCoinTotals(callArgs, freshCoins);
  if (totals.size === 0) return err;
  const amounts = [...totals].sort(([a], [b]) => Number(b === 'NIGHT') - Number(a === 'NIGHT')).map(([token, value]) => token === 'NIGHT' ? `${toNight(value)} NIGHT` : `${value} of token ${token}`).join(' and ');
  const balance = `mn balance${wallet === undefined ? '' : ` --wallet ${wallet}`}`;
  return new InsufficientBalanceError(
    `The wallet's shielded balance doesn't cover the fresh ${freshCoins.length === 1 ? 'coin' : 'coins'} this call gives the contract: ${amounts}, paid from shielded coins (the fee is paid in Dust). ` +
    `${balance} shows its shielded NIGHT; on the local network, mn airdrop <amount> --shielded adds some.`,
    { cause: err },
  );
}
