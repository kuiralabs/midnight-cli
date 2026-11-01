import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureCommand } from '../lib/run-command.ts';
import { SecondResultError } from '../lib/call-context.ts';
import { CancelledError } from '../lib/errors.ts';
import { classifyError } from '../lib/exit-codes.ts';
import { silentSpinner, start as startSpinner } from '../ui/spinner.ts';
import { parseArgs, type ParsedArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import generateCommand from '../commands/generate.ts';
import infoCommand from '../commands/info.ts';
import addressCommand from '../commands/address.ts';
import genesisAddressCommand from '../commands/genesis-address.ts';
import inspectCostCommand from '../commands/inspect-cost.ts';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from './helpers/plain-wallet.ts';
import { deriveAllAddresses } from '../lib/derive-address.ts';
import { localIndexerFlags } from './helpers/local-indexer.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-run-cmd-test-${process.pid}`);
const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

const TEST_CONFIG_SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const TEST_CONFIG: WalletConfig = {
  seed: TEST_CONFIG_SEED,
  addresses: deriveAllAddresses(Buffer.from(TEST_CONFIG_SEED, 'hex')),
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

describe('captureCommand', () => {
  it('captures JSON output from generate command', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]);
    const result = await captureCommand(generateCommand, args);

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
    const result = await captureCommand(infoCommand, args);

    expect(result.addresses).toBeDefined();
    expect(result.activeNetwork).toBe('undeployed');
    expect(result.activeAddress).toBe(TEST_CONFIG.addresses.undeployed);
    expect(result.createdAt).toBe('2026-01-15T10:30:00.000Z');
  });

  it('captures JSON output from address command', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']);
    const result = await captureCommand(addressCommand, args);

    expect((result.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.network).toBe('undeployed');
    expect(result.index).toBe(0);
  });

  it('captures JSON output from genesis-address command', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    const result = await captureCommand(genesisAddressCommand, args);

    expect((result.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.network).toBe('undeployed');
  });

  it('captures JSON output from inspect-cost command', async () => {
    const local = await localIndexerFlags();
    const args = parseArgs(['inspect-cost', ...local.flags]);
    const result = await captureCommand(inspectCostCommand, args).finally(local.close);

    expect(result.readTime).toBeDefined();
    expect(result.computeTime).toBeDefined();
    expect(result.blockUsage).toBeDefined();
    expect(result.bytesWritten).toBeDefined();
    expect(result.bytesChurned).toBeDefined();
  });

  it('does not leak to real stdout or stderr', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    await captureCommand(genesisAddressCommand, args);

    // captureOutput intercepts real stdout/stderr — if captureCommand leaked,
    // we'd see output here
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });

  it('throws original error when handler fails', async () => {
    const args = parseArgs(['info', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(captureCommand(infoCommand, args)).rejects.toThrow('Wallet file not found');
  });

  it('restores stdout/stderr even when handler throws', async () => {
    const args = parseArgs(['info', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    try { await captureCommand(infoCommand, args); } catch {}

    // Verify stdout/stderr are restored by writing to them
    io.clearStdout();
    io.clearStderr();
    process.stdout.write('test-stdout');
    process.stderr.write('test-stderr');
    expect(io.stdout()).toBe('test-stdout');
    expect(io.stderr()).toBe('test-stderr');
  });

  describe('_minimal flag injection', () => {
    // Use a no-op handler so we can observe the args object after captureCommand
    // mutates it, without depending on any real command's behavior.
    const captureArgs = (sink: { args?: ParsedArgs }) =>
      async (a: ParsedArgs) => { sink.args = a; };

    it('injects _minimal: true by default', async () => {
      const sink: { args?: ParsedArgs } = {};
      await captureCommand(captureArgs(sink), { command: 'x', subcommand: undefined, positionals: [], flags: {} });
      expect(sink.args?.flags._minimal).toBe(true);
    });

    it('also sets json: true', async () => {
      const sink: { args?: ParsedArgs } = {};
      await captureCommand(captureArgs(sink), { command: 'x', subcommand: undefined, positionals: [], flags: {} });
      expect(sink.args?.flags.json).toBe(true);
    });

    it('does not override an explicitly-set _minimal flag', async () => {
      const sink: { args?: ParsedArgs } = {};
      // Tool handler may want to opt out (e.g. when an agent passes full:true,
      // it sets _full:true; the wallet-list handler reads both flags).
      await captureCommand(captureArgs(sink), { command: 'x', subcommand: undefined, positionals: [], flags: { _minimal: true, _full: true } });
      expect(sink.args?.flags._minimal).toBe(true);
      expect(sink.args?.flags._full).toBe(true);
    });
  });

  describe('progress and cancellation', () => {
    const noArgs = (): ParsedArgs => ({ command: 'x', subcommand: undefined, positionals: [], flags: {} });

    it('sends what a command\'s spinner says to onProgress, a --json command\'s silent spinner too', async () => {
      const said: string[] = [];
      await captureCommand(async () => {
        const quiet = silentSpinner();
        quiet.update('Starting mn serve...');
        quiet.stop('mn serve ready (port 9932)');
        const shown = startSpinner('Checking balance on undeployed...');
        shown.update('Syncing transactions... 40%');
        shown.log('fetching keys/deposit_shielded.prover (11 MB), once, from github.com');
        shown.stop('Synced 3 transactions');
      }, noArgs(), { onProgress: (message) => said.push(message) });
      expect(said).toEqual([
        'Starting mn serve...',
        'mn serve ready (port 9932)',
        'Checking balance on undeployed...',
        'Syncing transactions... 40%',
        'fetching keys/deposit_shielded.prover (11 MB), once, from github.com',
        'Synced 3 transactions',
      ]);
    });

    it('sends nothing once the run is over, even when it failed', async () => {
      const said: string[] = [];
      await expect(captureCommand(async () => { throw new Error('refused'); }, noArgs(), { onProgress: (message) => said.push(message) })).rejects.toThrow('refused');
      silentSpinner().update('a later command');
      expect(said).toEqual([]);
    });

    it('hands the command the run\'s signal', async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      await captureCommand(async (_args, ctx) => { seen = ctx.signal; }, noArgs(), { signal: controller.signal });
      expect(seen).toBe(controller.signal);
    });

    it('hands every command a signal, one never cancelled when the run gives none', async () => {
      let seen: AbortSignal | undefined;
      await captureCommand(async (_args, ctx) => { seen = ctx.signal; }, noArgs());
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(false);
    });

    it('never starts a call already cancelled: CANCELLED, the command not run', async () => {
      const controller = new AbortController();
      controller.abort();
      let ran = false;
      const err = await captureCommand(async () => { ran = true; }, noArgs(), { signal: controller.signal }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CancelledError);
      expect(classifyError(err as Error).errorCode).toBe('CANCELLED');
      expect(ran).toBe(false);
    });
  });

  // Regression (2F, S2): the capture target was one module global. Two calls
  // in one server that overlapped shared it: the first to finish cleared it,
  // and the other's result fell through to stdout, the MCP protocol channel,
  // while its call returned {}.
  describe('two calls at once', () => {
    const noArgs = (): ParsedArgs => ({ command: 'x', subcommand: undefined, positionals: [], flags: {} });
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      return { open, opened };
    };

    it('each keeps its own result when they finish in the opposite order they started, and none reaches stdout', async () => {
      const first = gate();
      const second = gate();
      const a = captureCommand(async (_args, ctx) => { await first.opened; ctx.output.result({ call: 'a' }); }, noArgs());
      const b = captureCommand(async (_args, ctx) => { await second.opened; ctx.output.result({ call: 'b' }); }, noArgs());
      second.open();
      expect(await b).toEqual({ call: 'b' });
      first.open();
      expect(await a).toEqual({ call: 'a' });
      expect(io.stdout()).toBe('');
    });

    it('keeps a result as it was written: a change the command makes after is not seen', async () => {
      const result = await captureCommand(async (_args, ctx) => {
        const data: Record<string, unknown> = { balance: '1' };
        ctx.output.result(data);
        data.balance = '2';
      }, noArgs());
      expect(result).toEqual({ balance: '1' });
    });

    it('refuses a second result in one call', async () => {
      await expect(captureCommand(async (_args, ctx) => {
        ctx.output.result({ call: 'first' });
        ctx.output.result({ call: 'second' });
      }, noArgs())).rejects.toThrow(SecondResultError);
    });

    it('sends a command\'s text for the person to the server\'s stderr, never stdout', async () => {
      await captureCommand(async (_args, ctx) => {
        ctx.output.stdout('shown\n');
        ctx.output.stderr('chrome\n');
        ctx.output.result({ ok: true });
      }, noArgs());
      expect(io.stdout()).toBe('');
      expect(io.stderr()).toBe('shown\nchrome\n');
    });
  });
});
