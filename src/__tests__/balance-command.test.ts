import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, GENESIS_SEED } from '@kuiralabs/midnight-cli-core';
import { balanceDefinition } from '@kuiralabs/midnight-wallet/commands';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from '../../test-support/plain-wallet.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliCall } from './helpers/cli-call.ts';

// The handler, as the shell loads it.
const { default: balanceCommand } = await balanceDefinition.load();

// The balance command's checks that need no chain. Those that read a live
// indexer are in balance-command.live.test.ts (npm run test:live).

const TEST_DIR = path.join(os.tmpdir(), `midnight-balance-cmd-test-${process.pid}`);

// Derive real valid addresses for testing against the local undeployed indexer
const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
const GENESIS_UNDEPLOYED_ADDRESS = rcKeys.unshieldedAddress(genesisSeedBuffer, 'undeployed');

// A different seed with no balance — used to test "No balance found" path
const EMPTY_SEED = '0000000000000000000000000000000000000000000000000000000000000099';
const EMPTY_ADDRESS = rcKeys.unshieldedAddress(Buffer.from(EMPTY_SEED, 'hex'), 'undeployed');

let io: CapturedOutput;

// The command reads and writes wallet caches and config under the home
// directory: these tests get one of their own, never the developer's. Docker
// is still found through the real home's configuration.
const REAL_HOME = os.homedir();
let origHome: string | undefined;
let origDockerConfig: string | undefined;

beforeEach(() => {
  process.env.NO_COLOR = '';
  fs.mkdirSync(TEST_DIR, { recursive: true });
  origHome = process.env.HOME;
  origDockerConfig = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = origDockerConfig ?? path.join(REAL_HOME, '.docker');
  process.env.HOME = TEST_DIR;
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  process.env.HOME = origHome;
  if (origDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
  else process.env.DOCKER_CONFIG = origDockerConfig;
  io.restore();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('balance command — address resolution errors', () => {
  it('throws when no address given and wallet file is missing', async () => {
    const args = parseArgs(['balance', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(cliCall(balanceCommand, args)).rejects.toThrow('Wallet file not found');
  });
});

describe('balance command — the address given', () => {
  // Every word after the first used to be ignored, and the first sent to the indexer as it was.
  it('refuses a second address as a usage error', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, EMPTY_ADDRESS, '--network', 'undeployed']);
    await expect(cliCall(balanceCommand, args)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('balance takes one address') });
  });

  it('refuses a word that is not an address as a usage error', async () => {
    const args = parseArgs(['balance', 'notanaddress', '--network', 'undeployed', '--indexer-ws', 'ws://localhost:19999']);
    await expect(cliCall(balanceCommand, args)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('Invalid address') });
  });
});

describe('balance command — shielded flag errors', () => {
  it('throws when --shielded used without wallet file', async () => {
    const args = parseArgs(['balance', '--shielded', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(cliCall(balanceCommand, args)).rejects.toThrow('Wallet file not found');
  });

  it('rejects --shielded on a positional address not owned by any wallet', async () => {
    // Shielded balances need the seed; a bare address we don't own can't be
    // decrypted, so we fail with a clear pointer to the wallet-based form.
    const args = parseArgs(['balance', EMPTY_ADDRESS, '--shielded', '--network', 'undeployed']);
    await expect(cliCall(balanceCommand, args)).rejects.toThrow(/Shielded balances are private/);
    await expect(cliCall(balanceCommand, args)).rejects.toThrow(/--wallet <name> --shielded/);
  });
});

describe('balance command — --indexer-ws override', () => {
  it('uses custom indexer WS URL and fails on invalid one', async () => {
    // --no-cache forces a fresh fetch so the test actually hits the
    // (broken) indexer URL instead of returning a cached result from
    // an earlier test in this file.
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--indexer-ws', 'ws://localhost:19999', '--no-cache']);
    try {
      await cliCall(balanceCommand, args);
      expect.fail('Should have thrown');
    } catch (err: any) {
      // The indexer it was given is the one named.
      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.message).toContain('Cannot reach the indexer at http://localhost:19999');
    }
  });
});

describe('balance command — network inference from address HRP', () => {
  it('throws a clear error when --network conflicts with the address HRP', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'preprod']);
    await expect(cliCall(balanceCommand, args)).rejects.toThrow(/belongs to undeployed.*--network is preprod/);
  });

  it('never infers mainnet from a mainnet address: it must be named', async () => {
    const mainnetAddress = rcKeys.unshieldedAddress(Buffer.from(EMPTY_SEED, 'hex'), 'mainnet');
    await expect(cliCall(balanceCommand, parseArgs(['balance', mainnetAddress]))).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('--network mainnet') });
  });

  it('never infers mainnet from a wallet\'s shielded mainnet address either', async () => {
    const seed = Buffer.from(EMPTY_SEED, 'hex');
    const walletsDir = path.join(TEST_DIR, '.midnight', 'wallets');
    saveWalletConfig({ seed: EMPTY_SEED, addresses: rcKeys.unshieldedAddresses(seed), shieldedAddresses: rcKeys.shieldedAddresses(seed), createdAt: new Date(0).toISOString() }, path.join(walletsDir, 'bob.json'));
    const args = parseArgs(['balance', rcKeys.shieldedAddresses(seed).mainnet, '--shielded']);
    await expect(cliCall(balanceCommand, args)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining("wallet bob's mainnet address") });
  });
});

