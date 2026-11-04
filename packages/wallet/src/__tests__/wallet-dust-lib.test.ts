// readDustStatus, registerDust and exportDustSnapshot, called as a program
// calls them: a host of its own (a temporary state root, its settings given,
// never the environment), plain values in, typed results out, no argv and no
// call context. The indexer is a stand-in run by the test (stand-in-indexer.ts)
// whose NIGHT coins are not registered for Dust; the node and proof server an
// endpoint that refuses every connection. Registering and a snapshot of a
// wallet's Dust need a chain: the scratch chain's live runs cover them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHost, type Host, settingsFromEnvironment, saveCliConfig, type Prompter, type ProgressEvent } from '@kuiralabs/midnight-cli-core';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { PASSPHRASE_ENV } from '../lib/passphrase.ts';
import { exportDustSnapshot, readDustStatus, registerDust } from '../lib/wallet/dust.ts';
import type { WalletOpened } from '../lib/wallet/wallet-call.ts';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { startRefusingEndpoint, startStandInIndexer, type StandInIndexer } from '../../../../test-support/stand-in-indexer.ts';

const PASSPHRASE = 'correct horse battery staple';
const SEED_A = 'c3'.repeat(32);
const SEED_B = 'd4'.repeat(32);

let home: string;
let indexer: StandInIndexer;
let refusing: { port: number; close(): Promise<void> };

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-dust-lib-')));
  indexer = await startStandInIndexer([1_000_000n, 2_000_000n], 5);
  refusing = await startRefusingEndpoint();
});

afterEach(async () => {
  await indexer.close();
  await refusing.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A program's host: its own state root under the test's folder, its passphrase in its settings, and a prompter that counts what it is asked. */
function programHost(name: string): Host & { asked: () => number } {
  let asked = 0;
  const prompter: Prompter = { isInteractive: () => true, ask: async () => { asked += 1; return null; }, askSecret: async () => { asked += 1; return PASSPHRASE; } };
  const host = createHost({
    paths: { stateRoot: path.join(home, name, '.midnight'), home: path.join(home, name) },
    settings: settingsFromEnvironment({ [PASSPHRASE_ENV]: PASSPHRASE }),
    prompter,
    engineLoader: loadInstalledEngine,
  });
  return Object.assign(host, { asked: () => asked });
}

/** Writes `seed`'s wallet as `alice` under the host's state root, and makes it the active one. */
function aliceOf(host: Host, seed: string): void {
  const root = host.paths().stateRoot;
  saveWalletConfig({ seed, addresses: rcKeys.unshieldedAddresses(Buffer.from(seed, 'hex')), createdAt: new Date().toISOString() }, path.join(root, 'wallets', 'alice.json'));
  saveCliConfig({ network: 'undeployed', wallet: 'alice' }, root);
}

const endpoints = () => ({ network: 'undeployed' as const, indexerWS: indexer.url, node: `ws://127.0.0.1:${refusing.port}`, proofServer: `http://127.0.0.1:${refusing.port}` });
const refusingEverywhere = () => ({ network: 'undeployed' as const, indexerWS: `ws://127.0.0.1:${refusing.port}/api/v4/graphql/ws`, node: `ws://127.0.0.1:${refusing.port}`, proofServer: `http://127.0.0.1:${refusing.port}` });

type Said = ProgressEvent | WalletOpened;

describe('readDustStatus', () => {
  it('a wallet none of whose NIGHT is registered: its coins counted, its Dust not read, each step said', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const said: Said[] = [];
    const address = rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed');

    const status = await readDustStatus(host, { wallet: 'alice' }, { ...endpoints(), onProgress: (event) => said.push(event) });

    expect(status).toEqual({ network: 'undeployed', registered: false, registeredUtxos: 0, unregisteredUtxos: 2 });
    expect(said[0]).toEqual({ kind: 'wallet-opened', network: 'undeployed', address });
    expect(said[1]).toEqual({ kind: 'start', message: 'Checking registration on undeployed...' });
    expect(said.at(-1)).toEqual({ kind: 'done', message: 'Registration checked' });
    expect(said.filter((event) => event.kind === 'start')).toHaveLength(1);
    expect(indexer.subscriptions.map((s) => s.address)).toEqual([address]);
  });

  it('reads a seed the program holds, at the address derived from it', async () => {
    const seed = Buffer.from(SEED_B, 'hex');
    const status = await readDustStatus(programHost('a'), { seed }, endpoints());
    expect(status).toMatchObject({ registered: false, unregisteredUtxos: 2 });
    expect(indexer.subscriptions.map((s) => s.address)).toEqual([rcKeys.unshieldedAddress(seed, 'undeployed')]);
  });

  it('reads each host\'s own active wallet, two hosts in one process', async () => {
    const hostA = programHost('a');
    const hostB = programHost('b');
    aliceOf(hostA, SEED_A);
    aliceOf(hostB, SEED_B);
    await Promise.all([readDustStatus(hostA, {}, endpoints()), readDustStatus(hostB, {}, endpoints())]);
    expect(indexer.subscriptions.map((s) => s.address).sort()).toEqual([
      rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed'),
      rcKeys.unshieldedAddress(Buffer.from(SEED_B, 'hex'), 'undeployed'),
    ].sort());
  });

  it('fails with WALLET_NOT_FOUND for a wallet that is not there, and NETWORK_ERROR when the indexer refuses', async () => {
    await expect(readDustStatus(programHost('a'), { wallet: 'nobody' }, endpoints())).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    const host = programHost('a');
    aliceOf(host, SEED_A);
    await expect(readDustStatus(host, { wallet: 'alice' }, refusingEverywhere())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('cancelled already: CancelledError, and no wallet unlocked, nothing asked of the indexer or said', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const said: Said[] = [];
    await expect(readDustStatus(host, { wallet: 'alice' }, { ...endpoints(), signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(host.asked()).toBe(0);
    expect(indexer.subscriptions).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('registerDust', () => {
  it('refuses a wallet that is not there with WALLET_NOT_FOUND, and a seed of the wrong size with INVALID_ARGS, saying nothing', async () => {
    const said: Said[] = [];
    await expect(registerDust(programHost('a'), { wallet: 'nobody' }, { ...endpoints(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(registerDust(programHost('a'), { seed: new Uint8Array(31) }, endpoints())).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(said).toEqual([]);
  });

  it('cancelled already: CancelledError, and no wallet unlocked, nothing asked or said', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const said: Said[] = [];
    await expect(registerDust(host, { wallet: 'alice' }, { ...endpoints(), signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(host.asked()).toBe(0);
    expect(indexer.subscriptions).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('exportDustSnapshot', () => {
  it('refuses a wallet that is not there with WALLET_NOT_FOUND, saying nothing', async () => {
    const said: ProgressEvent[] = [];
    await expect(exportDustSnapshot(programHost('a'), { wallet: 'nobody' }, { ...endpoints(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(said).toEqual([]);
  });

  it('fails with NETWORK_ERROR when the endpoints refuse, after saying it reads the Dust events', async () => {
    const said: ProgressEvent[] = [];
    await expect(exportDustSnapshot(programHost('a'), { seed: Buffer.from(SEED_A, 'hex') }, { ...refusingEverywhere(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(said[0]).toEqual({ kind: 'start', message: 'Reading dust events from undeployed...' });
  });

  it('cancelled already: CancelledError, and nothing started', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const said: ProgressEvent[] = [];
    await expect(exportDustSnapshot(host, { wallet: 'alice' }, { ...endpoints(), signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(host.asked()).toBe(0);
    expect(said).toEqual([]);
  });
});
