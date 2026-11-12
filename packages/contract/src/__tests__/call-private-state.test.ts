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
import { spawnSync } from 'node:child_process';
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
    expect(script).toContain(`...(await callPrivateStateOptions(providers.privateStateProvider.forContract(${JSON.stringify(ADDRESS)}), "counterPrivateState", makeInitialPrivateState, givenPrivateStateSecret)),`);
    expect(script).not.toMatch(/initialPrivateState: makeInitialPrivateState\(\)/);
    // The script as written is valid JavaScript (a string's \\n must reach it escaped).
    const file = path.join(work, 'call.mjs');
    fs.writeFileSync(file, script);
    expect(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).stderr).toBe('');
  });
});

/**
 * A call given a --secret-key: the store seeded (by the first call) with the
 * secret `seededHex` as the contract's witnesses keep it (a byte array beside
 * other state), then a call given `givenHex` through the script's function.
 */
const secretCall = (givenHex: string) => `${SCRIPT_PARTS.prelude}
import { levelPrivateStateProvider } from ${JSON.stringify(pathToFileURL(PROVIDER).href)};
${SCRIPT_PARTS.callPrivateStateFn}
const provider = levelPrivateStateProvider({
  midnightDbName: ${JSON.stringify(dir)},
  privateStateStoreName: ${JSON.stringify(ID)},
  privateStoragePasswordProvider: () => 'A-wallet-password-0f-length',
  accountId: 'the-wallet',
});
const states = provider.forContract(${JSON.stringify(ADDRESS)});
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const given = bytes(${JSON.stringify(givenHex)});
const makeInitialPrivateState = () => ({ secretKey: given, count: 0 });
let unused = false;
const findOptions = await callPrivateStateOptions(states, ${JSON.stringify(ID)}, makeInitialPrivateState, { secret: given, unused: () => { unused = true; } });
if ('initialPrivateState' in findOptions) await states.set(${JSON.stringify(ID)}, findOptions.initialPrivateState);
const current = await states.get(${JSON.stringify(ID)});
await states.set(${JSON.stringify(ID)}, { ...current, count: current.count + 1 });
console.log(JSON.stringify({ seeded: 'initialPrivateState' in findOptions, unused }));
process.exit(0);
`;

// The bug: a --secret-key given for a contract whose store already held a
// private state seeded nothing, and nothing said so.
describe('a call given a private-state secret', () => {
  const OWNER = '1f'.repeat(32);
  const OTHER = 'a0'.repeat(32);
  const run = async (givenHex: string) => {
    const release = await acquireContractCallLock(LOCK_DEPS, dir, { pid: process.pid, command: 'mn contract call' }, { address: ADDRESS, timeoutMs: 60_000, notice: () => {}, progress: () => {} });
    try {
      return JSON.parse(await executeScript({ dir: work, script: secretCall(givenHex), overlaySdk: false, packages: NO_PACKAGES })) as { seeded: boolean; unused: boolean };
    } finally {
      release();
    }
  };

  it('seeds an empty store with it, and is quiet when the stored state holds the same secret', async () => {
    expect(await run(OWNER)).toEqual({ seeded: true, unused: false });
    expect(await run(OWNER)).toEqual({ seeded: false, unused: false });
  });

  it('says a different secret was not used: the call runs from the stored state', async () => {
    await run(OWNER);
    expect(await run(OTHER)).toEqual({ seeded: false, unused: true });
  });

  it('finds the secret as an array of numbers or as hex too, and only a whole 32-byte match', async () => {
    const { callPrivateStateOptions } = await import('../lib/contract/call-private-state.ts');
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const hex = Buffer.from(secret).toString('hex');
    const check = async (stored: unknown) => {
      let unused = false;
      await callPrivateStateOptions({ get: async () => stored }, ID, () => ({}), { secret, unused: () => { unused = true; } });
      return unused;
    };
    expect(await check({ owner: { key: [...secret] } })).toBe(false);
    expect(await check({ keys: new Map([['k', hex.toUpperCase()]]) })).toBe(false);
    expect(await check({ key: secret.slice(0, 31) })).toBe(true);
    expect(await check({ count: 3 })).toBe(true);
    // No secret given: nothing to check.
    expect(await callPrivateStateOptions({ get: async () => ({ count: 3 }) }, ID, () => ({}))).toEqual({});
  });
});
