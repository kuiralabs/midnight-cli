// The shell reports an error's code as the MCP server does: from its code,
// a usage error's included. Run as the CLI is: this checkout's entry point in
// its own process, with a temporary home and no MN_PASSPHRASE, where nothing
// can ask for the passphrase.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entryPoint = resolve(import.meta.dirname, '../wallet.ts');
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const SEED = '0000000000000000000000000000000000000000000000000000000000000001';

let home: string;

beforeAll(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-shell-codes-'))); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

function mn(...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: '1' };
  delete env.MN_PASSPHRASE;
  const run = spawnSync(process.execPath, ['--import', tsxLoader, entryPoint, ...args], { env, encoding: 'utf8', input: '', timeout: 30_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('the shell\'s error codes', () => {
  it('reports PASSPHRASE_REQUIRED (exit 2) under --json when a command needs the passphrase and none can be had', () => {
    const run = mn('wallet', 'generate', 'alice', '--seed', SEED, '--network', 'undeployed', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toStrictEqual({
      error: true,
      code: 'PASSPHRASE_REQUIRED',
      message: "This needs mn's passphrase. Set MN_PASSPHRASE, or run it at a terminal to be asked for it.",
      exitCode: 2,
    });
    // Refused before it wrote anything: no wallet.
    expect(existsSync(join(home, '.midnight', 'wallets', 'alice.json'))).toBe(false);
  });

  it('shows it as a usage problem at a terminal, with exit 2', () => {
    const run = mn('wallet', 'generate', 'alice', '--seed', SEED, '--network', 'undeployed');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Usage: This needs mn's passphrase.");
  });

  it('still reports any other usage error as INVALID_ARGS (exit 2)', () => {
    const run = mn('transfer', '--json');
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', exitCode: 2 });
  });
});
