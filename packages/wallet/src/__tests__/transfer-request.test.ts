// A transfer's arguments are checked from the wallet files and the address
// encoding alone: no wallet starts and no network is reached. HOME points at a
// temporary directory so wallet names resolve to files made here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTransferRequest } from '../lib/transfer-request.ts';
import { parseArgs, MIDNIGHT_DIR, WALLETS_DIR_NAME, UsageError, classifyError, createHost } from '@kuiralabs/midnight-cli-core';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';
import { walletCodes } from '../commands/wallet.codes.ts';
import { codeRegistry } from '../../../../test-support/core-codes.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

// The host the tests' calls run in: nobody to ask, notices dropped, and an engine of its own from the engines the CLI ships.
const host = createHost({ engineLoader: loadInstalledEngine });

const HOME = path.join(os.tmpdir(), `midnight-transfer-request-test-${process.pid}`);
const WALLETS = path.join(HOME, MIDNIGHT_DIR, WALLETS_DIR_NAME);
const SENDER_SEED = Buffer.from('00'.repeat(31) + '11', 'hex');
const RECIPIENT_SEED = Buffer.from('00'.repeat(31) + '22', 'hex');
const RECIPIENT = rcKeys.unshieldedAddresses(RECIPIENT_SEED);
const RECIPIENT_SHIELDED = rcKeys.shieldedAddresses(RECIPIENT_SEED);

let origHome: string | undefined;

function saveWallet(name: string, seed: Buffer, shielded = false): string {
  const file = path.join(WALLETS, `${name}.json`);
  saveWalletConfig({
    seed: seed.toString('hex'),
    addresses: rcKeys.unshieldedAddresses(seed),
    ...(shielded ? { shieldedAddresses: rcKeys.shieldedAddresses(seed) } : {}),
    createdAt: new Date(0).toISOString(),
  }, file);
  return file;
}

const request = (...argv: string[]) => resolveTransferRequest(parseArgs(['transfer', ...argv]), path.join(HOME, MIDNIGHT_DIR), host);

beforeEach(() => {
  origHome = process.env.HOME;
  process.env.HOME = HOME;
  fs.mkdirSync(WALLETS, { recursive: true });
  saveWallet('sender', SENDER_SEED);
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('resolveTransferRequest', () => {
  it('takes an address and an amount, on the network asked for', async () => {
    const r = await request(RECIPIENT.preprod, '1.5', '--wallet', 'sender', '--network', 'preprod');
    expect(r).toMatchObject({ recipientAddress: RECIPIENT.preprod, amount: 1_500_000n, shielded: false, networkName: 'preprod' });
    expect(r.walletPath).toBe(path.join(WALLETS, 'sender.json'));
    // The request is checked without the passphrase: it carries the wallet's addresses, never its seed.
    expect(r.walletConfig).not.toHaveProperty('seed');
  });

  it('resolves a wallet name given as the recipient to that wallet\'s address on the network', async () => {
    saveWallet('bob', RECIPIENT_SEED, true);
    expect((await request('bob', '2', '--wallet', 'sender')).recipientAddress).toBe(RECIPIENT.undeployed);
    expect((await request('bob', '2', '--wallet', 'sender', '--shielded')).recipientAddress).toBe(RECIPIENT_SHIELDED.undeployed);
  });

  it('takes a mainnet address, whose prefix has no network segment, as an address on mainnet', async () => {
    expect(RECIPIENT.mainnet.startsWith('mn_addr1')).toBe(true);
    const r = await request(RECIPIENT.mainnet, '1', '--wallet', 'sender', '--network', 'mainnet');
    expect(r).toMatchObject({ recipientAddress: RECIPIENT.mainnet, networkName: 'mainnet' });
    saveWallet('bob', RECIPIENT_SEED, true);
    expect((await request('bob', '1', '--wallet', 'sender', '--network', 'mainnet')).recipientAddress).toBe(RECIPIENT.mainnet);
  });

  it('refuses a mainnet address on another network as the wrong address, not as a missing wallet', async () => {
    await expect(request(RECIPIENT.mainnet, '1', '--wallet', 'sender')).rejects.toThrow('Expected a bech32m address (mn_addr_...) for network "undeployed"');
    await expect(request(RECIPIENT_SHIELDED.mainnet, '1', '--wallet', 'sender', '--shielded')).rejects.toThrow('Invalid shielded address');
  });

  it.each([
    [[], 'Missing recipient address'],
    [[RECIPIENT.undeployed], 'Missing amount'],
    [[RECIPIENT.undeployed, '0'], 'Invalid amount: "0" — must be greater than 0'],
    [[RECIPIENT.undeployed, '-5'], 'Invalid amount: "-5"'],
    [[RECIPIENT.undeployed, '1.1234567'], 'NIGHT has 6 decimals'],
    [['nobody', '1'], 'Wallet file not found'],
    [['mn_addr_undeployed1notanaddress', '1'], 'Invalid recipient address'],
    [[RECIPIENT.preprod, '1'], 'Expected a bech32m address (mn_addr_...) for network "undeployed"'],
    [[RECIPIENT_SHIELDED.undeployed, '1'], 'Invalid recipient address'],
    [[RECIPIENT.undeployed, '1', '--shielded'], 'Invalid shielded address'],
    [[RECIPIENT.undeployed, '1', '--wallet', 'nosuchsender'], 'Wallet file not found'],
  ])('refuses %j', async (argv, message) => {
    await expect(request(...argv, ...(argv.includes('--wallet') ? [] : ['--wallet', 'sender']))).rejects.toThrow(message);
  });

  it.each([
    [[RECIPIENT.undeployed]],
    [[RECIPIENT.undeployed, 'ten']],
    [['mn_addr_undeployed1notanaddress', '1']],
    [[RECIPIENT.preprod, '1']],
  ])('refuses %j as a usage mistake, which an agent sees as INVALID_ARGS', async (argv) => {
    let err: unknown;
    try { await request(...argv, '--wallet', 'sender'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    expect(classifyError(err as Error, codeRegistry(coreCodes, walletCodes)).errorCode).toBe('INVALID_ARGS');
  });

  it('refuses a shielded transfer where shielded is off before reading the address', async () => {
    await expect(request('mn_shield-addr_preprod1garbage', '1', '--wallet', 'sender', '--shielded', '--network', 'preprod'))
      .rejects.toThrow(/Shielded is unavailable on preprod/);
  });
});

// The error-code parity table's row for a transfer's arguments (src/__tests__/error-code-parity.test.ts
// lists every typed error where mn throws it; this one is the wallet's transfer request's own).
describe('a shielded transfer where shielded is off, in the error-code parity table', () => {
  it('reports INVALID_ARGS, exit 2, as before codes were owned per package', async () => {
    const err = await request(rcKeys.shieldedAddresses(SENDER_SEED).preprod, '1', '--wallet', 'sender', '--shielded', '--network', 'preprod').catch((e: Error) => e);
    expect(classifyError(err as Error, codeRegistry(coreCodes, walletCodes))).toStrictEqual({ errorCode: 'INVALID_ARGS', exitCode: 2 });
  });
});
