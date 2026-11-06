// The rc engine's wallet data repository takes the call's signal: cancelled
// while it checks a memoized read, it stops with CANCELLED; and it passes the
// signal on to its fetches. (The chain's reads, cancelled, are the chain's
// tests: packages/chain/src/__tests__/read-cancellation.test.ts.)

import { describe, expect, it } from 'vitest';
import { getNetworkConfig, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import type { BalanceSummary } from '@kuiralabs/midnight-chain';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { testHost } from '../../../../test-support/test-host.ts';

describe('the wallet data repository, cancelled while it checks a memoized read', () => {
  it('stops with CANCELLED rather than serving the memo as if the node were down', async () => {
    let clock = 0;
    const summary: BalanceSummary = { balances: new Map(), utxoCount: 0, txCount: 0, highestTxId: 0, registeredUtxos: 0, unregisteredUtxos: 0 };
    const call = new AbortController();
    let tipChecks = 0;
    const repo = new WalletDataRepository(testHost(), {
      now: () => clock,
      // The first check answers; the second waits until its call is cancelled, as a node that doesn't answer.
      fetchTip: (_network, signal) => {
        tipChecks += 1;
        if (tipChecks === 1) return Promise.resolve('tip-1');
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
          call.abort();
        });
      },
      fetchUnshielded: async () => summary,
    });
    const network: NetworkConfig = getNetworkConfig('undeployed');

    await repo.unshielded('mn_addr_undeployed1x', network);
    clock += 60_000; // past the tip probe's memo, so the next read checks the tip again

    await expect(repo.unshielded('mn_addr_undeployed1x', network, { signal: call.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('passes the call\'s signal on to its unshielded fetch', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const repo = new WalletDataRepository(testHost(), {
      fetchTip: async () => 'tip',
      fetchUnshielded: async (_address, _network, _onProgress, signal) => {
        seen.push(signal);
        return { balances: new Map(), utxoCount: 0, txCount: 0, highestTxId: 0, registeredUtxos: 0, unregisteredUtxos: 0 };
      },
    });
    const signal = new AbortController().signal;
    await repo.unshielded('mn_addr_undeployed1x', getNetworkConfig('undeployed'), { signal });
    expect(seen).toEqual([signal]);
  });
});
