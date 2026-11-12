import { describe, it, expect } from 'vitest';
import { toHex, fromHex, readTransactionTag, transactionMismatch } from '../lib/tx-serde.ts';

describe('tx-serde', () => {
  describe('toHex', () => {
    it('converts empty Uint8Array to empty string', () => {
      expect(toHex(new Uint8Array([]))).toBe('');
    });

    it('converts bytes to lowercase hex', () => {
      expect(toHex(new Uint8Array([0x00, 0xff, 0xa7, 0x3f]))).toBe('00ffa73f');
    });

    it('pads single-digit values with leading zero', () => {
      expect(toHex(new Uint8Array([0, 1, 2, 15]))).toBe('0001020f');
    });
  });

  describe('fromHex', () => {
    it('converts empty string to empty Uint8Array', () => {
      expect(fromHex('')).toEqual(new Uint8Array([]));
    });

    it('converts lowercase hex to bytes', () => {
      expect(fromHex('00ffa73f')).toEqual(new Uint8Array([0x00, 0xff, 0xa7, 0x3f]));
    });

    it('converts uppercase hex to bytes', () => {
      expect(fromHex('00FFA73F')).toEqual(new Uint8Array([0x00, 0xff, 0xa7, 0x3f]));
    });

    it('converts mixed-case hex to bytes', () => {
      expect(fromHex('aAbBcC')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    });

    it('throws on non-hex characters', () => {
      expect(() => fromHex('xyz123')).toThrow('non-hex characters');
    });

    it('throws on odd-length hex string', () => {
      expect(() => fromHex('abc')).toThrow('odd length');
    });
  });

  describe('round-trip', () => {
    it('toHex(fromHex(hex)) returns original hex (lowercase)', () => {
      const hex = 'deadbeef01020304';
      expect(toHex(fromHex(hex))).toBe(hex);
    });

    it('fromHex(toHex(bytes)) returns original bytes', () => {
      const bytes = new Uint8Array([0, 128, 255, 42, 99]);
      expect(fromHex(toHex(bytes))).toEqual(bytes);
    });
  });
});

// The tags are the ones ledger 9 writes for each stage (read from real
// transactions the test-support ledger helpers build).
const tagged = (tag: string) => Buffer.from(`midnight:transaction[v12](${tag}):`).toString('hex') + '00ff';
const UNPROVEN = tagged('signature[v2],proof-preimage,embedded-fr[v1]');
const UNSEALED = tagged('signature[v2],proof,embedded-fr[v1]');
const SEALED = tagged('signature[v2],proof,pedersen-schnorr[v1]');

describe('readTransactionTag', () => {
  it('reads the version and the stage from a transaction\'s tag', () => {
    expect(readTransactionTag(fromHex(UNPROVEN))).toEqual({ version: 'v12', stage: 'unproven' });
    expect(readTransactionTag(fromHex(UNSEALED))).toEqual({ version: 'v12', stage: 'unsealed' });
    expect(readTransactionTag(fromHex(SEALED))).toEqual({ version: 'v12', stage: 'sealed' });
  });

  it('is undefined for bytes that are no transaction', () => {
    expect(readTransactionTag(fromHex('deadbeef'))).toBeUndefined();
    expect(readTransactionTag(Buffer.from('midnight:intent[v6]:00'))).toBeUndefined();
  });

  it('gives no stage for markers it doesn\'t know', () => {
    expect(readTransactionTag(fromHex(tagged('signature[v2],no-proof,no-binding')))).toEqual({ version: 'v12', stage: undefined });
  });
});

describe('transactionMismatch', () => {
  it('says bytes that are no transaction are none', () => {
    expect(transactionMismatch('deadbeef', 'sealed')).toBe("These bytes are not a serialized Midnight transaction (they don't start with the ledger's transaction tag): pass a sealed transaction (proven and bound), serialized, as hex.");
  });

  it('says what is not hex is not hex', () => {
    expect(transactionMismatch('zz', 'unproven')).toBe('The transaction is not hex (contains non-hex characters): pass an unproven transaction (not yet proven), serialized, as hex.');
  });

  it('names the stage a transaction is at when it is another', () => {
    expect(transactionMismatch(SEALED, 'unproven')).toBe('This is a sealed transaction (proven and bound), and this takes an unproven transaction (not yet proven).');
    expect(transactionMismatch(UNPROVEN, 'unsealed')).toBe('This is an unproven transaction (not yet proven), and this takes an unsealed transaction (proven, not yet bound).');
  });

  it('is undefined for a transaction at the expected stage, whose reader\'s own failure is the reason', () => {
    expect(transactionMismatch(SEALED, 'sealed')).toBeUndefined();
  });
});
