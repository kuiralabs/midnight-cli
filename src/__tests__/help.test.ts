import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import helpCommand, { helpSpecs } from '../commands/help.ts';
import { parseArgs } from '../lib/argv.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';

let io: CapturedOutput;
let savedIsTTY: boolean | undefined;

beforeEach(() => {
  process.env.NO_COLOR = '';
  savedIsTTY = process.stderr.isTTY;
  // Ensure the horizontal layout path runs (not the plain-text agent path)
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stderr, 'isTTY', { value: savedIsTTY, configurable: true });
  io.restore();
});

describe('help command — general help', () => {
  it('displays the logo, wordmark, and commands on stderr', async () => {
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stderr();
    expect(err).toContain('████████████');
    expect(err).toContain('█▄ ▄█');
    expect(err).toContain('Commands');
  });

  it('lists all commands on stderr', async () => {
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stderr();
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

  it('outputs plain text when stderr is not a TTY (agent-friendly)', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stderr();
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

describe('help — the lists come from the registry (2D)', () => {
  /** The intro's command lines, in the order shown: `  name   brief`. */
  function introLines(stderr: string): string[] {
    return stderr.split('\n').filter((line) => /^ {2}[a-z-]+ {2,}\S/.test(line)).map((line) => line.trim().replace(/\s{2,}/, '  '));
  }

  it('the plain intro lists grant after dev, with its brief', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    await cliCall(helpCommand, parseArgs(['help']));
    const lines = introLines(io.stderr());
    expect(lines.slice(9, 14)).toStrictEqual([
      'contract  Inspect, deploy, call contracts',
      'dev  Contract dev loop (watch + deploy)',
      'grant  Grants that let agents spend',
      'config  Manage CLI config',
      'cache  Manage wallet cache',
    ]);
    expect(lines).toHaveLength(19);
  });

  it('the TTY intro lists grant after dev, with its brief', async () => {
    await cliCall(helpCommand, parseArgs(['help', '--no-intro']));
    const err = io.stderr().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
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
      { name: '--network <name>', description: 'Override network (preprod, preview, undeployed)' },
      { name: '--version, -v', description: 'Print CLI version' },
      { name: '--help, -h', description: 'Show help' },
    ]);
    expect(manifest.globalFlags).toStrictEqual(installedCommands.globalFlagsHelp);
    expect(manifest.commands.map((c) => c.name)).toStrictEqual(
      installedCommands.commands.filter((c) => c.help !== undefined).map((c) => c.name));
    expect(manifest.commands.map((c) => c.name)).not.toContain('status');
  });

  it('help <command> finds a command by its definition, and names the rest when it can\'t', async () => {
    await cliCall(helpCommand, parseArgs(['help', 'grant']));
    expect(io.stdout()).toContain('This wallet\'s account, and the grants that let an agent spend from it (experimental)');
    await expect(cliCall(helpCommand, parseArgs(['help', 'status']))).rejects.toThrow(/Available commands: wallet, generate, .*, grant, localnet, help, manual$/);
  });
});
