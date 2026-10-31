// Amounts of NIGHT as people write them, and in the micro-NIGHT the chain counts.

import { UsageError } from './errors.ts';

/** NIGHT's smallest unit is 10^-6 NIGHT. */
const NIGHT_DECIMALS = 6;

/**
 * Convert NIGHT amount to micro-NIGHT (bigint).
 * Rounds to 6 decimals: amounts from parseAmount never need rounding (it refuses those that would).
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
 * most 6 decimals, which a number carries exactly. Returns it in NIGHT.
 */
export function parseAmount(amountStr: string): number {
  const text = amountStr.trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === '' && !match[2])) {
    throw new UsageError(`Invalid amount: "${amountStr}" — must be a positive number, e.g. 1.5`);
  }
  const decimals = match[2] ?? '';
  if (decimals.length > NIGHT_DECIMALS) {
    throw new UsageError(`Invalid amount: "${amountStr}" — NIGHT has ${NIGHT_DECIMALS} decimals, this has ${decimals.length}`);
  }
  const amount = Number(text);
  if (amount <= 0) {
    throw new UsageError(`Invalid amount: "${amountStr}" — must be greater than 0`);
  }
  // Amounts travel as numbers; refuse one a number can't carry to the exact smallest unit.
  const exact = BigInt((match[1] || '0') + decimals.padEnd(NIGHT_DECIMALS, '0'));
  if (nightToMicro(amount) !== exact) {
    throw new UsageError(`Invalid amount: "${amountStr}" — too many digits to handle exactly`);
  }
  return amount;
}
