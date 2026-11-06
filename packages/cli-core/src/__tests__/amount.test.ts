// Amounts as mn reads and prints them, and the sync timeouts: core's.

import { describe, it, expect } from 'vitest';
import { nightAmountJson, nightAmountText, nightToMicro, parseAmount } from '../lib/amount.ts';
import { SYNC_ATTEMPT_REMOTE_TIMEOUT_MS, SYNC_ATTEMPT_TIMEOUT_MS } from '../lib/constants.ts';
import { UsageError } from '../lib/errors.ts';
import { ERROR_CODES, EXIT_INVALID_ARGS, classifyError } from '../lib/exit-codes.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

describe('nightToMicro', () => {
  it('converts whole NIGHT to micro-NIGHT', () => {
    expect(nightToMicro(1)).toBe(1_000_000n);
    expect(nightToMicro(100)).toBe(100_000_000n);
    expect(nightToMicro(1000)).toBe(1_000_000_000n);
  });

  it('converts fractional NIGHT to micro-NIGHT', () => {
    expect(nightToMicro(0.5)).toBe(500_000n);
    expect(nightToMicro(0.000001)).toBe(1n);
    expect(nightToMicro(1.5)).toBe(1_500_000n);
    expect(nightToMicro(0.123456)).toBe(123_456n);
  });

  it('throws for zero amount', () => {
    expect(() => nightToMicro(0)).toThrow('greater than 0');
  });

  it('throws for negative amount', () => {
    expect(() => nightToMicro(-1)).toThrow('greater than 0');
  });

  it('throws for Infinity', () => {
    expect(() => nightToMicro(Infinity)).toThrow('finite number');
  });

  it('throws for NaN', () => {
    expect(() => nightToMicro(NaN)).toThrow('finite number');
  });

  it('handles large amounts', () => {
    expect(nightToMicro(999_999)).toBe(999_999_000_000n);
  });
});

describe('parseAmount: exact amounts only (NIGHT has 6 decimals)', () => {
  // Found live: "1.0000001" was accepted and 1.000000 NIGHT was sent; the
  // conversion rounds, so "1.0000005" would have sent 1.000001.
  it.each(['1.0000001', '1.0000005', '0.0000001'])('refuses %s: more decimals than NIGHT has', (input) => {
    expect(() => parseAmount(input)).toThrow(`Invalid amount: "${input}" — NIGHT has 6 decimals, this has 7`);
  });

  it.each(['1e3', '-5', '1,000', '0x10', 'Infinity', '.', '1.2.3', '+1'])('refuses %j: not a plain positive decimal', (input) => {
    expect(() => parseAmount(input)).toThrow(`Invalid amount: "${input}" — must be a positive number, e.g. 1.5`);
  });

  it.each([
    ['1.000001', 1_000_001n], ['.5', 500_000n], ['1.', 1_000_000n], [' 2 ', 2_000_000n], ['007', 7_000_000n], ['999999999.999999', 999_999_999_999_999n],
  ] as const)('accepts %j as exactly %s micro-NIGHT', (input, micro) => {
    expect(parseAmount(input)).toBe(micro);
  });

  // A JS number carries 2^53 (about 9.007e15 micro-NIGHT, 9.007e9 NIGHT) exactly; the digits are read as an integer instead.
  it.each([
    ['24000000000.000001', 24_000_000_000_000_001n],
    ['9007199254.740993', 9_007_199_254_740_993n],
    ['123456789012345678.123456', 123_456_789_012_345_678_123_456n],
  ] as const)('accepts %j, above what a number carries, as exactly %s micro-NIGHT', (input, micro) => {
    expect(parseAmount(input)).toBe(micro);
    expect(nightAmountText(parseAmount(input))).toBe(input);
  });
});

describe('parseAmount', () => {
  it('parses integer amounts', () => {
    expect(parseAmount('100')).toBe(100_000_000n);
    expect(parseAmount('1')).toBe(1_000_000n);
    expect(parseAmount('1000000')).toBe(1_000_000_000_000n);
  });

  it('parses decimal amounts', () => {
    expect(parseAmount('0.5')).toBe(500_000n);
    expect(parseAmount('1.23')).toBe(1_230_000n);
    expect(parseAmount('0.000001')).toBe(1n);
  });

  it('throws for non-numeric strings', () => {
    expect(() => parseAmount('abc')).toThrow('Invalid amount');
    expect(() => parseAmount('')).toThrow('Invalid amount');
    expect(() => parseAmount('hello')).toThrow('Invalid amount');
  });

  it('throws for zero', () => {
    expect(() => parseAmount('0')).toThrow('greater than 0');
  });

  it('throws for negative amounts', () => {
    expect(() => parseAmount('-10')).toThrow('Invalid amount: "-10" — must be a positive number');
  });

  it('throws for Infinity', () => {
    expect(() => parseAmount('Infinity')).toThrow('Invalid amount');
  });

  // `mn transfer bob 0` was reported with code UNKNOWN and exit 1.
  it('refuses a bad amount as a usage mistake, which the caller fixes', () => {
    for (const amount of ['0', '-5', 'abc', 'Infinity']) {
      const refused = (() => { try { parseAmount(amount); } catch (err) { return err as Error; } throw new Error(`${amount} was accepted`); })();
      expect(refused).toBeInstanceOf(UsageError);
      expect(classifyError(refused, CORE_CODES)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.INVALID_ARGS });
    }
  });
});

describe('nightAmountText and nightAmountJson: an amount as mn prints it', () => {
  // The words the commands printed when amounts were numbers, String(Number(text)), for amounts a number carried exactly (all parseAmount took then).
  it.each(['100', '1.5', '0.5', '0.000001', '1.000001', '123.45', '999999999.999999', '4000000000.000001', '8000000000.000011', '7', '0.1'])('%s as written, and as the number --json has always carried', (text) => {
    expect(nightAmountText(parseAmount(text))).toBe(String(Number(text)));
    expect(nightAmountJson(parseAmount(text))).toBe(Number(text));
  });

  it('drops trailing zeros and a bare point, as a number did', () => {
    expect(nightAmountText(parseAmount('1.50'))).toBe('1.5');
    expect(nightAmountText(parseAmount('2.'))).toBe('2');
    expect(nightAmountText(parseAmount('.25'))).toBe('0.25');
  });
});

describe('sync timeout constants', () => {
  it('remote timeout is longer than local timeout', () => {
    expect(SYNC_ATTEMPT_REMOTE_TIMEOUT_MS).toBeGreaterThan(SYNC_ATTEMPT_TIMEOUT_MS);
  });

  it('local timeout is 30 seconds', () => {
    expect(SYNC_ATTEMPT_TIMEOUT_MS).toBe(30_000);
  });

  it('remote timeout is 120 seconds', () => {
    expect(SYNC_ATTEMPT_REMOTE_TIMEOUT_MS).toBe(120_000);
  });
});
