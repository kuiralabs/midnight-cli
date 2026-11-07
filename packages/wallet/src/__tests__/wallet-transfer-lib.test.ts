// transferNight, called as a program calls it: a host of its own (a temporary
// state root, its settings given, never the environment), plain values in,
// typed results and codes out, no argv and no call context. The indexer is a
// stand-in for a ledger-8 chain's (stand-in-indexer.ts), which mn refuses
// where the wallet first reaches the chain; the node and proof server an
// endpoint that refuses every connection. A submitted transfer and its receipt
// need a chain: the scratch chain's live runs cover them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHost, type Host, settingsFromEnvironment, saveCliConfig, type Prompter, type ProgressEvent } from '@kuiralabs/midnight-cli-core';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { PASSPHRASE_ENV } from '../lib/passphrase.ts';
import { transferNight, type TransferNightOptions } from '../lib/wallet/transfer.ts';
import type { WalletOpened } from '../lib/wallet/wallet-call.ts';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { startIndexerOnProtocol, startLedger8Indexer, startRefusingEndpoint, type Ledger8Indexer } from '../../../../test-support/stand-in-indexer.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

const PASSPHRASE = 'correct horse battery staple';
const SEED_A = 'e5'.repeat(32);
const RECIPIENT_SEED = Buffer.from('f6'.repeat(32), 'hex');
const RECIPIENT = rcKeys.unshieldedAddresses(RECIPIENT_SEED).undeployed;
const RECIPIENT_SHIELDED = rcKeys.shieldedAddresses(RECIPIENT_SEED).undeployed;
// Above what a JS number carries exactly (2^53 micro-NIGHT): 9007199254.740993 NIGHT.
const LARGE = 9_007_199_254_740_993n;

let home: string;
let indexer: Ledger8Indexer;
let refusing: { port: number; close(): Promise<void> };

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-transfer-lib-')));
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

/** Writes `seed`'s wallet as `alice` under the host's state root, and makes it the active one; returns its file. */
function aliceOf(host: Host, seed: string): string {
  const root = host.paths().stateRoot;
  const file = path.join(root, 'wallets', 'alice.json');
  saveWalletConfig({ seed, addresses: rcKeys.unshieldedAddresses(Buffer.from(seed, 'hex')), createdAt: new Date().toISOString() }, file);
  saveCliConfig({ network: 'undeployed', wallet: 'alice' }, root);
  return file;
}

const endpoints = () => ({
  network: 'undeployed' as const,
  indexerWS: indexer.url,
  node: `ws://127.0.0.1:${refusing.port}`,
  proofServer: `http://127.0.0.1:${refusing.port}`,
});

type Said = ProgressEvent | WalletOpened;

function transfer(extra: Partial<TransferNightOptions> = {}): TransferNightOptions {
  return { ...endpoints(), recipient: RECIPIENT, amount: LARGE, ...extra };
}

describe('transferNight', () => {
  it('fails fast with NETWORK_ERROR naming the node when it is down, before the wallet syncs or proves', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const ledger9 = await startIndexerOnProtocol(2_001_000);
    const port = await closedPort();
    try {
      const started = Date.now();
      await expect(transferNight(host, { wallet: 'alice' }, transfer({ indexerWS: ledger9.url, node: `ws://127.0.0.1:${port}`, proofServer: `http://127.0.0.1:${port}` })))
        .rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`Cannot reach the node at ws://127.0.0.1:${port}: connection refused.`) });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await ledger9.close();
    }
  });

  it('opens the wallet, says its first step, and fails with UNSUPPORTED_LEDGER on a ledger-8 chain, before the wallet syncs', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const said: Said[] = [];

    await expect(transferNight(host, { wallet: 'alice' }, transfer({ onProgress: (event) => said.push(event) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });

    expect(said[0]).toEqual({ kind: 'wallet-opened', network: 'undeployed', address: rcKeys.unshieldedAddress(Buffer.from(SEED_A, 'hex'), 'undeployed') });
    expect(said[1]).toEqual({ kind: 'start', message: 'Starting wallet...' });
    expect(said.filter((event) => event.kind === 'done')).toEqual([]);
    expect(indexer.queries).toEqual(['{ block { protocolVersion } }']);
  });

  it('a shielded transfer from a seed the program holds says it syncs, and fails with UNSUPPORTED_LEDGER on a ledger-8 chain', async () => {
    const seed = Buffer.from(SEED_A, 'hex');
    const said: Said[] = [];
    await expect(transferNight(programHost('a'), { seed }, transfer({ recipient: RECIPIENT_SHIELDED, shielded: true, onProgress: (event) => said.push(event) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
    expect(said[0]).toEqual({ kind: 'wallet-opened', network: 'undeployed', address: rcKeys.unshieldedAddress(seed, 'undeployed') });
    expect(said[1]).toEqual({ kind: 'start', message: 'Syncing wallet...' });
  });

  it('refuses a wallet that is not there with WALLET_NOT_FOUND, a seed of the wrong size and an amount of 0 with INVALID_ARGS, saying nothing', async () => {
    const said: Said[] = [];
    const onProgress = (event: Said) => said.push(event);
    await expect(transferNight(programHost('a'), { wallet: 'nobody' }, transfer({ onProgress }))).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(transferNight(programHost('a'), { seed: new Uint8Array(31) }, transfer({ onProgress }))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(transferNight(programHost('a'), { seed: Buffer.from(SEED_A, 'hex') }, transfer({ amount: 0n, onProgress }))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(said).toEqual([]);
  });

  it('refuses a shielded transfer where the network has no shielded faucet with INVALID_ARGS, before the wallet unlocks, unless forced', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const said: Said[] = [];
    const preprod = { ...transfer({ recipient: rcKeys.shieldedAddresses(RECIPIENT_SEED).preprod, shielded: true }), network: 'preprod' as const, onProgress: (event: Said) => said.push(event) };
    const refused = transferNight(host, { wallet: 'alice' }, preprod);
    await expect(refused).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(refused).rejects.toThrow('Shielded is unavailable on preprod (no faucet). Use --force-shielded to sync anyway, or --network undeployed.');
    expect(host.asked()).toBe(0);
    expect(said).toEqual([]);
    expect(indexer.queries).toEqual([]);

    // Forced, it goes on to the chain (the stand-in's ledger 8 stops it there).
    await expect(transferNight(host, { wallet: 'alice' }, { ...preprod, forceShielded: true })).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
    expect(said[0]).toMatchObject({ kind: 'wallet-opened', network: 'preprod' });
  });

  it('refuses a network that is not one, naming the networks, before the wallet unlocks', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    await expect(transferNight(host, { wallet: 'alice' }, transfer({ network: 'moonnet' as never }))).rejects.toThrow('Invalid network: "moonnet"');
    expect(host.asked()).toBe(0);
  });

  it('cancelled already: CancelledError, and no wallet unlocked, nothing asked or said', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const said: Said[] = [];
    await expect(transferNight(host, { wallet: 'alice' }, transfer({ signal: AbortSignal.abort(), onProgress: (event) => said.push(event) }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(host.asked()).toBe(0);
    expect(said).toEqual([]);
    expect(indexer.queries).toEqual([]);
  });

  it('cancelled once the wallet is open: CancelledError, and nothing more said', async () => {
    const host = programHost('a');
    aliceOf(host, SEED_A);
    const controller = new AbortController();
    const said: Said[] = [];
    const onProgress = (event: Said) => {
      said.push(event);
      if (event.kind === 'wallet-opened') controller.abort();
    };
    await expect(transferNight(host, { wallet: 'alice' }, transfer({ signal: controller.signal, onProgress }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(said.map((event) => event.kind)).toEqual(['wallet-opened', 'start']);
    expect(indexer.queries).toEqual([]);
  });
});
