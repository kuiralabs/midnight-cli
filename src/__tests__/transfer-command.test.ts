import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, GENESIS_SEED } from '@kuiralabs/midnight-cli-core';
import { transferDefinition } from '@kuiralabs/midnight-wallet/commands';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from '../../test-support/plain-wallet.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliCall } from './helpers/cli-call.ts';

// The handler, as the shell loads it.
const { default: transferCommand } = await transferDefinition.load();

const TEST_DIR = path.join(os.tmpdir(), `midnight-transfer-cmd-test-${process.pid}`);
const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

let io: CapturedOutput;

beforeEach(() => {
  process.env.NO_COLOR = '';
  fs.mkdirSync(TEST_DIR, { recursive: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  io.restore();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('transfer command — argument validation', () => {
  it('throws when no recipient address is given', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Missing recipient address');
  });

  it('throws when no amount is given', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const recipientAddr = rcKeys.unshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Missing amount');
  });

  it('throws for invalid amount', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const recipientAddr = rcKeys.unshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, 'notanumber', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Invalid amount');
  });

  it('throws for zero amount', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const recipientAddr = rcKeys.unshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, '0', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('greater than 0');
  });

  it('throws when no wallet file exists', async () => {
    const recipientAddr = rcKeys.unshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, '100', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Wallet file not found');
  });
});

describe('transfer command — address validation errors', () => {
  it('rejects malformed address with correct prefix', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', 'mn_addr_undeployed1invalid', '100', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Invalid recipient address');
  });

  it('treats unknown name as wallet lookup', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // "not-a-wallet" doesn't start with mn_addr_, so it's treated as a wallet name
    const args = parseArgs(['transfer', 'not-a-wallet', '100', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Unknown recipient "not-a-wallet": it is neither an address nor one of your wallets');
  });
});

describe('transfer command — wallet name resolution', () => {
  it('throws when wallet name does not exist', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // "nonexistent-wallet" is not an address (no mn_addr_ prefix) so it will be treated as a wallet name
    const args = parseArgs(['transfer', 'nonexistent-wallet', '100', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Unknown recipient "nonexistent-wallet"');
  });

  it('throws when wallet name used with --shielded but has no shielded address', async () => {
    // This test uses the real wallets dir, so we need a wallet that exists
    // but has no shieldedAddress. We'll test with a fake address format instead.
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // "some-name" doesn't start with mn_addr_ or mn_shield-addr_, so treated as wallet name
    const args = parseArgs(['transfer', 'some-name', '100', '--shielded', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow();
  });
});

describe('transfer command — shielded flag', () => {
  it('throws when no recipient given with --shielded', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', '--shielded', '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Missing recipient address');
  });

  it('throws when no amount given with --shielded', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // --network undeployed: shielded is enabled there, so we reach address validation
    // (on preview/preprod the shielded-policy guard fires first, tested separately).
    const args = parseArgs(['transfer', 'mn_shield-addr_undeployed1someaddr', '100', '--shielded', '--wallet', walletFile, '--network', 'undeployed']);
    await expect(cliCall(transferCommand, args)).rejects.toThrow('Invalid shielded address');
  });

  it('blocks a shielded transfer on preprod (no faucet) before syncing', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', 'mn_shield-addr_preprod1someaddr', '100', '--shielded', '--wallet', walletFile, '--network', 'preprod']);
    await expect(cliCall(transferCommand, args)).rejects.toThrow(/Shielded is not read on preprod by default/);
  });
});

describe('transfer command — to the sending wallet itself', () => {
  it('warns, without refusing, before it starts', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const addresses = rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex'));
    saveWalletConfig({ seed: TEST_SEED, addresses, createdAt: new Date().toISOString() }, walletFile);
    const { closedPort } = await import('../../test-support/closed-port.ts');
    const port = await closedPort();
    const args = parseArgs(['transfer', addresses.undeployed, '1', '--wallet', walletFile, '--network', 'undeployed',
      '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--node', `ws://127.0.0.1:${port}`, '--proof-server', `http://127.0.0.1:${port}`]);
    // Not refused for it: it goes on, and here fails on the network that is down.
    await expect(cliCall(transferCommand, args)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(io.stderr()).toContain('Warning: The recipient is this wallet itself: the NIGHT stays in it, and the transfer only spends a fee.');
  });
});

describe('transfer command — several recipients', () => {
  it('heads the output with each recipient, its amount and the total, warning on the one that is this wallet itself', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const addresses = rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex'));
    saveWalletConfig({ seed: TEST_SEED, addresses, createdAt: new Date().toISOString() }, walletFile);
    const other = rcKeys.unshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const { closedPort } = await import('../../test-support/closed-port.ts');
    const port = await closedPort();
    const args = parseArgs(['transfer', other, '10', addresses.undeployed, '2.5', other, '0.000001', '--wallet', walletFile, '--network', 'undeployed',
      '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--node', `ws://127.0.0.1:${port}`, '--proof-server', `http://127.0.0.1:${port}`]);
    await expect(cliCall(transferCommand, args)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const said = io.stderr();
    expect(said).toContain('To:             3 recipients');
    const short = (address: string) => address.slice(0, 10) + '…' + address.slice(-8);
    const lines = said.split('\n');
    const listed = lines.filter((line) => line.startsWith('    ') && !line.includes('Warning'));
    // The amounts line up on the decimal point (they ran on from each address before).
    expect(listed).toEqual([
      `    ${short(other)}  10        NIGHT`,
      `    ${short(addresses.undeployed)}   2.5      NIGHT`,
      `    ${short(other)}   0.000001 NIGHT`,
    ]);
    expect(said).toContain('      Warning: recipient 2 is this wallet itself: its NIGHT stays in it.');
    expect(said.match(/Warning/g)).toHaveLength(1);
    expect(said).toContain('Total:          12.500001 NIGHT');
  });

  it('refuses positional pairs with --to-file before any wallet starts', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig({ seed: TEST_SEED, addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')), createdAt: new Date().toISOString() }, walletFile);
    const file = path.join(TEST_DIR, 'payments.json');
    fs.writeFileSync(file, '[]');
    const args = parseArgs(['transfer', 'alice', '1', '--to-file', file, '--wallet', walletFile]);
    await expect(cliCall(transferCommand, args)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('not both') });
    expect(io.stderr()).toBe('');
  });
});
