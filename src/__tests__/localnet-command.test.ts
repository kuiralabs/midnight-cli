// The localnet command as the shell runs it: its arguments, its help and
// intro, and up refused on this ledger-9 build. The localnet library's own
// tests are the dev package's (packages/dev/src/__tests__/localnet.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, commandHelpSpecs, introBriefs } from '@kuiralabs/midnight-cli-core';
import { localnetDefinition } from '@kuiralabs/midnight-dev/commands';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import helpCommand from '../commands/help.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { cliCall } from './helpers/cli-call.ts';

// The handler, as the shell loads it.
const { default: localnetCommand } = await localnetDefinition.load();

let io: CapturedOutput;

beforeEach(() => {
  process.env.NO_COLOR = '';
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  io.restore();
});

describe('localnet command — argument validation', () => {
  it('throws when no subcommand provided', async () => {
    const args = parseArgs(['localnet']);
    await expect(cliCall(localnetCommand, args)).rejects.toThrow('Usage:');
    await expect(cliCall(localnetCommand, args)).rejects.toThrow('up|stop|down|status|logs|clean');
  });

  it('throws for invalid subcommand', async () => {
    const args = parseArgs(['localnet', 'restart']);
    await expect(cliCall(localnetCommand, args)).rejects.toThrow('Usage:');
  });

  it('throws for another invalid subcommand', async () => {
    const args = parseArgs(['localnet', 'start']);
    await expect(cliCall(localnetCommand, args)).rejects.toThrow('Usage:');
  });

  it('error message includes all valid subcommands', async () => {
    const args = parseArgs(['localnet', 'invalid']);
    try {
      await cliCall(localnetCommand, args);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('up');
      expect(msg).toContain('stop');
      expect(msg).toContain('down');
      expect(msg).toContain('status');
      expect(msg).toContain('logs');
      expect(msg).toContain('clean');
    }
  });
});

describe('help integration', () => {
  it('help lists localnet', () => {
    const localnetSpec = commandHelpSpecs(installedCommands).find(s => s.name === 'localnet');
    expect(localnetSpec).toBeDefined();
    expect(localnetSpec!.description).toContain('local');
    expect(localnetSpec!.usage).toContain('up|stop|down|status|logs|clean');
    expect(localnetSpec!.examples!.length).toBeGreaterThan(0);
  });

  it('shows usage for localnet via help command', async () => {
    const args = parseArgs(['help', 'localnet']);
    await cliCall(helpCommand, args);
    const out = io.stdout();
    expect(out).toContain('localnet');
    expect(out).toContain('Usage:');
    expect(out).toContain('up');
    expect(out).toContain('stop');
    expect(out).toContain('down');
    expect(out).toContain('status');
    expect(out).toContain('logs');
    expect(out).toContain('clean');
    expect(out).toContain('Examples:');
  });

  it('the intro lists localnet', () => {
    const localnetBrief = introBriefs(installedCommands).find(([name]) => name === 'localnet');
    expect(localnetBrief).toBeDefined();
    expect(localnetBrief![1]).toContain('local network');
  });
});

describe('localnet up on this ledger-9 build', () => {
  it('refuses with LOCALNET_UNAVAILABLE even without Docker, rather than asking to install Docker', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent'; // no docker binary to find
    try {
      const err: any = await cliCall(localnetCommand, parseArgs(['localnet', 'up'])).catch((e) => e);
      expect(err.code).toBe('LOCALNET_UNAVAILABLE');
      expect(err.message).not.toContain('Docker Compose v2 is required');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
