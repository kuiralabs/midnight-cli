// The rc engine's checks around a transfer: a recipient's address for the
// network, and which SDK failures are a shortage of Dust.

import { describe, it, expect } from 'vitest';
import { getNetworkConfig, GENESIS_SEED } from '@kuiralabs/midnight-cli-core';
import { validateRecipientAddress, isDustRelatedError } from '../transfer.ts';
import { deriveUnshieldedAddress } from '../derive-address.ts';

describe('validateRecipientAddress', () => {
  const genesisSeed = Buffer.from(GENESIS_SEED, 'hex');

  it('accepts a valid undeployed address', () => {
    const address = deriveUnshieldedAddress(genesisSeed, 'undeployed');
    const config = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress(address, config)).not.toThrow();
  });

  it('accepts a valid preprod address', () => {
    const address = deriveUnshieldedAddress(genesisSeed, 'preprod');
    const config = getNetworkConfig('preprod');
    expect(() => validateRecipientAddress(address, config)).not.toThrow();
  });

  it('accepts a valid preview address', () => {
    const address = deriveUnshieldedAddress(genesisSeed, 'preview');
    const config = getNetworkConfig('preview');
    expect(() => validateRecipientAddress(address, config)).not.toThrow();
  });

  it('rejects an address for the wrong network', () => {
    const preprodAddr = deriveUnshieldedAddress(genesisSeed, 'preprod');
    const undeployedConfig = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress(preprodAddr, undeployedConfig)).toThrow('Invalid recipient address');
  });

  it('rejects a garbage string', () => {
    const config = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress('not-an-address', config)).toThrow('Invalid recipient address');
  });

  it('rejects an empty string', () => {
    const config = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress('', config)).toThrow('Invalid recipient address');
  });
});

describe('isDustRelatedError', () => {
  it('matches "not enough dust" errors', () => {
    expect(isDustRelatedError(new Error('Not enough dust to pay fees'))).toBe(true);
  });

  it('matches "dust generated" errors', () => {
    expect(isDustRelatedError(new Error('dust generated capacity insufficient'))).toBe(true);
  });

  it('matches "insufficient funds" errors', () => {
    expect(isDustRelatedError(new Error('Insufficient funds: dust wallet sync timed out'))).toBe(true);
  });

  it('matches "no dust tokens" errors', () => {
    expect(isDustRelatedError(new Error('No dust tokens found in the wallet state'))).toBe(true);
  });

  it('matches transaction submission errors', () => {
    expect(isDustRelatedError(new Error('Transaction submission error'))).toBe(true);
  });

  it('matches errors with _tag TransactionInvalidError', () => {
    const err = new Error('fail');
    (err as any)._tag = 'TransactionInvalidError';
    expect(isDustRelatedError(err)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isDustRelatedError(new Error('Network timeout'))).toBe(false);
    expect(isDustRelatedError(new Error('Invalid address format'))).toBe(false);
  });

  it('handles null/undefined errors', () => {
    expect(isDustRelatedError(null)).toBe(false);
    expect(isDustRelatedError(undefined)).toBe(false);
  });
});
