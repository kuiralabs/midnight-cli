// A contract call starts from the private state the contract's store holds,
// so what a witness saved survives to the next call; it is seeded only when
// the store holds none. Real processes and midnight-js's real level provider:
// each call is a script run as mn runs a call (the call lock held for its
// whole run), deciding the find's private-state options with the call
// script's own function (SCRIPT_PARTS.callPrivateStateFn). What
// findDeployedContract and callTx then do with the store is midnight-js 5's
// rule, written out below: the find stores a given initialPrivateState over
// the stored one, the circuit reads the store, and the state its witnesses
// return is stored once the transaction lands.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { sleep } from '@kuiralabs/midnight-cli-core';
import { acquireContractCallLock, processIsAlive } from '../lib/contract/private-state-lock.ts';
import { SCRIPT_PARTS, executeScript } from '../lib/contract/runner.ts';
import { rcEngine } from '../../../../test-support/rc-engine.ts';

const ADDRESS = 'cd'.repeat(32);
const ID = 'counterPrivateState';
const require = createRequire(import.meta.url);
const PROVIDER = require.resolve('@midnight-ntwrk/midnight-js-level-private-state-provider');
const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };
const LOCK_DEPS = { fs, join: path.join, isAlive: processIsAlive, now: () => Date.now(), sleep };

let work: string;
let dir: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-call-private-state-'));
  dir = path.join(work, 'store');
  fs.mkdirSync(dir, { mode: 0o700 });
});

afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

/**
 * A call whose witness increments a counter in the private state: the find's
 * options from `options` (the call script's function, or one that always
 * seeds, as mn did), then midnight-js's find and callTx on the store.
 */
const counterCall = (options: string) => `${SCRIPT_PARTS.prelude}
import { levelPrivateStateProvider } from ${JSON.stringify(pathToFileURL(PROVIDER).href)};
${options}
const provider = levelPrivateStateProvider({
  midnightDbName: ${JSON.stringify(dir)},
  privateStateStoreName: ${JSON.stringify(ID)},
  privateStoragePasswordProvider: () => 'A-wallet-password-0f-length',
  accountId: 'the-wallet',
});
const states = provider.forContract(${JSON.stringify(ADDRESS)});
const makeInitialPrivateState = () => ({ secretKey: 'seeded', count: 0 });
const findOptions = await callPrivateStateOptions(states, ${JSON.stringify(ID)}, makeInitialPrivateState);
// findDeployedContract: a given initialPrivateState is stored over the stored one.
if ('initialPrivateState' in findOptions) await states.set(${JSON.stringify(ID)}, findOptions.initialPrivateState);
// callTx: the circuit reads the store; its witness returns the counter incremented, stored once the transaction lands.
const current = await states.get(${JSON.stringify(ID)});
const next = { ...current, count: current.count + 1 };
await states.set(${JSON.stringify(ID)}, next);
console.log(JSON.stringify({ seeded: 'initialPrivateState' in findOptions, count: next.count }));
process.exit(0);
`;

/** A call as runCall makes it: the contract's call lock for the script's whole run. */
async function call(options: string): Promise<{ seeded: boolean; count: number }> {
  const release = await acquireContractCallLock(LOCK_DEPS, dir, { pid: process.pid, command: 'mn contract call' }, { address: ADDRESS, timeoutMs: 60_000, notice: () => {}, progress: () => {} });
  try {
    return JSON.parse(await executeScript({ dir: work, script: counterCall(options), overlaySdk: false, packages: NO_PACKAGES })) as { seeded: boolean; count: number };
  } finally {
    release();
  }
}

describe('a contract call\'s private state', () => {
  it('starts from what the last call\'s witness saved: two calls that each increment a counter end at 2', async () => {
    const first = await call(SCRIPT_PARTS.callPrivateStateFn);
    const second = await call(SCRIPT_PARTS.callPrivateStateFn);
    expect(first).toEqual({ seeded: true, count: 1 });
    expect(second).toEqual({ seeded: false, count: 2 });
  });

  it('was reset by a call that always seeded it, as mn did: the second call ended at 1 again', async () => {
    const alwaysSeeds = 'const callPrivateStateOptions = async (_states, _id, seed) => ({ initialPrivateState: seed() });';
    await call(alwaysSeeds);
    expect(await call(alwaysSeeds)).toEqual({ seeded: true, count: 1 });
  });

  it('is what the call script finds the contract with: the seeded state only through callPrivateStateOptions', () => {
    const NETWORK: NetworkConfig = { indexer: 'http://127.0.0.1:1/api/v4/graphql', indexerWS: 'ws://127.0.0.1:1/api/v4/graphql/ws', node: 'ws://127.0.0.1:1', proofServer: 'http://127.0.0.1:1', networkId: 'Undeployed' };
    const script = rcEngine.contracts.scripts.call({ networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter', contractName: 'counter', servePort: 9932, contractAddress: ADDRESS, circuit: 'increment' }, SCRIPT_PARTS);
    expect(script).toContain(SCRIPT_PARTS.callPrivateStateFn);
    expect(script).toContain(`...(await callPrivateStateOptions(providers.privateStateProvider.forContract(${JSON.stringify(ADDRESS)}), "counterPrivateState", makeInitialPrivateState)),`);
    expect(script).not.toMatch(/initialPrivateState: makeInitialPrivateState\(\)/);
  });
});
