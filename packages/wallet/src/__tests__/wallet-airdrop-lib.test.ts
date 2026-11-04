// airdropNight, called as a program calls it: a host of its own (a temporary
// state root, its settings given, never the environment), plain values in,
// typed results and codes out, no argv and no call context. The indexer is a
// stand-in for a ledger-8 chain's (stand-in-indexer.ts), which mn refuses
// where the genesis wallet first reaches the chain; the node and proof server
// an endpoint that refuses every connection. A submitted airdrop and its
// receipt need a chain: the scratch chain's live runs cover them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHost, type Host, settingsFromEnvironment, saveCliConfig, type Prompter, type ProgressEvent } from '@kuiralabs/midnight-cli-core';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { PASSPHRASE_ENV } from '../lib/passphrase.ts';
import { airdropNight, type AirdropAddressed, type AirdropNightOptions } from '../lib/wallet/airdrop.ts';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { startLedger8Indexer, startRefusingEndpoint, type Ledger8Indexer } from '../../../../test-support/stand-in-indexer.ts';

const PASSPHRASE = 'correct horse battery staple';
const SEED = Buffer.from('a7'.repeat(32), 'hex');
const ADDRESS = rcKeys.unshieldedAddresses(SEED);
const SHIELDED = rcKeys.shieldedAddresses(SEED);
// Above what a JS number carries exactly (2^53 micro-NIGHT): 9007199254.740993 NIGHT.
const LARGE = 9_007_199_254_740_993n;

let home: string;
let indexer: Ledger8Indexer;
let refusing: { port: number; close(): Promise<void> };

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-airdrop-lib-')));
  indexer = await startLedger8Indexer();
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

/** Writes the seed's wallet as `alice` under the host's state root, and makes it the active one. */
function aliceOf(host: Host): void {
  const root = host.paths().stateRoot;
  saveWalletConfig({ seed: SEED.toString('hex'), addresses: ADDRESS, shieldedAddresses: SHIELDED, createdAt: new Date().toISOString() }, path.join(root, 'wallets', 'alice.json'));
  saveCliConfig({ network: 'undeployed', wallet: 'alice' }, root);
}

const endpoints = () => ({
  network: 'undeployed' as const,
  indexerWS: indexer.url,
  node: `ws://127.0.0.1:${refusing.port}`,
  proofServer: `http://127.0.0.1:${refusing.port}`,
});

type Said = ProgressEvent | AirdropAddressed;

function airdrop(extra: Partial<AirdropNightOptions> = {}): AirdropNightOptions {
  return { ...endpoints(), to: {}, amount: LARGE, ...extra };
}

describe('airdropNight', () => {
  it('funds the active wallet at its address: says where, its first step, and fails with UNSUPPORTED_LEDGER on a ledger-8 chain', async () => {
    const host = programHost('a');
    aliceOf(host);
    const said: Said[] = [];

    await expect(airdropNight(host, airdrop({ onProgress: (event) => said.push(event) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });

    expect(said[0]).toEqual({ kind: 'airdrop-addressed', network: 'undeployed', recipient: ADDRESS.undeployed, shielded: false });
    expect(said[1]).toEqual({ kind: 'start', message: 'Starting genesis wallet...' });
    expect(said.filter((event) => event.kind === 'done')).toEqual([]);
    expect(indexer.queries).toEqual(['{ block { protocolVersion } }']);
    expect(host.asked()).toBe(0);
  });

  it('a shielded address makes the airdrop shielded, with no wallet file', async () => {
    const said: Said[] = [];
    await expect(airdropNight(programHost('a'), airdrop({ to: { address: SHIELDED.undeployed }, onProgress: (event) => said.push(event) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
    expect(said[0]).toEqual({ kind: 'airdrop-addressed', network: 'undeployed', recipient: SHIELDED.undeployed, shielded: true });
    expect(said[1]).toEqual({ kind: 'start', message: 'Syncing genesis wallet...' });
  });

  it('a shielded airdrop to a wallet goes to the shielded address its file keeps', async () => {
    const host = programHost('a');
    aliceOf(host);
    const said: Said[] = [];
    await expect(airdropNight(host, airdrop({ to: { wallet: 'alice' }, shielded: true, onProgress: (event) => said.push(event) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
    expect(said[0]).toEqual({ kind: 'airdrop-addressed', network: 'undeployed', recipient: SHIELDED.undeployed, shielded: true });
  });

  it.each([
    ['another network', { network: 'preprod' as const }, 'Airdrop is only available on the "undeployed" network (local devnet).\nCurrent network: "preprod"'],
    ['shielded to an unshielded address', { to: { address: ADDRESS.undeployed }, shielded: true }, '--shielded was passed but --wallet is an unshielded address.'],
    ['an address of another network', { to: { address: ADDRESS.preprod } }, 'Address does not match network "undeployed".\nExpected prefix: mn_addr_undeployed1'],
    ['a malformed shielded address', { to: { address: 'mn_shield-addr_undeployed1nope' } }, 'Invalid shielded address: '],
  ])('refuses %s before the genesis wallet starts, saying nothing', async (_case, extra, message) => {
    const said: Said[] = [];
    await expect(airdropNight(programHost('a'), airdrop({ ...extra, onProgress: (event) => said.push(event) }))).rejects.toThrow(message);
    expect(said).toEqual([]);
    expect(indexer.queries).toEqual([]);
  });

  it('refuses a wallet that is not there with WALLET_NOT_FOUND, and an amount of 0 with INVALID_ARGS', async () => {
    await expect(airdropNight(programHost('a'), airdrop({ to: { wallet: 'nobody' } }))).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(airdropNight(programHost('a'), airdrop({ to: { address: ADDRESS.undeployed }, amount: 0n }))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('cancelled already: CancelledError, and nothing asked or said', async () => {
    const host = programHost('a');
    aliceOf(host);
    const said: Said[] = [];
    await expect(airdropNight(host, airdrop({ signal: AbortSignal.abort(), onProgress: (event) => said.push(event) }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(said).toEqual([]);
    expect(indexer.queries).toEqual([]);
  });

  it('cancelled once the recipient is known: CancelledError, and nothing more said', async () => {
    const controller = new AbortController();
    const said: Said[] = [];
    const onProgress = (event: Said) => {
      said.push(event);
      if (event.kind === 'airdrop-addressed') controller.abort();
    };
    await expect(airdropNight(programHost('a'), airdrop({ to: { address: ADDRESS.undeployed }, signal: controller.signal, onProgress }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(said.map((event) => event.kind)).toEqual(['airdrop-addressed', 'start']);
    expect(indexer.queries).toEqual([]);
  });
});
