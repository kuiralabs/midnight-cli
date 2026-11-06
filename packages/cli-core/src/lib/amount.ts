// Amounts of NIGHT as people write them, and in the micro-NIGHT the chain counts.

import { UsageError } from './errors.ts';

/** NIGHT's smallest unit is 10^-6 NIGHT. */
const NIGHT_DECIMALS = 6;
const MICRO_PER_NIGHT = 10n ** BigInt(NIGHT_DECIMALS);

/**
 * Convert NIGHT amount to micro-NIGHT (bigint), for amounts mn's own code
 * holds as numbers (a default, a count from a config). Rounds to 6 decimals.
 */
export function nightToMicro(amountNight: number): bigint {
  if (amountNight <= 0) {
    throw new Error('Amount must be greater than 0');
  }
  if (!Number.isFinite(amountNight)) {
    throw new Error('Amount must be a finite number');
  }
  // Use string math to avoid floating point rounding issues
  const str = amountNight.toFixed(6);
  const [whole, frac] = str.split('.');
  const microStr = whole! + (frac ?? '').padEnd(6, '0');
  const micro = BigInt(microStr);
  if (micro <= 0n) {
    throw new Error('Amount too small — minimum is 0.000001 NIGHT');
  }
  return micro;
}

/**
 * Parse and validate amount string from CLI input: a plain decimal with at
 * most 6 decimals. Returns it exactly, in micro-NIGHT: the digits are read as
 * an integer, never through a number, so no amount loses its last digits.
 */
export function parseAmount(amountStr: string): bigint {
  const text = amountStr.trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === '' && !match[2])) {
    throw new UsageError(`Invalid amount: "${amountStr}" — must be a positive number, e.g. 1.5`);
  }
  const decimals = match[2] ?? '';
  if (decimals.length > NIGHT_DECIMALS) {
    throw new UsageError(`Invalid amount: "${amountStr}" — NIGHT has ${NIGHT_DECIMALS} decimals, this has ${decimals.length}`);
  }
  const micro = BigInt((match[1] || '0') + decimals.padEnd(NIGHT_DECIMALS, '0'));
  if (micro <= 0n) {
    throw new UsageError(`Invalid amount: "${amountStr}" — must be greater than 0`);
  }
  return micro;
}

/**
 * An amount of micro-NIGHT in NIGHT, as a person writes it: no trailing zeros
 * and no point for a whole amount (1500000n is "1.5", 100000000n is "100").
 * The words mn prints for an amount it was given.
 */
export function nightAmountText(micro: bigint): string {
  const sign = micro < 0n ? '-' : '';
  const abs = micro < 0n ? -micro : micro;
  const fraction = (abs % MICRO_PER_NIGHT).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return `${sign}${abs / MICRO_PER_NIGHT}${fraction ? `.${fraction}` : ''}`;
}

/**
 * An amount of micro-NIGHT as a command's `--json` output carries it: a JSON
 * number of NIGHT. Exact to the smallest unit up to 2^53 micro-NIGHT (about
 * 9e9 NIGHT); past that, the nearest number.
 */
export function nightAmountJson(micro: bigint): number {
  return Number(nightAmountText(micro));
}
