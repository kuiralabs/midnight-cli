import { describe, it, expect } from 'vitest';
import { getNetworkId } from '../lib/network-id.ts';
import { NetworkId } from '@midnightntwrk/wallet-sdk-abstractions';

describe('getNetworkId', () => {
  it('returns Undeployed for "Undeployed"', () => {
    expect(getNetworkId('Undeployed')).toBe(NetworkId.NetworkId.Undeployed);
  });

  it('returns PreProd for "PreProd"', () => {
    expect(getNetworkId('PreProd')).toBe(NetworkId.NetworkId.PreProd);
  });

  it('returns Preview for "Preview"', () => {
    expect(getNetworkId('Preview')).toBe(NetworkId.NetworkId.Preview);
  });

  it('returns StageNet for "StageNet"', () => {
    expect(getNetworkId('StageNet')).toBe(NetworkId.NetworkId.StageNet);
  });

  it('throws for unknown networkId', () => {
    expect(() => getNetworkId('Mainnet')).toThrow('Unknown networkId: Mainnet');
  });

  it('is case-sensitive', () => {
    expect(() => getNetworkId('undeployed')).toThrow('Unknown networkId');
    expect(() => getNetworkId('PREPROD')).toThrow('Unknown networkId');
  });
});

describe('the plain values the base keeps match the SDK', () => {
  it("names each network by the SDK's NetworkId", async () => {
    const { networkIdForName } = await import('../lib/network-id.ts');
    expect(networkIdForName('preprod')).toBe(NetworkId.NetworkId.PreProd);
    expect(networkIdForName('preview')).toBe(NetworkId.NetworkId.Preview);
    expect(networkIdForName('stagenet')).toBe(NetworkId.NetworkId.StageNet);
    expect(networkIdForName('undeployed')).toBe(NetworkId.NetworkId.Undeployed);
  });
});
