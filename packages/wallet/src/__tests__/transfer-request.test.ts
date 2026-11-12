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
    expect(r).toMatchObject({ recipients: [{ input: RECIPIENT.preprod, address: RECIPIENT.preprod, amount: 1_500_000n }], total: 1_500_000n, shielded: false, networkName: 'preprod' });
    expect(r.walletPath).toBe(path.join(WALLETS, 'sender.json'));
    // The request is checked without the passphrase: it carries the wallet's addresses, never its seed.
    expect(r.walletConfig).not.toHaveProperty('seed');
  });

  it('resolves a wallet name given as the recipient to that wallet\'s address on the network', async () => {
    saveWallet('bob', RECIPIENT_SEED, true);
    expect((await request('bob', '2', '--wallet', 'sender')).recipients[0]!.address).toBe(RECIPIENT.undeployed);
    expect((await request('bob', '2', '--wallet', 'sender', '--shielded')).recipients[0]!.address).toBe(RECIPIENT_SHIELDED.undeployed);
  });

  it('takes a mainnet address, whose prefix has no network segment, as an address on mainnet', async () => {
    expect(RECIPIENT.mainnet.startsWith('mn_addr1')).toBe(true);
    const r = await request(RECIPIENT.mainnet, '1', '--wallet', 'sender', '--network', 'mainnet');
    expect(r).toMatchObject({ recipients: [{ address: RECIPIENT.mainnet }], networkName: 'mainnet' });
    saveWallet('bob', RECIPIENT_SEED, true);
    expect((await request('bob', '1', '--wallet', 'sender', '--network', 'mainnet')).recipients[0]!.address).toBe(RECIPIENT.mainnet);
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
    [['nobody', '1'], 'Unknown recipient "nobody": it is neither an address nor one of your wallets'],
    [['mn_addr_undeployed1notanaddress', '1'], 'Invalid recipient address'],
    [[RECIPIENT.preprod, '1'], 'Expected a bech32m address (mn_addr_...) for network "undeployed"'],
    [[RECIPIENT_SHIELDED.undeployed, '1'], 'is a shielded address: add --shielded'],
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
      .rejects.toThrow(/Shielded is not read on preprod by default/);
  });

  // Regression: mainnet synced the shielded wallet by default, so a shielded transfer there needed no --force-shielded.
  it('refuses a shielded transfer on mainnet without --force-shielded, and takes it with the flag', async () => {
    await expect(request(RECIPIENT_SHIELDED.mainnet, '1', '--wallet', 'sender', '--shielded', '--network', 'mainnet'))
      .rejects.toThrow('Shielded is not read on mainnet by default (its first read takes a while), though a wallet can hold shielded tokens there. Pass --force-shielded to read it.');
    const r = await request(RECIPIENT_SHIELDED.mainnet, '1', '--wallet', 'sender', '--shielded', '--force-shielded', '--network', 'mainnet');
    expect(r).toMatchObject({ recipients: [{ input: RECIPIENT_SHIELDED.mainnet, address: RECIPIENT_SHIELDED.mainnet, amount: 1_000_000n }], shielded: true, networkName: 'mainnet' });
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

describe('resolveTransferRequest — a recipient that does not fit', () => {
  it('names an unknown recipient as neither an address nor a wallet, without suggesting to generate one', async () => {
    const failure = request('carol', '1', '--wallet', 'sender', '--network', 'undeployed');
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow('Unknown recipient "carol": it is neither an address nor one of your wallets.');
    await expect(failure).rejects.not.toThrow(/generate/i);
  });

  it('says to add --shielded for a shielded address given without it', async () => {
    await expect(request(RECIPIENT_SHIELDED.undeployed, '1', '--wallet', 'sender', '--network', 'undeployed'))
      .rejects.toThrow(`${RECIPIENT_SHIELDED.undeployed} is a shielded address: add --shielded to send it shielded NIGHT.`);
  });
});

describe('resolveTransferRequest — several recipients', () => {
  const OTHER = rcKeys.unshieldedAddresses(Buffer.from('00'.repeat(31) + '33', 'hex'));

  it('takes pairs in order, a wallet name resolved, a recipient listed twice paid twice, and totals them', async () => {
    saveWallet('bob', RECIPIENT_SEED);
    const r = await request('bob', '10', OTHER.undeployed, '2.5', 'bob', '1', '--wallet', 'sender');
    expect(r.recipients).toStrictEqual([
      { input: 'bob', address: RECIPIENT.undeployed, amount: 10_000_000n },
      { input: OTHER.undeployed, address: OTHER.undeployed, amount: 2_500_000n },
      { input: 'bob', address: RECIPIENT.undeployed, amount: 1_000_000n },
    ]);
    expect(r.total).toBe(13_500_000n);
  });

  it('takes the recipients from --to-file, shielded with --shielded', async () => {
    saveWallet('bob', RECIPIENT_SEED, true);
    const file = path.join(HOME, 'payments.json');
    fs.writeFileSync(file, JSON.stringify([{ to: 'bob', amount: '3' }, { to: RECIPIENT_SHIELDED.undeployed, amount: '0.5' }]));
    const r = await request('--to-file', file, '--wallet', 'sender', '--shielded');
    expect(r.recipients.map(({ address, amount }) => [address, amount])).toStrictEqual([[RECIPIENT_SHIELDED.undeployed, 3_000_000n], [RECIPIENT_SHIELDED.undeployed, 500_000n]]);
    expect(r).toMatchObject({ total: 3_500_000n, shielded: true });
  });

  it.each([
    [['bob', '1', 'carol'], 'Recipient 2 of 2 ("carol") has no amount'],
    [['bob', '1', 'nobody', '2'], 'Recipient 2 of 2 ("nobody"): Unknown recipient "nobody": it is neither an address nor one of your wallets'],
    [['bob', 'ten', 'bob', '2'], 'Recipient 1 of 2 ("bob"): Invalid amount: "ten"'],
    [['bob', '1', 'bob', '0'], 'Recipient 2 of 2 ("bob"): Invalid amount: "0" — must be greater than 0'],
    [['bob', '1', RECIPIENT.preprod, '2'], `Recipient 2 of 2 ("${RECIPIENT.preprod}"): Invalid recipient address`],
    [['bob', '1', '--to-file', 'payments.json'], 'Give the recipients either as <to> <amount> pairs or with --to-file, not both'],
    [['--to-file', '/no/such/payments.json'], 'Cannot read the recipients file /no/such/payments.json: no such file'],
    [['--to-file'], '--to-file needs a value'],
  ])('refuses %j as a usage mistake, which an agent sees as INVALID_ARGS', async (argv, message) => {
    saveWallet('bob', RECIPIENT_SEED);
    let err: unknown;
    try { await request(...argv, '--wallet', 'sender'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(message);
    expect(classifyError(err as Error, codeRegistry(coreCodes, walletCodes)).errorCode).toBe('INVALID_ARGS');
  });

  it('refuses one recipient past the cap, from the command line and from a file', async () => {
    const { MAX_TRANSFER_RECIPIENTS } = await import('../lib/transfer-recipients.ts');
    const words = Array.from({ length: MAX_TRANSFER_RECIPIENTS + 1 }, () => [OTHER.undeployed, '1']).flat();
    await expect(request(...words, '--wallet', 'sender')).rejects.toThrow(`Too many recipients: ${MAX_TRANSFER_RECIPIENTS + 1}`);
    const file = path.join(HOME, 'payments.json');
    fs.writeFileSync(file, JSON.stringify(Array.from({ length: MAX_TRANSFER_RECIPIENTS + 1 }, () => ({ to: OTHER.undeployed, amount: '1' }))));
    await expect(request('--to-file', file, '--wallet', 'sender')).rejects.toThrow(`Too many recipients: ${MAX_TRANSFER_RECIPIENTS + 1}`);
    // At the cap it is taken.
    expect((await request(...words.slice(2), '--wallet', 'sender')).recipients).toHaveLength(MAX_TRANSFER_RECIPIENTS);
  });
});

describe('fundShieldedHint', () => {
  it('points at the airdrop on undeployed only, and at a shielded transfer elsewhere', async () => {
    const { fundShieldedHint } = await import('../lib/wallet/transfer.ts');
    expect(fundShieldedHint('undeployed', '5')).toBe('Fund the shielded balance: midnight airdrop 5 --shielded');
    for (const network of ['preview', 'preprod', 'mainnet'] as const) {
      expect(fundShieldedHint(network, '5')).not.toContain('airdrop');
      expect(fundShieldedHint(network, '5')).toContain('shielded transfer from another wallet');
    }
  });
});
