import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, GENESIS_SEED, LOCAL_WALLET_FUNDING_NIGHT } from '@kuiralabs/midnight-cli-core';
import { airdropDefinition } from '@kuiralabs/midnight-wallet/commands';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from '../../test-support/plain-wallet.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliCall } from './helpers/cli-call.ts';
import { closedPort } from '../../test-support/closed-port.ts';

// The handler, as the shell loads it.
const { default: airdropCommand } = await airdropDefinition.load();

const TEST_DIR = path.join(os.tmpdir(), `midnight-airdrop-cmd-test-${process.pid}`);
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

describe('airdrop command — argument validation', () => {
  it('airdrops LOCAL_WALLET_FUNDING_NIGHT when no amount is given', async () => {
    // Before, no amount was refused ("Missing amount"). The heading names the
    // amount before the chain is reached; nothing listens here, so it stops there.
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);
    const port = await closedPort();

    const args = parseArgs(['airdrop', '--wallet', walletFile, '--network', 'undeployed',
      '--node', `ws://127.0.0.1:${port}`, '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--proof-server', `http://127.0.0.1:${port}`]);
    await expect(cliCall(airdropCommand, args)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(io.stderr()).toMatch(new RegExp(`Amount:\\s+${LOCAL_WALLET_FUNDING_NIGHT} NIGHT`));
  });

  it('throws for non-numeric amount', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', 'abc', '--wallet', walletFile]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('Invalid amount');
  });

  it('throws for zero amount', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '0', '--wallet', walletFile]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('greater than 0');
  });

  it('refuses a negative amount as an amount, not as a missing one', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '-5', '--wallet', walletFile]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('Invalid amount: "-5" — must be a positive number');
  });

  // Regression: `airdrop ""` sent the default amount, as if none were given.
  it('refuses an empty amount instead of sending the default', async () => {
    const args = parseArgs(['airdrop', '', '--wallet', path.join(TEST_DIR, 'nonexistent.json'), '--network', 'undeployed']);
    await expect(cliCall(airdropCommand, args)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('Invalid amount: ""') });
  });

  it('throws when no wallet file exists', async () => {
    // --network undeployed pinned so the test passes regardless of the
    // developer's ~/.midnight/config.json (resolveNetwork reads the real
    // config dir; the airdrop entry-point bails out on non-undeployed
    // networks BEFORE attempting to load the wallet file).
    const args = parseArgs(['airdrop', '100', '--wallet', path.join(TEST_DIR, 'nonexistent.json'), '--network', 'undeployed']);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('Wallet file not found');
  });
});

describe('airdrop command — network restriction', () => {
  it('rejects airdrop on preprod network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile, '--network', 'preprod']);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('rejects airdrop on preview network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile, '--network', 'preview']);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('includes current network name in rejection message', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile, '--network', 'preprod']);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('"preprod"');
  });
});

describe('airdrop command — address as destination', () => {
  // --network undeployed pinned on each test so they pass regardless of the
  // developer's ~/.midnight/config.json (resolveNetwork reads the real config
  // dir; without the pin, a preprod-default config short-circuits these tests
  // at the network-restriction check before address validation runs).

  it('infers --shielded from a shielded address prefix', async () => {
    // No --shielded flag: the prefix alone must route this down the
    // shielded path, whose bech32m decode rejects this junk payload.
    // The old behavior errored with "add --shielded" instead.
    const args = parseArgs([
      'airdrop',
      '100',
      '--wallet',
      'mn_shield-addr_undeployed1abcdef',
      '--network', 'undeployed',
    ]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow(/Invalid shielded address/);
  });

  it('network check on an inferred-shielded address expects the shielded prefix', async () => {
    const args = parseArgs([
      'airdrop',
      '100',
      '--wallet',
      'mn_shield-addr_preprod1abcdef',
      '--network', 'undeployed',
    ]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow(/Expected prefix: mn_shield-addr_undeployed1/);
  });

  it('rejects an unshielded address when --shielded is passed', async () => {
    const args = parseArgs([
      'airdrop',
      '100',
      '--shielded',
      '--wallet',
      'mn_addr_undeployed1abcdef',
      '--network', 'undeployed',
    ]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow(/--shielded was passed but --wallet is an unshielded address/);
  });

  it('rejects an address whose prefix does not match the resolved network', async () => {
    const args = parseArgs([
      'airdrop',
      '100',
      '--wallet',
      'mn_addr_preprod1abcdef',
      '--network', 'undeployed',
    ]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow(/does not match network "undeployed"/);
  });

  it('rejects an unshielded address when running against preprod', async () => {
    // The "only on undeployed" rule fires before address validation
    const args = parseArgs([
      'airdrop',
      '100',
      '--wallet',
      'mn_addr_preprod1abcdef',
      '--network',
      'preprod',
    ]);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('only available on the "undeployed" network');
  });
});

describe('airdrop command — shielded flag', () => {
  it('rejects shielded airdrop on preprod', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--shielded', '--wallet', walletFile, '--network', 'preprod']);
    await expect(cliCall(airdropCommand, args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('airdrops LOCAL_WALLET_FUNDING_NIGHT shielded when no amount is given with --shielded', async () => {
    const port = await closedPort();
    const shielded = rcKeys.shieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['airdrop', '--shielded', '--wallet', shielded, '--network', 'undeployed',
      '--node', `ws://127.0.0.1:${port}`, '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--proof-server', `http://127.0.0.1:${port}`]);
    await expect(cliCall(airdropCommand, args)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(io.stderr()).toMatch(new RegExp(`Amount:\\s+${LOCAL_WALLET_FUNDING_NIGHT} NIGHT \\(shielded\\)`));
  });
});
