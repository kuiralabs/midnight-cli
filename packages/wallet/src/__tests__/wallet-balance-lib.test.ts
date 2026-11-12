// readAddressBalance and readWalletBalance, called as a program calls them:
// a host of its own (a temporary state root, its settings given, never the
// environment), plain values in, typed results out, no argv and no call
// context. The indexer is a stand-in run by the test (stand-in-indexer.ts),
// the node and proof server an endpoint that refuses every connection.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHost, type Host, settingsFromEnvironment, NATIVE_TOKEN_TYPE, saveCliConfig, type Prompter, type ProgressEvent } from '@kuiralabs/midnight-cli-core';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { establishPassphrase, PASSPHRASE_ENV } from '../lib/passphrase.ts';
import { writeSealedWallet, type WalletPublic } from '../lib/wallet-config.ts';
import { readAddressBalance, readWalletBalance, type UnshieldedRead } from '../lib/wallet/balance.ts';
import type { WalletOpened } from '../lib/wallet/wallet-call.ts';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { startRefusingEndpoint, startStandInIndexer, type StandInIndexer } from '../../../../test-support/stand-in-indexer.ts';

const PASSPHRASE = 'correct horse battery staple';
const SEED_A = 'a1'.repeat(32);
const SEED_B = 'b2'.repeat(32);

let home: string;
let indexer: StandInIndexer;
let refusing: { port: number; close(): Promise<void> };

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-balance-lib-')));
  indexer = await startStandInIndexer([1_000_000n, 2_500_000n], 5);
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

/** The stand-ins as endpoints. */
const endpoints = () => ({ indexerWS: indexer.url, node: `ws://127.0.0.1:${refusing.port}`, proofServer: `http://127.0.0.1:${refusing.port}` });

describe('readAddressBalance', () => {
  it('reads an address on the network its prefix names: balances in the smallest unit as bigint, with each step said', async () => {
    const address = rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed');
    const said: ProgressEvent[] = [];
    const result = await readAddressBalance(programHost('a'), address, { ...endpoints(), forceFresh: true, onProgress: (event) => said.push(event) });

    expect(result).toEqual({ address, network: 'undeployed', balances: new Map([[NATIVE_TOKEN_TYPE, 3_500_000n]]), utxoCount: 2, txCount: 2 });
    expect(said[0]).toEqual({ kind: 'start', message: 'Checking balance on undeployed...' });
    expect(said.filter((event) => event.kind === 'update').map((event) => event.message)).toContain('Syncing transactions... 100%');
    expect(said.at(-1)).toEqual({ kind: 'done', message: 'Synced 2 transactions' });
    expect(indexer.subscriptions.map((s) => s.address)).toEqual([address]);
  });

  it('refuses a network other than the one the address is for, as a usage error, before reading', async () => {
    const address = rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed');
    await expect(readAddressBalance(programHost('a'), address, { ...endpoints(), network: 'preprod' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('Address belongs to undeployed but --network is preprod') });
    expect(indexer.subscriptions).toEqual([]);
  });

  it('never infers mainnet from a mainnet address: refused before reading, saying to name it', async () => {
    const address = rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'mainnet');
    await expect(readAddressBalance(programHost('a'), address, endpoints())).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('--network mainnet') });
    expect(indexer.subscriptions).toEqual([]);
  });

  it('reads a mainnet address when the call names mainnet', async () => {
    const address = rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'mainnet');
    const result = await readAddressBalance(programHost('a'), address, { ...endpoints(), network: 'mainnet', forceFresh: true });
    expect(result).toMatchObject({ address, network: 'mainnet', utxoCount: 2 });
    expect(indexer.subscriptions.map((s) => s.address)).toEqual([address]);
  });

  // Anything else was sent to the indexer as it was, and failed there.
  it.each([
    ['not an address', 'notanaddress'],
    ['an address with a broken checksum', () => rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed').slice(0, -1) + 'q'],
  ])('refuses %s as a usage error, before asking the indexer', async (_what, given) => {
    const address = typeof given === 'function' ? given() : given;
    await expect(readAddressBalance(programHost('a'), address, { ...endpoints(), network: 'undeployed', forceFresh: true })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('Invalid address') });
    expect(indexer.subscriptions).toEqual([]);
  });

  it('refuses a shielded address as a usage error, saying its balance needs the wallet, before asking the indexer', async () => {
    const address = rcKeys.shieldedAddresses(Buffer.from(SEED_A, 'hex')).undeployed;
    await expect(readAddressBalance(programHost('a'), address, { ...endpoints(), network: 'undeployed', forceFresh: true })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('read only with its wallet: midnight balance --wallet <name> --network undeployed') });
    expect(indexer.subscriptions).toEqual([]);
  });

  it('fails with NETWORK_ERROR when the indexer refuses the connection', async () => {
    const address = rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed');
    await expect(readAddressBalance(programHost('a'), address, { ...endpoints(), indexerWS: `ws://127.0.0.1:${refusing.port}/api/v4/graphql/ws`, forceFresh: true })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('cancelled already: CancelledError, and nothing asked of the indexer or said', async () => {
    const said: ProgressEvent[] = [];
    const address = rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed');
    await expect(readAddressBalance(programHost('a'), address, { ...endpoints(), signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(indexer.subscriptions).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('readWalletBalance', () => {
  type Said = ProgressEvent | WalletOpened | UnshieldedRead;

  it('reads a seed the program holds: unshielded NIGHT as bigint, shielded not read where the network has no faucet', async () => {
    const said: Said[] = [];
    const seed = Buffer.from(SEED_A, 'hex');
    const address = rcKeys.unshieldedAddress(seed, 'preview');
    const result = await readWalletBalance(programHost('a'), { seed }, { ...endpoints(), network: 'preview', forceFresh: true, onProgress: (event) => said.push(event) });

    expect(result).toEqual({ network: 'preview', address, unshielded: { night: 3_500_000n, utxoCount: 2 }, shielded: null });
    expect(said).toEqual([
      { kind: 'wallet-opened', network: 'preview', address },
      { kind: 'start', message: 'Checking unshielded...' },
      { kind: 'done', message: 'Unshielded ready' },
      { kind: 'unshielded-read', night: 3_500_000n, utxoCount: 2 },
    ]);
  });

  // Regression: mainnet read the shielded balance by default, a cold read of 109 s through Blockfrost.
  it('skips the shielded read on mainnet by default', async () => {
    const said: Said[] = [];
    const seed = Buffer.from(SEED_A, 'hex');
    const address = rcKeys.unshieldedAddress(seed, 'mainnet');
    const result = await readWalletBalance(programHost('a'), { seed }, { ...endpoints(), network: 'mainnet', forceFresh: true, onProgress: (event) => said.push(event) });

    expect(result).toEqual({ network: 'mainnet', address, unshielded: { night: 3_500_000n, utxoCount: 2 }, shielded: null });
    expect(said).not.toContainEqual({ kind: 'start', message: 'Syncing shielded...' });
  });

  it('unlocks a sealed wallet by name through the host\'s passphrase, and says the shielded address its file saved', async () => {
    const host = programHost('a');
    const root = host.paths().stateRoot;
    establishPassphrase(root, PASSPHRASE);
    const addresses = rcKeys.unshieldedAddresses(Buffer.from(SEED_B, 'hex'));
    // Only the preview one saved: it is checked against the seed when the wallet is opened.
    const savedShielded = rcKeys.shieldedAddresses(Buffer.from(SEED_B, 'hex')).preview;
    const shieldedAddresses = { preview: savedShielded } as WalletPublic['addresses'];
    writeSealedWallet(path.join(root, 'wallets', 'alice.json'), { addresses, shieldedAddresses, createdAt: new Date().toISOString() }, { seed: SEED_B }, PASSPHRASE);
    const said: Said[] = [];

    const result = await readWalletBalance(host, { wallet: 'alice' }, { ...endpoints(), network: 'preview', forceFresh: true, onProgress: (event) => said.push(event) });

    expect(result.address).toBe(addresses.preview);
    expect(result.shieldedAddress).toBe(savedShielded);
    expect(said[0]).toEqual({ kind: 'wallet-opened', network: 'preview', address: addresses.preview, shieldedAddress: savedShielded });
    expect(indexer.subscriptions.map((s) => s.address)).toEqual([addresses.preview]);
  });

  it('reads each host\'s own wallet on each host\'s saved network, two hosts in one process', async () => {
    const hostA = programHost('a');
    const hostB = programHost('b');
    for (const [host, seed, network] of [[hostA, SEED_A, 'preview'], [hostB, SEED_B, 'preprod']] as const) {
      const root = host.paths().stateRoot;
      saveWalletConfig({ seed, addresses: rcKeys.unshieldedAddresses(Buffer.from(seed, 'hex')), createdAt: new Date().toISOString() }, path.join(root, 'wallets', 'alice.json'));
      saveCliConfig({ network, wallet: 'alice' }, root);
    }

    const [a, b] = await Promise.all([
      readWalletBalance(hostA, {}, { ...endpoints(), forceFresh: true }),
      readWalletBalance(hostB, {}, { ...endpoints(), forceFresh: true }),
    ]);

    expect(a).toMatchObject({ network: 'preview', address: rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'preview'), unshielded: { night: 3_500_000n } });
    expect(b).toMatchObject({ network: 'preprod', address: rcKeys.unshieldedAddress(Buffer.from(SEED_B, 'hex'), 'preprod'), unshielded: { night: 3_500_000n } });
  });

  it('refuses a wallet that is not there with WALLET_NOT_FOUND, and a seed of the wrong size with INVALID_ARGS, before reading', async () => {
    await expect(readWalletBalance(programHost('a'), { wallet: 'nobody' }, { ...endpoints(), network: 'preview' })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(readWalletBalance(programHost('a'), { seed: new Uint8Array(20) }, { ...endpoints(), network: 'preview' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(indexer.subscriptions).toEqual([]);
  });

  it('cancelled already: CancelledError, and no wallet unlocked, nothing asked of the indexer or said', async () => {
    const host = programHost('a');
    const said: Said[] = [];
    await expect(readWalletBalance(host, { wallet: 'alice' }, { ...endpoints(), network: 'preview', signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(host.asked()).toBe(0);
    expect(indexer.subscriptions).toEqual([]);
    expect(said).toEqual([]);
  });
});
