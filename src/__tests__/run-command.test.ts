// mn's installed commands run as its MCP server runs them (core's
// captureCommand): the JSON each writes, kept from the process's streams.
// How captureCommand runs a command is core's to test (packages/cli-core).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureCommand, CommandFailedError, classifyError, parseArgs } from '@kuiralabs/midnight-cli-core';
import { generateDefinition, infoDefinition, addressDefinition, genesisAddressDefinition } from '@kuiralabs/midnight-wallet/commands';
import { installedCommands } from '../lib/installed-commands.ts';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { inspectCostDefinition } from '@kuiralabs/midnight-contract/commands';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from '../../test-support/plain-wallet.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { localIndexerFlags } from '../../test-support/local-indexer.ts';
import { ownCall } from './helpers/own-call.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-run-cmd-test-${process.pid}`);
const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

const TEST_CONFIG_SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const TEST_CONFIG: WalletConfig = {
  seed: TEST_CONFIG_SEED,
  addresses: rcKeys.unshieldedAddresses(Buffer.from(TEST_CONFIG_SEED, 'hex')),
  createdAt: '2026-01-15T10:30:00.000Z',
};

let io: CapturedOutput;

const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
  process.env.NO_COLOR = '';
  // A home of the test's own: a generated wallet sets mn's passphrase there, never in the real one.
  process.env.HOME = TEST_DIR;
  process.env.MN_PASSPHRASE = 'correct horse battery staple';
  fs.mkdirSync(TEST_DIR, { recursive: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  delete process.env.MN_PASSPHRASE;
  process.env.HOME = ORIGINAL_HOME;
  io.restore();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('captureCommand with mn\'s commands', () => {
  it('fails a command that ends with a non-zero exit code: COMMAND_FAILED, with that exit code', async () => {
    const failing = { shell: {}, load: async () => ({ default: async () => ({ exitCode: 1 }) }) };
    const err = await captureCommand(failing, parseArgs(['test', 'run']), ownCall()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandFailedError);
    expect(classifyError(err as Error, installedCommands)).toStrictEqual({ exitCode: 1, errorCode: 'COMMAND_FAILED' });
  });

  it('captures JSON output from generate command', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]);
    const result = await captureCommand(generateDefinition, args, ownCall());

    expect(result.addresses).toBeDefined();
    const addrs = result.addresses as Record<string, string>;
    expect(addrs.undeployed.startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.activeNetwork).toBe('undeployed');
    expect(result.seed).toBeDefined();
  });

  it('captures JSON output from info command', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--network', 'undeployed']);
    const result = await captureCommand(infoDefinition, args, ownCall());

    expect(result.addresses).toBeDefined();
    expect(result.activeNetwork).toBe('undeployed');
    expect(result.activeAddress).toBe(TEST_CONFIG.addresses.undeployed);
    expect(result.createdAt).toBe('2026-01-15T10:30:00.000Z');
  });

  it('captures JSON output from address command', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']);
    const result = await captureCommand(addressDefinition, args, ownCall());

    expect((result.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.network).toBe('undeployed');
    expect(result.index).toBe(0);
  });

  it('captures JSON output from genesis-address command', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    const result = await captureCommand(genesisAddressDefinition, args, ownCall());

    expect((result.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.network).toBe('undeployed');
  });

  it('captures JSON output from inspect-cost command', async () => {
    const local = await localIndexerFlags();
    const args = parseArgs(['inspect-cost', ...local.flags]);
    const result = await captureCommand(inspectCostDefinition, args, ownCall()).finally(local.close);

    expect(result.readTime).toBeDefined();
    expect(result.computeTime).toBeDefined();
    expect(result.blockUsage).toBeDefined();
    expect(result.bytesWritten).toBeDefined();
    expect(result.bytesChurned).toBeDefined();
  });

  it('does not leak to real stdout or stderr', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    await captureCommand(genesisAddressDefinition, args, ownCall());

    // captureOutput intercepts real stdout/stderr — if captureCommand leaked,
    // we'd see output here
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });

  it('throws original error when handler fails', async () => {
    const args = parseArgs(['info', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(captureCommand(infoDefinition, args, ownCall())).rejects.toThrow('Wallet file not found');
  });

  it('restores stdout/stderr even when handler throws', async () => {
    const args = parseArgs(['info', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    try { await captureCommand(infoDefinition, args, ownCall()); } catch {}

    // Verify stdout/stderr are restored by writing to them
    io.clearStdout();
    io.clearStderr();
    process.stdout.write('test-stdout');
    process.stderr.write('test-stderr');
    expect(io.stdout()).toBe('test-stdout');
    expect(io.stderr()).toBe('test-stderr');
  });
});
