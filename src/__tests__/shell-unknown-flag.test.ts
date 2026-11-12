// The shell refuses a flag the command doesn't accept before the command runs,
// and shows the command's help instead when help is asked for. Run as the CLI is: this
// checkout's entry point in its own process, with a temporary home that holds
// no wallet, so a command that ran would fail with WALLET_NOT_FOUND (exit 3).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../test-support/run-cli.ts';

let home: string;

beforeAll(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-unknown-flag-'))); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** Runs `mn <args>` in its own process with HOME at the test's home. */
const mn = (...args: string[]) => runCli(home, args);

describe('the unknown-flag refusal, through the shell', () => {
  it('refuses an unknown flag with exit 2 and INVALID_ARGS, before the command runs', async () => {
    const run = await mn('info', '--bogus', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', message: expect.stringContaining('--bogus') });
  });

  it('names every unknown flag at a terminal, with exit 2', async () => {
    const run = await mn('info', '--bogus', '--other', 'x');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown flags for "midnight info": --bogus, --other');
  });

  it('refuses a flag of another subcommand with exit 2 and INVALID_ARGS, before the command runs', async () => {
    const run = await mn('dust', 'register', '--seed', 'ab', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', message: expect.stringContaining('--seed (only for export)') });
  });

  // `mn -x` showed the help and exited 0, as if nothing were wrong.
  it('refuses an unknown flag with no command, exit 2', async () => {
    const run = await mn('-x', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', message: expect.stringContaining('Unknown flag: -x') });
  });

  it('takes a flag written --flag=value', async () => {
    const run = await mn('info', '--network=undeployed', '--json');
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'WALLET_NOT_FOUND' });
  });

  it('runs the command when its flags are known: here it finds no wallet', async () => {
    const run = await mn('info', '--network', 'undeployed', '--json');
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'WALLET_NOT_FOUND' });
  });

  it('shows the command\'s own help instead when help is asked for, whatever else is on the line', async () => {
    const run = await mn('info', '--bogus', '--help');
    expect(run.status).toBe(0);
    const help = await mn('help', 'info');
    expect(run.stdout + run.stderr).toBe(help.stdout + help.stderr);
    expect(run.stdout + run.stderr).toContain('Display wallet address, network, creation date');
    expect(run.stdout + run.stderr).not.toContain('Unknown flag');
  });

  it('shows the command\'s help for a subcommand line too, and -h does the same', async () => {
    const own = await mn('help', 'wallet');
    for (const run of [await mn('wallet', 'generate', 'alice', '--help'), await mn('wallet', '-h')]) {
      expect(run.stdout + run.stderr).toBe(own.stdout + own.stderr);
    }
  });

  it('shows the general help for --help alone, or after a command it doesn\'t know', async () => {
    for (const run of [await mn('--help'), await mn('bogus', '--help'), await mn('help', '--help')]) {
      expect(run.status).toBe(0);
      expect(run.stdout + run.stderr).toContain('Commands:');
    }
  });

  it('keeps --help --json as the JSON manifest', async () => {
    const run = await mn('--help', '--json');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ cli: { name: 'midnight-wallet-cli' } });
  });

  it('refuses help for an unknown command with exit 2, with --json as without', async () => {
    const json = await mn('help', 'nope', '--json');
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', exitCode: 2 });
    expect((await mn('help', 'nope')).status).toBe(2);
  });

  it('writes the general help to stdout, as a command\'s help, and nothing to stderr', async () => {
    const run = await mn('help');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Commands:');
    expect(run.stderr).toBe('');
  });
});
