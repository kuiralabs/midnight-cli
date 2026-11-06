// The libraries use the engine of the host they are given, never another
// host's: two hosts on the rc set in one process, each with an engine of its
// own, and a library function given one host's engines loads and reads only
// that host's engine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost, type Host, type SdkSet, type NetworkConfig, type PayingTarget } from '@kuiralabs/midnight-cli-core';
import { silentSpinner } from '@kuiralabs/midnight-cli-core/ui';
import type { BalanceSummary } from '@kuiralabs/midnight-chain';
import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { assertWalletCanPay } from '../lib/wallet-can-pay.ts';
import { listWallets } from '../lib/wallet-config.ts';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';

// The chain and the indexer stand in at the repository's seams; the rest is each engine's own.
const NETWORK: NetworkConfig = {
  indexer: 'http://test/indexer',
  indexerWS: 'ws://test/indexer/ws',
  node: 'ws://test/node',
  proofServer: 'http://test/proof',
  networkId: 'Undeployed',
};
const SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const ADDRESSES = rcKeys.unshieldedAddresses(Buffer.from(SEED, 'hex'));
const empty = (): BalanceSummary => ({ balances: new Map(), utxoCount: 0, txCount: 0, highestTxId: 0, registeredUtxos: 0, unregisteredUtxos: 0 });

let root: string;
// Which host's loader made an engine, and which host's repository fetched a balance.
let loaded: string[];
let fetched: string[];

/** A host on `root` named `name`, whose engine is an rc engine of its own, its repository's fetches recorded under its name. */
const hostNamed = (name: string): Host =>
  createHost({
    paths: { stateRoot: root, home: root },
    engineLoader: async (_set: SdkSet, host: Host) => {
      loaded.push(name);
      return createRcEngine(host, {
        repository: {
          fetchTip: async () => 'tip-1',
          fetchUnshielded: async (address) => { fetched.push(`${name} ${address}`); return empty(); },
        },
      });
    },
  });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-host-engines-')));
  loaded = [];
  fetched = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a library given one host', () => {
  it("checks a paying wallet through that host's engine: only its repository fetches, and keeps what it read", async () => {
    saveWalletConfig({ seed: SEED, addresses: ADDRESSES, createdAt: '2026-11-03T00:00:00.000Z' }, path.join(root, 'wallets', 'alice.json'));
    const hostA = hostNamed('A');
    const hostB = hostNamed('B');
    const target = (host: Host): PayingTarget => ({ network: 'undeployed', root, host, networkConfig: NETWORK, endpoints: {} });

    await expect(assertWalletCanPay(target(hostB), 'alice', silentSpinner(), undefined)).rejects.toThrow('Wallet has 0 NIGHT on undeployed');
    expect(loaded).toStrictEqual(['B']);
    expect(fetched).toStrictEqual([`B ${ADDRESSES.undeployed}`]);

    await expect(assertWalletCanPay(target(hostA), 'alice', silentSpinner(), undefined)).rejects.toThrow('Wallet has 0 NIGHT on undeployed');
    expect(loaded).toStrictEqual(['B', 'A']);
    expect(fetched).toStrictEqual([`B ${ADDRESSES.undeployed}`, `A ${ADDRESSES.undeployed}`]);

    // Host B's repository has the balance at this tip; host A's read never filled it.
    await expect(assertWalletCanPay(target(hostB), 'alice', silentSpinner(), undefined)).rejects.toThrow('Wallet has 0 NIGHT on undeployed');
    expect(fetched).toHaveLength(2);
    expect(loaded).toStrictEqual(['B', 'A']);
  });

  it("derives an old wallet's addresses with an engine of the engines it is given, loading no other host's", async () => {
    // A wallet from before the addresses map: its addresses are derived from its seed when listed.
    saveWalletConfig({ seed: SEED, address: ADDRESSES.undeployed, createdAt: '2026-11-03T00:00:00.000Z' } as never, path.join(root, 'wallets', 'old.json'));
    const hostA = hostNamed('A');
    const hostB = hostNamed('B');

    const [old] = await listWallets(root, hostB.engines);
    expect(old.addresses).toStrictEqual(ADDRESSES);
    expect(loaded).toStrictEqual(['B']);

    await listWallets(root, hostA.engines);
    expect(loaded).toStrictEqual(['B', 'A']);
  });
});
