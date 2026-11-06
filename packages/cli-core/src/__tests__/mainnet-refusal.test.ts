// What mn refuses on mainnet is refused with its own code, saying why and
// what to do instead; every other network is let through.

import { describe, expect, it } from 'vitest';
import { MainnetRefusedError, refuseOnMainnet } from '../lib/mainnet-refusal.ts';
import { getValidNetworkNames, type NetworkName } from '../lib/network.ts';
import { EXIT_INVALID_ARGS, classifyError } from '../lib/exit-codes.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

describe('refuseOnMainnet', () => {
  it('throws MAINNET_REFUSED on mainnet, saying what, why, and what to do instead', () => {
    const refuse = () => refuseOnMainnet('mainnet', 'Airdrop', 'mainnet has no faucet', 'Transfer NIGHT from another wallet.');
    expect(refuse).toThrow(MainnetRefusedError);
    expect(refuse).toThrow('Airdrop is refused on mainnet: mainnet has no faucet. Nothing was done.\nTransfer NIGHT from another wallet.');
  });

  it('lets every other network through', () => {
    for (const network of getValidNetworkNames().filter((name) => name !== 'mainnet') as NetworkName[]) {
      expect(() => refuseOnMainnet(network, 'Airdrop', 'why', 'instead')).not.toThrow();
    }
  });

  it('is classified by its own code, as an invalid request', () => {
    expect(classifyError(new MainnetRefusedError('mn grant', 'why', 'instead'), CORE_CODES)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: 'MAINNET_REFUSED' });
  });
});
