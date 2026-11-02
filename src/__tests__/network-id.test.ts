import { describe, it, expect } from 'vitest';
import { getNetworkId } from '@kuiralabs/midnight-cli-core/lib/network-id';
import { NetworkId } from '@midnightntwrk/wallet-sdk';

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
    const { networkIdForName } = await import('@kuiralabs/midnight-cli-core/lib/network-id');
    expect(networkIdForName('preprod')).toBe(NetworkId.NetworkId.PreProd);
    expect(networkIdForName('preview')).toBe(NetworkId.NetworkId.Preview);
    expect(networkIdForName('undeployed')).toBe(NetworkId.NetworkId.Undeployed);
  });

  it("keeps the ledger-9 fork at the SDK's version, and the facade's schedule starts there", async () => {
    const { ProtocolVersion } = await import('@midnightntwrk/wallet-sdk');
    const { LEDGER_9_FORK_VERSION } = await import('@kuiralabs/midnight-cli-core/lib/network');
    const { FORK_SCHEDULE } = await import('../engine/rc/fork-schedule.ts');
    expect(LEDGER_9_FORK_VERSION).toBe(ProtocolVersion.V9NativeForkVersion);
    expect(FORK_SCHEDULE.v9).toBe(LEDGER_9_FORK_VERSION);
  });
});
