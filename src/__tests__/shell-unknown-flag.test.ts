// The shell refuses a flag the command doesn't accept before the command runs,
// and shows the command's help instead when help is asked for. Run as the CLI is: this
// checkout's entry point in its own process, with a temporary home that holds
// no wallet, so a command that ran would fail with WALLET_NOT_FOUND (exit 3).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entryPoint = resolve(import.meta.dirname, '../wallet.ts');
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let home: string;

beforeAll(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-unknown-flag-'))); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

function mn(...args: string[]) {
  const run = spawnSync(process.execPath, ['--import', tsxLoader, entryPoint, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('the unknown-flag refusal, through the shell', () => {
  it('refuses an unknown flag with exit 2 and INVALID_ARGS, before the command runs', () => {
    const run = mn('info', '--bogus', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', message: expect.stringContaining('--bogus') });
  });

  it('names every unknown flag at a terminal, with exit 2', () => {
    const run = mn('info', '--bogus', '--other', 'x');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown flags for "midnight info": --bogus, --other');
  });

  it('refuses a flag of another subcommand with exit 2 and INVALID_ARGS, before the command runs', () => {
    const run = mn('dust', 'register', '--seed', 'ab', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', message: expect.stringContaining('--seed (only for export)') });
  });

  // `mn -x` showed the help and exited 0, as if nothing were wrong.
  it('refuses an unknown flag with no command, exit 2', () => {
    const run = mn('-x', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', message: expect.stringContaining('Unknown flag: -x') });
  });

  it('takes a flag written --flag=value', () => {
    const run = mn('info', '--network=undeployed', '--json');
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'WALLET_NOT_FOUND' });
  });

  it('runs the command when its flags are known: here it finds no wallet', () => {
    const run = mn('info', '--network', 'undeployed', '--json');
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'WALLET_NOT_FOUND' });
  });

  it('shows the command\'s own help instead when help is asked for, whatever else is on the line', () => {
    const run = mn('info', '--bogus', '--help');
    expect(run.status).toBe(0);
    expect(run.stdout + run.stderr).toBe(mn('help', 'info').stdout + mn('help', 'info').stderr);
    expect(run.stdout + run.stderr).toContain('Display wallet address, network, creation date');
    expect(run.stdout + run.stderr).not.toContain('Unknown flag');
  });

  it('shows the command\'s help for a subcommand line too, and -h does the same', () => {
    const own = mn('help', 'wallet');
    expect(mn('wallet', 'generate', 'alice', '--help').stdout + mn('wallet', 'generate', 'alice', '--help').stderr).toBe(own.stdout + own.stderr);
    expect(mn('wallet', '-h').stdout + mn('wallet', '-h').stderr).toBe(own.stdout + own.stderr);
  });

  it('shows the general help for --help alone, or after a command it doesn\'t know', () => {
    for (const run of [mn('--help'), mn('bogus', '--help'), mn('help', '--help')]) {
      expect(run.status).toBe(0);
      expect(run.stdout + run.stderr).toContain('Commands:');
    }
  });

  it('keeps --help --json as the JSON manifest', () => {
    const run = mn('--help', '--json');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ cli: { name: 'midnight-wallet-cli' } });
  });

  it('refuses help for an unknown command with exit 2, with --json as without', () => {
    const json = mn('help', 'nope', '--json');
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', exitCode: 2 });
    expect(mn('help', 'nope').status).toBe(2);
  });

  it('writes the general help to stdout, as a command\'s help, and nothing to stderr', () => {
    const run = mn('help');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Commands:');
    expect(run.stderr).toBe('');
  });
});
