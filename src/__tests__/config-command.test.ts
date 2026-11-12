import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configDefinition } from '@kuiralabs/midnight-cli-core/commands';
import { parseArgs, loadCliConfig } from '@kuiralabs/midnight-cli-core';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';
import { stateRootIn } from '../../test-support/state-root-in.ts';
import { testHost } from '../../test-support/test-host.ts';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const entryPoint = path.resolve(import.meta.dirname, '../wallet.ts');
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

// The config handler, as the shell loads it.
const { default: configCommand } = await configDefinition.load();

let io: CapturedOutput;

// A home of the test's own: the config the commands write is never the user's.
let home: string;
const originalHome = process.env.HOME;

// Save the original config value before tests, restore after
let originalNetwork: string;

beforeEach(() => {
  process.env.NO_COLOR = '';
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-config-command-'));
  process.env.HOME = home;
  originalNetwork = loadCliConfig(stateRootIn(home)).network;
  io = captureOutput();
});

afterEach(async () => {
  delete process.env.NO_COLOR;
  io.restore();
  // Restore original config to avoid side effects
  if (loadCliConfig(stateRootIn(home)).network !== originalNetwork) {
    const restoreIo = captureOutput();
    await cliCall(configCommand, parseArgs(['config', 'set', 'network', originalNetwork]));
    restoreIo.restore();
  }
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('config command — error handling', () => {
  it('throws when no subcommand (get/set) provided', async () => {
    const args = parseArgs(['config']);
    await expect(cliCall(configCommand, args)).rejects.toThrow('Usage:');
    await expect(cliCall(configCommand, args)).rejects.toThrow('get|set');
  });

  it('throws for invalid subcommand', async () => {
    const args = parseArgs(['config', 'delete', 'network']);
    await expect(cliCall(configCommand, args)).rejects.toThrow('Usage:');
  });

  // Was a usage error: `config get` alone now lists the config.
  it('lists every value for get with no key, the project id masked as get shows it', async () => {
    await cliCall(configCommand, parseArgs(['config', 'set', 'blockfrost-project-id', 'nightpreprodAbCdEfGhIjKlMnOpQrStUvWxYz012']));
    await cliCall(configCommand, parseArgs(['config', 'set', 'node', 'ws://127.0.0.1:29944']));
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'get']));
    const listed = io.stdout();
    expect(listed).not.toContain('nightpreprodAbCdEfGhIjKlMnOpQrStUvWxYz012');
    expect(listed.trim().split('\n').map((line) => line.split(/\s{2,}/))).toEqual([
      ['network', 'undeployed'],
      ['proof-server', '(not set)'],
      ['node', 'ws://127.0.0.1:29944'],
      ['indexer-ws', '(not set)'],
      ['wallet', '(not set)'],
      ['blockfrost-project-id', expect.stringMatching(/^nightpreprod.*\(preprod\)$/)],
      ['account-artifacts', '(not set)'],
    ]);
    // Each as `config get <key>` shows it.
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'get', 'blockfrost-project-id']));
    expect(listed).toContain(io.stdout().trim());
  });

  it('lists the values in JSON, and only a network\'s with --network', async () => {
    await cliCall(configCommand, parseArgs(['config', 'set', 'node', 'ws://n.example', '--network', 'preview']));
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'get', '--json']));
    expect(JSON.parse(io.stdout())).toMatchObject({ action: 'get', values: { network: 'undeployed', node: null, wallet: null } });
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'get', '--network', 'preview', '--json']));
    expect(JSON.parse(io.stdout())).toEqual({ action: 'get', network: 'preview', values: { 'proof-server': null, node: 'ws://n.example', 'indexer-ws': null, 'blockfrost-project-id': null } });
  });

  it('throws when key is missing for set', async () => {
    const args = parseArgs(['config', 'set']);
    await expect(cliCall(configCommand, args)).rejects.toThrow('Missing config key');
  });

  it('throws when value is missing for set', async () => {
    const args = parseArgs(['config', 'set', 'network']);
    await expect(cliCall(configCommand, args)).rejects.toThrow('Missing value');
  });

  it('throws for unknown config key on get', async () => {
    const args = parseArgs(['config', 'get', 'bogus']);
    await expect(cliCall(configCommand, args)).rejects.toThrow('Unknown config key');
  });

  it('throws for invalid network value on set', async () => {
    const args = parseArgs(['config', 'set', 'network', 'testnet']);
    await expect(cliCall(configCommand, args)).rejects.toThrow('Invalid network');
  });
});

describe('config command — get', () => {
  it('outputs network value to stdout', async () => {
    const args = parseArgs(['config', 'get', 'network']);
    await cliCall(configCommand, args);
    const out = io.stdout();
    expect(out).toMatch(/^(preprod|preview|undeployed)\n$/);
  });
});

describe('config command — set + get round-trip', () => {
  it('set persists value that get reads back', async () => {
    // Set to preprod
    const setArgs = parseArgs(['config', 'set', 'network', 'preprod']);
    await cliCall(configCommand, setArgs);
    const err = io.stderr();
    expect(err).toContain('network = preprod');
    expect(err).toContain('✓');

    // Get should return preprod
    io.clearStdout();
    const getArgs = parseArgs(['config', 'get', 'network']);
    await cliCall(configCommand, getArgs);
    expect(io.stdout()).toBe('preprod\n');
  });
});

// A fake id: never a real project's.
const PREPROD_ID = 'nightpreprodFakeFakeFakeFakeFake0123';
const MAINNET_ID = 'nightmainnetFakeFakeFakeFakeFake4567';

describe('config command — a key that isn\'t set', () => {
  // Was the literal "(not set)" as the value, in plain and --json.
  it('prints nothing in plain mode and null in JSON, exit 0', async () => {
    await cliCall(configCommand, parseArgs(['config', 'get', 'wallet']));
    expect(io.stdout()).toBe('');
    await cliCall(configCommand, parseArgs(['config', 'get', 'proof-server', '--json']));
    expect(JSON.parse(io.stdout())).toEqual({ action: 'get', key: 'proof-server', value: null });
  });
});

describe('config command — the Blockfrost project id', () => {
  const ENV_KEYS = ['MN_BLOCKFROST_PROJECT_ID', 'BLOCKFROST_PROJECT_ID'] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  beforeEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });
  afterEach(() => { for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

  // Was "(not set)" while the variable was set and in use.
  it('says when the one in use comes from the environment, masked', async () => {
    process.env.MN_BLOCKFROST_PROJECT_ID = PREPROD_ID;
    await cliCall(configCommand, parseArgs(['config', 'get', 'blockfrost-project-id']));
    expect(io.stdout()).toBe('nightpreprod…0123 (preprod, set from environment MN_BLOCKFROST_PROJECT_ID)\n');
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'get', '--json']));
    const listed = JSON.parse(io.stdout());
    expect(listed.values['blockfrost-project-id']).toBe('nightpreprod…0123 (preprod, set from environment MN_BLOCKFROST_PROJECT_ID)');
    expect(JSON.stringify(listed)).not.toContain(PREPROD_ID);
  });

  it('shows the environment\'s over the saved one for the same network, the saved one for another', async () => {
    await cliCall(configCommand, parseArgs(['config', 'set', 'blockfrost-project-id', MAINNET_ID]));
    process.env.BLOCKFROST_PROJECT_ID = PREPROD_ID;
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'get', 'blockfrost-project-id']));
    expect(io.stdout()).toBe('nightpreprod…0123 (preprod, set from environment BLOCKFROST_PROJECT_ID), nightmainnet…4567 (mainnet)\n');
  });

  // Was silent: every network's id went, and "(removed)" was said even when none was set.
  it('unset says which networks\' ids it removed, and when none was set', async () => {
    await cliCall(configCommand, parseArgs(['config', 'set', 'blockfrost-project-id', PREPROD_ID]));
    await cliCall(configCommand, parseArgs(['config', 'set', 'blockfrost-project-id', MAINNET_ID]));
    io.clearStderr();
    await cliCall(configCommand, parseArgs(['config', 'unset', 'blockfrost-project-id', '--network', 'mainnet']));
    expect(io.stderr()).toContain('blockfrost-project-id removed for mainnet');
    io.clearStderr();
    await cliCall(configCommand, parseArgs(['config', 'unset', 'blockfrost-project-id', '--network', 'mainnet']));
    expect(io.stderr()).toContain('blockfrost-project-id none was set for mainnet');
    await cliCall(configCommand, parseArgs(['config', 'set', 'blockfrost-project-id', MAINNET_ID]));
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'unset', 'blockfrost-project-id', '--json']));
    expect(JSON.parse(io.stdout())).toEqual({ action: 'unset', key: 'blockfrost-project-id', value: null, removed: ['preprod', 'mainnet'] });
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'unset', 'blockfrost-project-id', '--json']));
    expect(JSON.parse(io.stdout())).toEqual({ action: 'unset', key: 'blockfrost-project-id', value: null, removed: [] });
  });

  // Was refused: the id could only come from argv or the environment.
  it('set - asks for it at a terminal, unechoed, and never prints it', async () => {
    const questions: string[] = [];
    const host = testHost({
      prompter: {
        isInteractive: () => true,
        ask: async () => { throw new Error('asked in the open'); },
        askSecret: async (question) => { questions.push(question); return `  ${PREPROD_ID}\n`; },
      },
    });
    await cliCall(configCommand, parseArgs(['config', 'set', 'blockfrost-project-id', '-']), { host });
    expect(questions).toEqual(['Blockfrost project id: ']);
    expect(loadCliConfig(stateRootIn(home)).networks?.preprod?.['blockfrost-project-id']).toBe(PREPROD_ID);
    expect(io.stderr()).not.toContain(PREPROD_ID);
    expect(io.stderr()).toContain('nightpreprod…0123 (preprod)');
  });

  it('set - is refused in an MCP call, whose standard input is the protocol', async () => {
    await expect(cliCall(configCommand, parseArgs(['config', 'set', 'blockfrost-project-id', '-', '--_minimal']))).rejects.toThrow('protocol channel');
  });

  it('set - reads it from the standard input when there is no terminal', () => {
    const run = spawnSync(process.execPath, ['--import', tsxLoader, entryPoint, 'config', 'set', 'blockfrost-project-id', '-', '--json'], {
      env: { ...process.env, HOME: home, NO_COLOR: '1' },
      input: `${PREPROD_ID}\n`,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ action: 'set', key: 'blockfrost-project-id', value: 'nightpreprod…0123 (preprod)' });
    expect(run.stdout + run.stderr).not.toContain(PREPROD_ID);
    expect(loadCliConfig(stateRootIn(home)).networks?.preprod?.['blockfrost-project-id']).toBe(PREPROD_ID);
  }, 60_000);
});
