import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import helpCommand, { helpSpecs } from '../commands/help.ts';
import { parseArgs, declaredCodes } from '@kuiralabs/midnight-cli-core';
import { installedCommands } from '../lib/installed-commands.ts';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';

let io: CapturedOutput;
let savedIsTTY: boolean | undefined;

beforeEach(() => {
  process.env.NO_COLOR = '';
  savedIsTTY = process.stdout.isTTY;
  // Ensure the horizontal layout path runs (not the plain-text agent path)
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdout, 'isTTY', { value: savedIsTTY, configurable: true });
  io.restore();
});

describe('help command — general help', () => {
  it('displays the logo, wordmark, and commands on stdout, as help <command> does', async () => {
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    expect(io.stderr()).toBe('');
    const err = io.stdout();
    expect(err).toContain('████████████');
    expect(err).toContain('█▄ ▄█');
    expect(err).toContain('Commands');
  });

  it('lists all commands on stdout', async () => {
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stdout();
    expect(err).toContain('wallet');
    expect(err).toContain('info');
    expect(err).toContain('balance');
    expect(err).toContain('address');
    expect(err).toContain('genesis-address');
    expect(err).toContain('inspect-cost');
    expect(err).toContain('airdrop');
    expect(err).toContain('transfer');
    expect(err).toContain('dust');
    expect(err).toContain('config');
  });

  it('outputs plain text on stdout when stdout is not a TTY (agent-friendly, pipeable)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    expect(io.stderr()).toBe('');
    const err = io.stdout();
    // No logo animation
    expect(err).not.toContain('██████████████');
    // Has command list
    expect(err).toContain('Commands');
    expect(err).toContain('wallet');
    expect(err).toContain('balance');
  });
});

describe('help command — specific command help', () => {
  it('shows usage for balance command', async () => {
    const args = parseArgs(['help', 'balance']);
    await cliCall(helpCommand, args);
    const out = io.stdout();
    expect(out).toContain('balance');
    expect(out).toContain('Usage:');
    expect(out).toContain('--network');
    expect(out).toContain('Examples:');
  });

  it('shows usage for generate command', async () => {
    const args = parseArgs(['help', 'generate']);
    await cliCall(helpCommand, args);
    const out = io.stdout();
    expect(out).toContain('generate');
    expect(out).toContain('--seed');
    expect(out).toContain('--mnemonic');
    expect(out).toContain('--output');
  });

  it('shows flags section for commands that have flags', async () => {
    const args = parseArgs(['help', 'address']);
    await cliCall(helpCommand, args);
    const out = io.stdout();
    expect(out).toContain('Flags:');
    expect(out).toContain('--seed');
    expect(out).toContain('--index');
  });

  it('shows usage for airdrop command', async () => {
    const args = parseArgs(['help', 'airdrop']);
    await cliCall(helpCommand, args);
    const out = io.stdout();
    expect(out).toContain('airdrop');
    expect(out).toContain('Usage:');
    expect(out).toContain('amount');
    expect(out).toContain('Examples:');
  });

  it('shows usage for transfer command', async () => {
    const args = parseArgs(['help', 'transfer']);
    await cliCall(helpCommand, args);
    const out = io.stdout();
    expect(out).toContain('transfer');
    expect(out).toContain('Usage:');
    expect(out).toContain('to');
    expect(out).toContain('amount');
    expect(out).toContain('Examples:');
  });

  it('shows usage for dust command', async () => {
    const args = parseArgs(['help', 'dust']);
    await cliCall(helpCommand, args);
    const out = io.stdout();
    expect(out).toContain('dust');
    expect(out).toContain('Usage:');
    expect(out).toContain('register');
    expect(out).toContain('status');
    expect(out).toContain('Examples:');
  });

  it('throws for unknown command with available list', async () => {
    const args = parseArgs(['help', 'nonexistent']);
    await expect(cliCall(helpCommand, args)).rejects.toThrow('Unknown command');
    await expect(cliCall(helpCommand, args)).rejects.toThrow('nonexistent');
    await expect(cliCall(helpCommand, args)).rejects.toThrow('Available commands');
  });
});

describe('help command — --json', () => {
  it('help <unknown> --json is a usage error, as help <unknown> is', async () => {
    await expect(cliCall(helpCommand, parseArgs(['help', 'nope', '--json']))).rejects.toThrow('Unknown command: "nope"');
    expect(io.stdout()).toBe('');
  });

  it('help <command> --json gives the manifest of that command alone', async () => {
    await cliCall(helpCommand, parseArgs(['help', 'balance', '--json']));
    const manifest = JSON.parse(io.stdout()) as { commands: Array<{ name: string }> };
    expect(manifest.commands.map((c) => c.name)).toEqual(['balance']);
  });

  it('help --agent --json gives JSON, the agent manual in it', async () => {
    await cliCall(helpCommand, parseArgs(['help', '--agent', '--json']));
    const manifest = JSON.parse(io.stdout()) as { cli: { name: string }; commands: unknown[]; agentManual: string };
    expect(manifest.cli.name).toBe('midnight-wallet-cli');
    expect(manifest.commands.length).toBeGreaterThan(5);
    expect(manifest.agentManual).toContain('STRUCTURED JSON OUTPUT');
  });
});

describe('help\'s specs (from the registry)', () => {
  it('every spec has a name and description', () => {
    for (const spec of helpSpecs()) {
      expect(spec.name.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.usage.length).toBeGreaterThan(0);
    }
  });

  it('every spec has at least one example', () => {
    for (const spec of helpSpecs()) {
      expect(spec.examples?.length).toBeGreaterThan(0);
    }
  });
});

describe('help — the lists come from the registry', () => {
  /** The intro's command lines, in the order shown: `  name   brief`. */
  function introLines(stderr: string): string[] {
    return stderr.split('\n').filter((line) => /^ {2}[a-z-]+ {2,}\S/.test(line)).map((line) => line.trim().replace(/\s{2,}/, '  '));
  }

  it('the plain intro lists grant after dev, with its brief', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    await cliCall(helpCommand, parseArgs(['help']));
    const lines = introLines(io.stdout());
    expect(lines.slice(9, 15)).toStrictEqual([
      'contract  Inspect, deploy, call contracts',
      'dev  Contract dev loop (watch + deploy)',
      'grant  Grants that let agents spend',
      'swap  Private swaps through offer files',
      'tx  What became of a transaction',
      'config  Manage CLI config',
    ]);
    expect(lines).toHaveLength(21);
  });

  it('the TTY intro lists grant after dev, with its brief', async () => {
    await cliCall(helpCommand, parseArgs(['help', '--no-intro']));
    const err = io.stdout().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const dev = err.indexOf('Contract dev loop (watch + deploy)');
    const grant = err.indexOf('Grants that let agents spend');
    const config = err.indexOf('Manage CLI config');
    expect(dev).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(dev);
    expect(config).toBeGreaterThan(grant);
  });

  it('help --json lists the registry\'s global flags and every command help lists, in order', async () => {
    await cliCall(helpCommand, parseArgs(['help', '--json']));
    const manifest = JSON.parse(io.stdout()) as { globalFlags: { name: string; description: string }[]; commands: { name: string }[] };
    expect(manifest.globalFlags).toStrictEqual([
      { name: '--json', description: 'Output structured JSON to stdout (suppresses all stderr)' },
      { name: '--wallet <name|file>', description: 'Wallet name or path' },
      { name: '--network <name>', description: 'Override network (mainnet, preprod, preview, stagenet, undeployed)' },
      { name: '--version, -v', description: 'Print CLI version' },
      { name: '--help, -h', description: 'Show help' },
    ]);
    expect(manifest.globalFlags).toStrictEqual(installedCommands.globalFlagsHelp);
    expect(manifest.commands.map((c) => c.name)).toStrictEqual(
      installedCommands.commands.filter((c) => c.help !== undefined).map((c) => c.name));
    expect(manifest.commands.map((c) => c.name)).not.toContain('status');
  });

  it('help <command> ends with its errors: its own codes with exit code and meaning, its outcomes, then its sets of codes and every command\'s', async () => {
    await cliCall(helpCommand, parseArgs(['help', 'tx']));
    const out = io.stdout().replace(/\x1b\[[0-9;]*m/g, '');
    expect(out.indexOf('Errors:')).toBeGreaterThan(out.indexOf('Examples:'));
    expect(out.split('Errors:\n')[1]).toBe([
      '  NETWORK_ERROR                  4  Indexer/node/proof-server connection refused or DNS failure.',
      '  Also: the network codes, and INVALID_ARGS, CANCELLED, UNKNOWN, UNSUPPORTED_NODE, NO_STATE_ROOT (mn manual lists them all).',
      '',
      '',
    ].join('\n'));
    io.restore();
    io = captureOutput();
    await cliCall(helpCommand, parseArgs(['help', 'test']));
    expect(io.stdout()).toContain([
      '  NO_TEST_CONFIG                 1  No dapp.test.json in the folder the test command ran in.',
      '  NO_NODE_RUNTIME                1  Contract scripts run under Node.js, and none was found on PATH.',
      '  CONTRACT_NOT_COMPILED          1  No compiled contract was found where the command looked (managed/<name>/compiler/contract-info.json).',
      '  MAINNET_REFUSED                2  The command is refused on mainnet before anything runs: an airdrop (mainnet has no faucet), a test suite (it deploys throwaway contracts), or mn grant (no released account build there).',
      '  (no error)                     1  A test failed',
      '  Also: the network, wallet, engine, sync, paying, offers and chain codes, and INVALID_ARGS, CANCELLED, UNKNOWN, UNSUPPORTED_NODE, NO_STATE_ROOT (mn manual lists them all).',
    ].join('\n'));
  });

  it('help --json gives each command every code it declares with its exit code, the sets by name, and every exit code it can end with', async () => {
    await cliCall(helpCommand, parseArgs(['help', '--json']));
    const manifest = JSON.parse(io.stdout()) as { commands: { name: string; errorCodes: { code: string; exitCode: number }[]; errorSets: string[]; exitCodes: number[] }[] };
    const tx = manifest.commands.find((c) => c.name === 'tx')!;
    expect(tx.errorCodes).toStrictEqual([
      { code: 'NETWORK_ERROR', exitCode: 4 },
      { code: 'AMBIGUOUS_LOCAL_STACKS', exitCode: 4 },
      { code: 'BLOCKFROST_PROJECT_ID_REQUIRED', exitCode: 4 },
      { code: 'BLOCKFROST_PROJECT_ID_REJECTED', exitCode: 4 },
      { code: 'BLOCKFROST_LIMIT_REACHED', exitCode: 4 },
      { code: 'ENDPOINT_SHUT_DOWN', exitCode: 4 },
    ]);
    expect(tx.errorSets).toStrictEqual(['network']);
    // Success, its codes' 4, and every command's: INVALID_ARGS 2, CANCELLED 7, the rest 1.
    expect(tx.exitCodes).toStrictEqual([0, 1, 2, 4, 7]);
    for (const command of manifest.commands) {
      expect(command.errorCodes.map((c) => c.code).sort(), command.name).toStrictEqual(declaredCodes(installedCommands.find(command.name)!).sort());
    }
  });

  it('help <command> finds a command by its definition, and names the rest when it can\'t', async () => {
    await cliCall(helpCommand, parseArgs(['help', 'grant']));
    expect(io.stdout()).toContain('This wallet\'s account, and the grants that let an agent spend from it (experimental)');
    await expect(cliCall(helpCommand, parseArgs(['help', 'status']))).rejects.toThrow(/Available commands: wallet, generate, .*, grant, localnet, help, manual$/);
  });
});
