import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import helpCommand from '../commands/help.ts';
import { parseArgs } from '@kuiralabs/midnight-cli-core';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';

let io: CapturedOutput;
let savedIsTTY: boolean | undefined;

beforeEach(() => {
  process.env.NO_COLOR = '';
  savedIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdout, 'isTTY', { value: savedIsTTY, configurable: true });
  io.restore();
});

describe('help --agent', () => {
  it('outputs comprehensive agent manual to stdout', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('AI Agent & MCP Reference');
    expect(out).toContain('STRUCTURED JSON OUTPUT');
    expect(out).toContain('--json');
  });

  it('lists every error code mn can return', async () => {
    const { ERROR_CODES } = await import('@kuiralabs/midnight-cli-core');
    await cliCall(helpCommand, parseArgs(['help', '--agent']));
    const table = io.stdout().split('ERROR CODES')[1]!.split('MCP SERVER')[0]!;
    const missing = Object.values(ERROR_CODES).filter((code) => !new RegExp(`^  ${code}\\s+\\d`, 'm').test(table));
    expect(missing).toEqual([]);
  });

  it("names each command's own error codes under its usage", async () => {
    await cliCall(helpCommand, parseArgs(['help', '--agent']));
    expect(io.stdout()).toContain('\n  tx\n  midnight tx status <hash or identifier> [options]\n  Error codes: NETWORK_ERROR, SYNC_TIMEOUT; sets: network\n  JSON fields:\n');
    expect(io.stdout()).toContain('\n  config\n  midnight config get [key] [--network <name>] | midnight config <set|unset> <key> [value] [--network <name>]\n  Error codes: none; sets: network\n');
  });

  it('lists each set of codes once, by name, after the code table', async () => {
    await cliCall(helpCommand, parseArgs(['help', '--agent']));
    const table = io.stdout().split('ERROR CODES')[1]!.split('MCP SERVER')[0]!;
    expect(table).toContain('\n  Sets of codes (a command\'s "sets", a tool\'s "Errors" name them):\n    network   AMBIGUOUS_LOCAL_STACKS, BLOCKFROST_PROJECT_ID_REQUIRED, BLOCKFROST_PROJECT_ID_REJECTED, BLOCKFROST_LIMIT_REACHED, ENDPOINT_SHUT_DOWN\n    wallet    WALLET_NOT_FOUND, WRONG_PASSPHRASE, PASSPHRASE_REQUIRED\n');
  });

  it('documents all commands', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('generate');
    expect(out).toContain('info');
    expect(out).toContain('balance');
    expect(out).toContain('address');
    expect(out).toContain('genesis-address');
    expect(out).toContain('inspect-cost');
    expect(out).toContain('airdrop');
    expect(out).toContain('transfer');
    expect(out).toContain('dust');
    expect(out).toContain('config');
    expect(out).toContain('localnet');
  });

  it('documents error codes', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('ERROR CODES');
    expect(out).toContain('INVALID_ARGS');
    expect(out).toContain('WALLET_NOT_FOUND');
    expect(out).toContain('NETWORK_ERROR');
    expect(out).toContain('TX_REJECTED');
    expect(out).toContain('CANCELLED');
  });

  it('documents exit codes in error codes section', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('ERROR CODES');
    expect(out).toContain('INVALID_ARGS');
    expect(out).toContain('WALLET_NOT_FOUND');
  });

  it('documents MCP server setup', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('MCP SERVER');
    expect(out).toContain('midnight-wallet-mcp');
    expect(out).toContain('mcpServers');
  });

  it('includes example CLI commands', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('EXAMPLE CLI COMMANDS');
    expect(out).toContain('midnight wallet generate');
    expect(out).toContain('midnight balance');
    expect(out).toContain('midnight airdrop');
    expect(out).toContain('--shielded');
    expect(out).toContain('midnight contract inspect');
    expect(out).toContain('midnight serve');
  });

  it('documents shielded transactions', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('SHIELDED TRANSACTIONS');
    expect(out).toContain('--shielded');
    expect(out).toContain('shieldedAddress');
  });

  it('documents DApp connector', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('DAPP CONNECTOR');
    expect(out).toContain('midnight serve');
    expect(out).toContain('midnight-wallet-connector');
    expect(out).toContain('ws://localhost:9932');
  });

  it('documents smart contracts and testing', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('SMART CONTRACTS');
    expect(out).toContain('midnight contract inspect');
    expect(out).toContain('midnight contract deploy');
    expect(out).toContain('midnight contract call');
    expect(out).toContain('midnight contract state');
    expect(out).toContain('E2E TESTING');
    expect(out).toContain('midnight test run');
  });

  it('documents wallet name resolution', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('WALLET NAME RESOLUTION');
    expect(out).toContain('midnight transfer alice 10');
  });

  it('documents capability manifest', async () => {
    const args = parseArgs(['help', '--agent']);
    await cliCall(helpCommand, args);
    const out = io.stdout();

    expect(out).toContain('CAPABILITY MANIFEST');
    expect(out).toContain('midnight help --json');
  });
});

describe('help screen — mentions --json and --agent', () => {
  it('TTY help mentions --json flag', async () => {
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stdout();

    expect(err).toContain('--json');
  });

  it('TTY help mentions --agent manual', async () => {
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stdout();

    expect(err).toContain('--agent');
  });

  it('non-TTY help mentions --json flag', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stdout();

    expect(err).toContain('--json');
  });

  it('non-TTY help mentions --agent manual', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    const args = parseArgs(['help']);
    await cliCall(helpCommand, args);
    const err = io.stdout();

    expect(err).toContain('--agent');
  });
});
