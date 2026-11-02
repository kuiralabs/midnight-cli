import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import balanceCommand from '../commands/balance.ts';
import { parseArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from './helpers/plain-wallet.ts';
import { deriveUnshieldedAddress, deriveAllAddresses } from '@kuiralabs/midnight-engine-rc/derive-address';
import { GENESIS_SEED } from '@kuiralabs/midnight-cli-core/lib/constants';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliCall } from './helpers/cli-call.ts';

// Live tests against a running ledger-9 indexer: run by `npm run test:live`,
// never by `npm test`. They read balances only, from undeployed's saved
// endpoints (`midnight config set ...`) or the defaults, never docker
// auto-detection (MN_NO_LOCAL_DETECT is set for tests). With no indexer
// answering they fail, saying which, instead of being skipped.

const TEST_DIR = path.join(os.tmpdir(), `midnight-balance-cmd-test-${process.pid}`);

// Derive real valid addresses for testing against the local undeployed indexer
const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
const GENESIS_UNDEPLOYED_ADDRESS = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed');

// A different seed with no balance — used to test "No balance found" path
const EMPTY_SEED = '0000000000000000000000000000000000000000000000000000000000000099';
const EMPTY_ADDRESS = deriveUnshieldedAddress(Buffer.from(EMPTY_SEED, 'hex'), 'undeployed');

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

beforeAll(async () => {
  const { resolveNetwork } = await import('@kuiralabs/midnight-cli-core/lib/resolve-network');
  const { indexer } = resolveNetwork({ args: parseArgs(['balance', '--network', 'undeployed']) }).config;
  const answered = await fetch(indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ block { height } }' }), signal: AbortSignal.timeout(5_000) })
    .then((r) => r.ok, () => false);
  if (!answered) throw new Error(`No ledger-9 indexer answers at ${indexer}: start the local chain (or point undeployed at one with midnight config set) before npm run test:live.`);
});

describe('balance command — reads address from wallet file', () => {
  it('loads address from wallet file and syncs full wallet', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: GENESIS_SEED,
      addresses: deriveAllAddresses(genesisSeedBuffer),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['balance', '--wallet', walletFile, '--network', 'undeployed']);
    await cliCall(balanceCommand, args);

    const err = io.stderr();
    expect(err).toContain('Balance');
    expect(err).toContain(GENESIS_UNDEPLOYED_ADDRESS);
    expect(err).toContain('undeployed');
    expect(err).toContain('Unshielded');
    expect(err).toContain('Shielded');
  });

  it('lists the shielded test tokens genesis holds, by raw type, in the text and in --json', async () => {
    // Every dev chain's genesis wallet holds two shielded test tokens beside NIGHT.
    const tokens = ['00'.repeat(31) + '01', '00'.repeat(31) + '02'];
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig({ seed: GENESIS_SEED, addresses: deriveAllAddresses(genesisSeedBuffer), createdAt: '2026-01-01T00:00:00.000Z' }, walletFile);

    await cliCall(balanceCommand, parseArgs(['balance', '--wallet', walletFile, '--network', 'undeployed']));
    for (const token of tokens) {
      expect(io.stdout()).toMatch(new RegExp(`^SHIELDED_${token}=[1-9]\\d*$`, 'm'));
      expect(io.stderr()).toContain(token);
    }

    io.restore();
    io = captureOutput();
    await cliCall(balanceCommand, parseArgs(['balance', '--wallet', walletFile, '--network', 'undeployed', '--json']));
    const data = JSON.parse(io.stdout().trim());
    for (const token of tokens) expect(data.shielded.tokens[token]).toMatch(/^[1-9]\d*$/);
    expect(data.shielded.tokens).not.toHaveProperty('NIGHT');
  });
});


describe('balance command — positional address with local indexer', () => {
  it('checks balance for the genesis address on undeployed', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed']);
    await cliCall(balanceCommand, args);

    const err = io.stderr();
    expect(err).toContain('Balance');
    expect(err).toContain(GENESIS_UNDEPLOYED_ADDRESS);
    expect(err).toContain('undeployed');
    expect(err).toContain('UTXOs');
    expect(err).toContain('Transactions');
  });

  it('uses explicit --network flag for address lookup', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed']);
    await cliCall(balanceCommand, args);

    const err = io.stderr();
    expect(err).toContain('undeployed');
  });

  it('outputs NIGHT balance to stdout for genesis address', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed']);
    await cliCall(balanceCommand, args);

    const out = io.stdout();
    // Genesis address on local undeployed should have funds — stdout has bare NIGHT=<amount>
    expect(out).toContain('NIGHT=');
  });

  it('outputs "0" to stdout for an unfunded address', async () => {
    const args = parseArgs(['balance', EMPTY_ADDRESS, '--network', 'undeployed']);
    await cliCall(balanceCommand, args);

    const out = io.stdout().trim();
    expect(out).toBe('0');
    const err = io.stderr();
    expect(err).toContain('No balance found');
  });
});


describe('balance command — JSON output', () => {
  it('outputs valid JSON with all expected fields', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed', '--json']);
    await cliCall(balanceCommand, args);

    const data = JSON.parse(io.stdout().trim());
    expect(data.address).toBe(GENESIS_UNDEPLOYED_ADDRESS);
    expect(data.network).toBe('undeployed');
    expect(data.balances).toBeDefined();
    expect(typeof data.utxoCount).toBe('number');
    expect(typeof data.txCount).toBe('number');
  });

  it('exposes a top-level NIGHT alias for flat-shape consumers', async () => {
    // Compatibility shim for integrators who jq for `.NIGHT` directly
    // (e.g. midnight-expert's session health check). The nested
    // `.balances.NIGHT` remains canonical; this is an additive mirror.
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed', '--json']);
    await cliCall(balanceCommand, args);

    const data = JSON.parse(io.stdout().trim());
    if (data.balances?.NIGHT) {
      expect(data.NIGHT).toBe(data.balances.NIGHT);
    }
  });

  it('reports NIGHT balance in NIGHT units (not micro-NIGHT)', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed', '--json']);
    await cliCall(balanceCommand, args);

    const data = JSON.parse(io.stdout().trim());
    const nightBalance = data.balances.NIGHT;
    if (nightBalance) {
      // Should contain a decimal point (NIGHT format), not raw micro-NIGHT
      expect(nightBalance).toContain('.');
      // Should have exactly 6 decimal places
      const decimals = nightBalance.split('.')[1];
      expect(decimals.length).toBe(6);
    }
  });

  it('does not write formatted headers/tables to stderr in JSON mode', async () => {
    // Note: spinner output still goes to stderr at the command level.
    // Full stderr suppression happens globally in wallet.ts entry point.
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed', '--json']);
    await cliCall(balanceCommand, args);
    const err = io.stderr();
    // Should NOT contain formatted output (headers, key-value pairs, dividers)
    expect(err).not.toContain('Balance');
    expect(err).not.toContain('Address');
    expect(err).not.toContain('UTXOs');
    expect(err).not.toContain('─');
  });
});


describe('balance command — spinner lifecycle', () => {
  it('shows syncing progress on stderr for successful check', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed']);
    await cliCall(balanceCommand, args);

    const err = io.stderr();
    // Spinner should show progress and complete with ✓
    expect(err).toContain('Checking balance');
    expect(err).toContain('✓');
  });

  it('stops spinner with "Failed" on connection error', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--indexer-ws', 'ws://localhost:19999']);
    try {
      await cliCall(balanceCommand, args);
    } catch {
      const err = io.stderr();
      expect(err).toContain('Failed');
    }
  });
});
