import { describe, it, expect } from 'vitest';
import { resolvePrivateStateSecretKey } from '../lib/contract/private-state-secret.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('resolvePrivateStateSecretKey', () => {
  const given = 'aa'.repeat(32); // 64 hex chars → 32 bytes of 0xaa
  const cpk = 'bb'.repeat(32);

  it('uses the given 64-hex secret exactly, as 32 bytes', () => {
    const key = resolvePrivateStateSecretKey(given, undefined);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(hex(key)).toBe(given);
  });

  // Regression: with no secret given the script used the wallet's coin public
  // key, which is public (part of the shielded address), so anyone could take
  // over a contract whose owner is public_key(secret_key()).
  it('never falls back to the coin public key when no secret is given', () => {
    expect(() => resolvePrivateStateSecretKey(undefined, cpk)).toThrow(/No private-state secret was given/);
    expect(() => resolvePrivateStateSecretKey('', cpk)).toThrow(/No private-state secret was given/);
  });

  it('refuses a secret of the wrong length or not hex, instead of choosing another', () => {
    expect(() => resolvePrivateStateSecretKey('abcd', cpk)).toThrow(/No private-state secret was given/);
    expect(() => resolvePrivateStateSecretKey('zz'.repeat(32), cpk)).toThrow(/No private-state secret was given/);
  });

  it('uses the coin public key only when asked for the legacy secret', () => {
    expect(hex(resolvePrivateStateSecretKey('legacy', cpk))).toBe(cpk);
    expect(() => resolvePrivateStateSecretKey('legacy', undefined)).toThrow(/no coin public key/);
  });

  it('never makes a random secret up', () => {
    expect(() => resolvePrivateStateSecretKey(undefined, undefined)).toThrow();
  });
});
