import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configDefinition } from '@kuiralabs/midnight-cli-core/commands';
import { parseArgs, loadCliConfig } from '@kuiralabs/midnight-cli-core';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';
import { stateRootIn } from '../../test-support/state-root-in.ts';

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
    expect(JSON.parse(io.stdout())).toMatchObject({ action: 'get', values: { network: 'undeployed', node: '(not set)', wallet: '(not set)' } });
    io.clearStdout();
    await cliCall(configCommand, parseArgs(['config', 'get', '--network', 'preview', '--json']));
    expect(JSON.parse(io.stdout())).toEqual({ action: 'get', network: 'preview', values: { 'proof-server': '(not set)', node: 'ws://n.example', 'indexer-ws': '(not set)', 'blockfrost-project-id': '(not set)' } });
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
