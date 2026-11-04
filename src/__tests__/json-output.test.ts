import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, classifyError, EXIT_NETWORK_ERROR, EXIT_INSUFFICIENT_BALANCE, EXIT_TX_REJECTED, EXIT_GENERAL_ERROR, ERROR_CODES, writeJsonResult, writeJsonError, loadCliConfig } from '@kuiralabs/midnight-cli-core';
import { toEngineError } from '@kuiralabs/midnight-cli-core/engine';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Commands that can be tested without network/Docker
import inspectCostCommand from '../commands/inspect-cost.ts';
import { configDefinition } from '@kuiralabs/midnight-cli-core/commands';
import { generateDefinition, infoDefinition, addressDefinition, genesisAddressDefinition } from '@kuiralabs/midnight-wallet/commands';
import helpCommand from '../commands/help.ts';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from '../../test-support/plain-wallet.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { localIndexerFlags } from '../../test-support/local-indexer.ts';
import { cliCall } from './helpers/cli-call.ts';
import { stateRootIn } from '../../test-support/state-root-in.ts';

// The handlers, as the shell loads them.
const { default: generateCommand } = await generateDefinition.load();
const { default: infoCommand } = await infoDefinition.load();
const { default: addressCommand } = await addressDefinition.load();
const { default: genesisAddressCommand } = await genesisAddressDefinition.load();

// The config handler, as the shell loads it.
const { default: configCommand } = await configDefinition.load();

const TEST_DIR = path.join(os.tmpdir(), `midnight-json-test-${process.pid}`);
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

// ── Helper: parse stdout as JSON ──────────────────────────
function parseJsonOutput(): Record<string, unknown> {
  const raw = io.stdout().trim();
  return JSON.parse(raw);
}

// ── classifyError ─────────────────────────────────────────
// Only an error's code is read. The SDK's words for its failures are read once,
// at the engine boundary (toEngineError), which gives them their codes.
describe('classifyError', () => {
  it.each([
    ['ECONNREFUSED 127.0.0.1:9944', ERROR_CODES.NETWORK_ERROR, EXIT_NETWORK_ERROR],
    ['Insufficient balance for transfer', ERROR_CODES.INSUFFICIENT_BALANCE, EXIT_INSUFFICIENT_BALANCE],
    ['Transaction rejected by the node', ERROR_CODES.TX_REJECTED, EXIT_TX_REJECTED],
    ['Stale UTXO detected', ERROR_CODES.STALE_UTXO, EXIT_TX_REJECTED],
    ['No dust available for fee payment', ERROR_CODES.DUST_REQUIRED, EXIT_INSUFFICIENT_BALANCE],
    ['Failed to prove transaction', ERROR_CODES.PROOF_FAILURE, EXIT_TX_REJECTED],
    ['Transaction failed: error 170 InvalidDustSpendProof', ERROR_CODES.INVALID_DUST_PROOF, EXIT_TX_REJECTED],
    ['Stale cache: applied > highest', ERROR_CODES.STALE_CACHE, EXIT_TX_REJECTED],
    ['Wallet sync timed out', ERROR_CODES.SYNC_TIMEOUT, EXIT_NETWORK_ERROR],
    ['Timed out waiting for dust tokens', ERROR_CODES.SYNC_TIMEOUT, EXIT_NETWORK_ERROR],
  ])('classifies the SDK saying "%s", read at the engine boundary, as %s', (said, errorCode, exitCode) => {
    expect(classifyError(toEngineError(new Error(said)) as Error, installedCommands)).toStrictEqual({ exitCode, errorCode });
  });

  // Approved (Y52): words alone no longer give a code. mn throws each of these
  // as its typed error (error-code-parity.test.ts has every site).
  it.each([
    'Wallet file not found: /foo/bar',
    'Missing required flag: --seed',
    'Unknown command: "bogus"',
    'Operation cancelled',
    'Proof server at http://localhost:6300/ did not respond within 30s',
    'Something unexpected happened',
  ])('returns UNKNOWN (exit 1) for a plain error saying "%s"', (said) => {
    expect(classifyError(new Error(said), installedCommands)).toStrictEqual({ exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNKNOWN });
  });
});

// ── writeJsonResult ───────────────────────────────────────
describe('writeJsonResult', () => {
  it('writes valid JSON to stdout', () => {
    writeJsonResult({ foo: 'bar', num: 42 });
    const data = parseJsonOutput();
    expect(data.foo).toBe('bar');
    expect(data.num).toBe(42);
  });

  it('outputs a single line ending with newline', () => {
    writeJsonResult({ key: 'value' });
    const raw = io.stdout();
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trim().split('\n')).toHaveLength(1);
  });
});

// ── writeJsonError ────────────────────────────────────────
describe('writeJsonError', () => {
  it('writes structured error JSON', () => {
    writeJsonError(new Error('test error'), ERROR_CODES.UNKNOWN, 1);
    const data = parseJsonOutput();
    expect(data.error).toBe(true);
    expect(data.code).toBe('UNKNOWN');
    expect(data.message).toBe('test error');
    expect(data.exitCode).toBe(1);
  });
});

// ── generate --json ───────────────────────────────────────
describe('generate --json', () => {
  it('outputs valid JSON with all expected fields', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile, '--json']);
    await cliCall(generateCommand, args);
    const data = parseJsonOutput();

    expect(data.addresses).toBeDefined();
    const addrs = data.addresses as Record<string, string>;
    expect(addrs.undeployed.startsWith('mn_addr_undeployed1')).toBe(true);
    expect(addrs.preprod.startsWith('mn_addr_preprod1')).toBe(true);
    expect(addrs.preview.startsWith('mn_addr_preview1')).toBe(true);
    expect(data.activeNetwork).toBe('undeployed');
    expect(data.activeAddress).toBe(addrs.undeployed);
    expect(data.seed).toBeDefined();
    expect((data.seed as string).length).toBe(128); // 64 bytes from mnemonicToSeedSync (Lace-compatible)
    expect(data.mnemonic).toBeDefined();
    expect((data.mnemonic as string).split(' ').length).toBe(24);
    expect(data.file).toBe(walletFile);
    expect(data.createdAt).toBeDefined();
  });

  it('omits mnemonic in seed mode', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'preprod', '--seed', TEST_SEED, '--output', walletFile, '--json']);
    await cliCall(generateCommand, args);
    const data = parseJsonOutput();

    expect(data.mnemonic).toBeUndefined();
    expect(data.seed).toBe(TEST_SEED);
  });

  it('produces no stderr output', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile, '--json']);
    await cliCall(generateCommand, args);
    expect(io.stderr()).toBe('');
  });
});

// ── info --json ───────────────────────────────────────────
describe('info --json', () => {
  it('outputs valid JSON with wallet info', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--network', 'undeployed', '--json']);
    await cliCall(infoCommand, args);
    const data = parseJsonOutput();

    expect(data.addresses).toBeDefined();
    expect(data.activeNetwork).toBe('undeployed');
    expect(data.activeAddress).toBe(TEST_CONFIG.addresses.undeployed);
    expect(data.createdAt).toBe('2026-01-15T10:30:00.000Z');
    expect(data.file).toContain(walletFile);
  });

  it('does not include seed in JSON output', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--json']);
    await cliCall(infoCommand, args);
    const raw = io.stdout();
    expect(raw).not.toContain(TEST_CONFIG.seed);
  });

  it('produces no stderr output', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--json']);
    await cliCall(infoCommand, args);
    expect(io.stderr()).toBe('');
  });
});

// ── address --json ────────────────────────────────────────
describe('address --json', () => {
  it('outputs valid JSON with address details', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--json']);
    await cliCall(addressCommand, args);
    const data = parseJsonOutput();

    expect((data.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(data.network).toBe('undeployed');
    expect(data.index).toBe(0);
    expect(data.path).toBe("m/44'/2400'/0'/NightExternal/0");
  });

  it('respects --index flag', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--index', '3', '--json']);
    await cliCall(addressCommand, args);
    const data = parseJsonOutput();

    expect(data.index).toBe(3);
    expect(data.path).toBe("m/44'/2400'/0'/NightExternal/3");
  });

  it('produces no stderr output', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--json']);
    await cliCall(addressCommand, args);
    expect(io.stderr()).toBe('');
  });
});

// ── genesis-address --json ────────────────────────────────
describe('genesis-address --json', () => {
  it('outputs valid JSON with genesis address', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed', '--json']);
    await cliCall(genesisAddressCommand, args);
    const data = parseJsonOutput();

    expect((data.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(data.network).toBe('undeployed');
  });

  it('produces no stderr output', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed', '--json']);
    await cliCall(genesisAddressCommand, args);
    expect(io.stderr()).toBe('');
  });
});

// ── inspect-cost --json ───────────────────────────────────
describe('inspect-cost --json', () => {
  it('outputs valid JSON with all 5 dimensions', async () => {
    const local = await localIndexerFlags();
    const args = parseArgs(['inspect-cost', '--json', ...local.flags]);
    await cliCall(inspectCostCommand, args).finally(local.close);
    const data = parseJsonOutput();

    expect(data.readTime).toBeDefined();
    expect(data.computeTime).toBeDefined();
    expect(data.blockUsage).toBeDefined();
    expect(data.bytesWritten).toBeDefined();
    expect(data.bytesChurned).toBeDefined();

    // All values should be positive numbers
    for (const key of ['readTime', 'computeTime', 'blockUsage', 'bytesWritten', 'bytesChurned']) {
      expect(data[key]).toBeGreaterThan(0);
    }
  });

  it('produces no stderr output', async () => {
    const local = await localIndexerFlags();
    const args = parseArgs(['inspect-cost', '--json', ...local.flags]);
    await cliCall(inspectCostCommand, args).finally(local.close);
    expect(io.stderr()).toBe('');
  });
});

// ── config --json ─────────────────────────────────────────
describe('config --json', () => {
  let originalNetwork: string;

  beforeEach(() => {
    originalNetwork = loadCliConfig(stateRootIn(TEST_DIR)).network;
  });

  afterEach(async () => {
    // Restore original config
    if (loadCliConfig(stateRootIn(TEST_DIR)).network !== originalNetwork) {
      io.restore();
      const restoreIo = captureOutput();
      await cliCall(configCommand, parseArgs(['config', 'set', 'network', originalNetwork]));
      restoreIo.restore();
      io = captureOutput();
    }
  });

  it('config get outputs JSON', async () => {
    const args = parseArgs(['config', 'get', 'network', '--json']);
    await cliCall(configCommand, args);
    const data = parseJsonOutput();

    expect(data.action).toBe('get');
    expect(data.key).toBe('network');
    expect(data.value).toBeDefined();
  });

  it('config set outputs JSON', async () => {
    const args = parseArgs(['config', 'set', 'network', 'preprod', '--json']);
    await cliCall(configCommand, args);
    const data = parseJsonOutput();

    expect(data.action).toBe('set');
    expect(data.key).toBe('network');
    expect(data.value).toBe('preprod');
  });
});

// ── help --json ───────────────────────────────────────────
describe('help --json', () => {
  it('outputs valid JSON capability manifest', async () => {
    const args = parseArgs(['help', '--json']);
    await cliCall(helpCommand, args);
    const data = parseJsonOutput();

    expect(data.cli).toBeDefined();
    const cli = data.cli as Record<string, unknown>;
    expect(cli.name).toBe('midnight-wallet-cli');
    expect(cli.version).toBeDefined();
    expect(cli.bin).toEqual(['midnight', 'mn']);
  });

  it('includes all commands in manifest', async () => {
    const args = parseArgs(['help', '--json']);
    await cliCall(helpCommand, args);
    const data = parseJsonOutput();

    const commands = data.commands as Array<Record<string, unknown>>;
    const names = commands.map(c => c.name);
    expect(names).toContain('generate');
    expect(names).toContain('info');
    expect(names).toContain('balance');
    expect(names).toContain('address');
    expect(names).toContain('genesis-address');
    expect(names).toContain('inspect-cost');
    expect(names).toContain('airdrop');
    expect(names).toContain('transfer');
    expect(names).toContain('dust');
    expect(names).toContain('config');
    expect(names).toContain('localnet');
    expect(names).toContain('help');
  });

  it('includes global flags', async () => {
    const args = parseArgs(['help', '--json']);
    await cliCall(helpCommand, args);
    const data = parseJsonOutput();

    const globalFlags = data.globalFlags as Array<Record<string, string>>;
    const flagNames = globalFlags.map(f => f.name);
    expect(flagNames).toContain('--json');
    expect(flagNames).toContain('--wallet <name|file>');
    expect(flagNames).toContain('--network <name>');
  });

  it('every command has jsonFields', async () => {
    const args = parseArgs(['help', '--json']);
    await cliCall(helpCommand, args);
    const data = parseJsonOutput();

    const commands = data.commands as Array<Record<string, unknown>>;
    // Interactive commands (dev) don't emit structured JSON output.
    const COMMANDS_WITHOUT_JSON = new Set(['dev']);
    for (const cmd of commands) {
      if (COMMANDS_WITHOUT_JSON.has(cmd.name as string)) continue;
      expect(cmd.jsonFields, `command "${cmd.name}" is missing jsonFields`).toBeDefined();
      expect(Object.keys(cmd.jsonFields as object).length).toBeGreaterThan(0);
    }
  });
});
