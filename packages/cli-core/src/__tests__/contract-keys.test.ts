// A wallet's contract keys come from its seed alone: none is any public value
// of the wallet (its coin public key, an address or a part of one), each is
// the same for one seed every time, and the storage password is one
// midnight-js accepts.

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { contractKeysFromSeed } from '../lib/contract-keys.ts';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { getValidNetworkNames, type NetworkName } from '../lib/network.ts';

const SEED = Buffer.from('0f'.repeat(32), 'hex');

/** Every public value of the wallet with seed `seed`, in hex and as addresses. */
function publicValues(seed: Buffer): string[] {
  const values = [rcKeys.shieldedCoinPublicKeyHex(seed), rcKeys.dustPublicKeyHex(seed)];
  for (const network of getValidNetworkNames() as NetworkName[]) {
    values.push(rcKeys.unshieldedAddress(seed, network), rcKeys.shieldedAddress(seed, network));
  }
  return values;
}

describe('contractKeysFromSeed', () => {
  it('derives a private-state secret that is no public value of the wallet, nor a part of one', () => {
    const { privateStateSecret } = contractKeysFromSeed(SEED);
    expect(privateStateSecret).toMatch(/^[0-9a-f]{64}$/);
    const coinPublicKey = rcKeys.shieldedCoinPublicKeyHex(SEED);
    // The default before: the first 32 bytes of the coin public key.
    expect(privateStateSecret).not.toBe(coinPublicKey.slice(0, 64));
    for (const value of publicValues(SEED)) {
      expect(value.toLowerCase()).not.toContain(privateStateSecret);
      expect(value.toLowerCase()).not.toContain(privateStateSecret.slice(0, 16));
    }
  });

  it('derives no storage password or account from a public value either', () => {
    const { storagePassword, storageAccountId } = contractKeysFromSeed(SEED);
    const digits = storagePassword.replace(/^Mn-/, '').replaceAll('-', '');
    for (const value of publicValues(SEED)) {
      expect(value.toLowerCase()).not.toContain(digits.slice(0, 16));
      expect(value.toLowerCase()).not.toContain(storageAccountId.replace(/^mn-/, '').slice(0, 16));
    }
    expect(storagePassword).not.toBe('mn-contract-default-pwd-16ch');
  });

  it('is the same for one seed every time, and differs between seeds and between keys', () => {
    expect(contractKeysFromSeed(SEED)).toEqual(contractKeysFromSeed(Buffer.from(SEED)));
    const other = contractKeysFromSeed(Buffer.from('10'.repeat(32), 'hex'));
    const keys = contractKeysFromSeed(SEED);
    expect(other.privateStateSecret).not.toBe(keys.privateStateSecret);
    expect(other.storagePassword).not.toBe(keys.storagePassword);
    expect(other.storageAccountId).not.toBe(keys.storageAccountId);
    expect(keys.storagePassword.replace(/^Mn-/, '').replaceAll('-', '')).not.toBe(keys.privateStateSecret);
  });

  it('derives a storage password midnight-js accepts, for any seed', () => {
    for (let i = 0; i < 500; i++) {
      const { storagePassword } = contractKeysFromSeed(randomBytes(32));
      expect(() => validatePassword(storagePassword)).not.toThrow();
    }
    // Seeds whose digests are full of runs and repeats.
    for (const byte of ['00', 'ff', '01', 'ab']) {
      expect(() => validatePassword(contractKeysFromSeed(Buffer.from(byte.repeat(32), 'hex')).storagePassword)).not.toThrow();
    }
  });

  it('refuses an empty seed', () => {
    expect(() => contractKeysFromSeed(new Uint8Array())).toThrow(/seed/);
  });
});
