// --json keeps stderr quiet, as help and the manual promise: no spinner,
// heading, notice or warning; the result or the error is JSON on stdout. Run
// as the CLI is: this checkout's entry point in its own process, in a
// temporary home.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closedPort } from '../../test-support/closed-port.ts';
import { captureOutput } from '../../test-support/capture-output.ts';
import { createCliHost, waitLineWriter } from '../lib/cli-host.ts';

const entryPoint = resolve(import.meta.dirname, '../wallet.ts');
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let home: string;

beforeAll(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-json-quiet-'))); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

function mn(...args: string[]) {
  const run = spawnSync(process.execPath, ['--import', tsxLoader, entryPoint, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: '1', MN_PASSPHRASE: 'a passphrase for tests' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('--json keeps stderr quiet', () => {
  it('drops the deprecated command\'s notice', () => {
    const run = mn('generate', '--network', 'undeployed', '--json');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toHaveProperty('addresses');
    expect(run.stderr).toBe('');
  }, 60_000);

  it('shows no spinner for a balance read that fails, only the JSON error', async () => {
    const port = await closedPort();
    const address = 'mn_addr_undeployed1gkasr3z3vwyscy2jpp53nzr37v7n4r3lsfgj6v5g584dakjzt0xqun4d4r';
    const run = mn('balance', address, '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--json');
    expect(run.status).toBe(4);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'NETWORK_ERROR' });
    expect(run.stderr).toBe('');
  }, 60_000);
});

describe('a human-mode error', () => {
  it('with a code of its own says what to do, and no generic "Run midnight help"', async () => {
    const port = await closedPort();
    const run = mn('balance', 'mn_addr_undeployed1gkasr3z3vwyscy2jpp53nzr37v7n4r3lsfgj6v5g584dakjzt0xqun4d4r', '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`);
    expect(run.status).toBe(4);
    expect(run.stderr).toContain(`Cannot reach the indexer at http://127.0.0.1:${port}/api/v4/graphql`);
    expect(run.stderr).not.toContain('midnight help');
  }, 60_000);
});

describe('mn serve against endpoints that are down', () => {
  it('fails fast with NETWORK_ERROR naming the indexer, instead of retrying for ever', async () => {
    expect(mn('wallet', 'generate', 'servetest', '--network', 'undeployed', '--json').status).toBe(0);
    const port = await closedPort();
    const started = Date.now();
    const run = mn('serve', '--wallet', 'servetest', '--network', 'undeployed', '--port', String(await closedPort()),
      '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--node', `ws://127.0.0.1:${port}`, '--json');
    expect(run.status).toBe(4);
    expect(JSON.parse(run.stdout)).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`Cannot reach the indexer at http://127.0.0.1:${port}/api/v4/graphql: connection refused.`) });
    expect(run.stderr).toBe('');
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe('the CLI host\'s notices', () => {
  it('go to stderr, and nowhere when the run is --json', () => {
    const io = captureOutput();
    try {
      createCliHost({ prompter: null }).notice('Warning: a plain-text wallet');
      createCliHost({ prompter: null, notices: false }).notice('Warning: dropped');
    } finally {
      io.restore();
    }
    expect(io.stderr()).toBe('Warning: a plain-text wallet\n');
  });
});

describe("the CLI host's waits", () => {
  // A deploy that waited 181 s for its Dust under --json said nothing at all on stderr.
  it('reach stderr also when the run is --json, as plain lines', () => {
    const io = captureOutput();
    try {
      createCliHost({ prompter: null, notices: false, plainWaits: true }).waiting('\x1b[2m  Dust: waited 15 s of 269 s, 0.43 of 3.17 DUST\x1b[0m', false);
    } finally {
      io.restore();
    }
    expect(io.stderr()).toBe('Dust: waited 15 s of 269 s, 0.43 of 3.17 DUST\n');
  });

  it('at a terminal, are written over the line a spinner draws, which draws itself again below', () => {
    const written: string[] = [];
    waitLineWriter(false, true, (text) => written.push(text))('  Dust: waited 15 s of 269 s, 0.43 of 3.17 DUST');
    waitLineWriter(false, false, (text) => written.push(text))('  Dust: waited 30 s of 269 s, 0.55 of 3.17 DUST');
    expect(written).toEqual(['\r\x1b[K  Dust: waited 15 s of 269 s, 0.43 of 3.17 DUST\n', '  Dust: waited 30 s of 269 s, 0.55 of 3.17 DUST\n']);
  });
});
