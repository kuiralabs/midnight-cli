// A user's mistake is a usage error: INVALID_ARGS, exit 2, with a message
// that says what to fix. Each of these used to end as UNKNOWN, exit 1, the
// code for a failure mn can't explain. Run as the CLI is, with a home of the
// test's own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../test-support/run-cli.ts';

const PASSPHRASE = { MN_PASSPHRASE: 'usage-error-codes-passphrase' };
const SEED_A = 'a1'.repeat(32);
const SEED_B = 'b2'.repeat(32);
let home: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-usage-codes-')));
  for (const [name, seed] of [['alice', SEED_A], ['bob', SEED_B]] as const) {
    expect(runCli(home, ['wallet', 'generate', name, '--seed', seed, '--json'], { env: PASSPHRASE }).status).toBe(0);
  }
}, 60_000);
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** Runs `args --json` and expects INVALID_ARGS (exit 2) with `message` in its message. */
function expectUsageError(args: readonly string[], message: string | RegExp, at = home) {
  const run = runCli(at, [...args, '--json'], { env: PASSPHRASE });
  const result = JSON.parse(run.stdout) as { code: string; message: string; exitCode: number };
  expect(result).toMatchObject({ error: true, code: 'INVALID_ARGS', exitCode: 2 });
  if (typeof message === 'string') expect(result.message).toContain(message);
  else expect(result.message).toMatch(message);
  expect(run.status).toBe(2);
  return result;
}

describe('wallet names', () => {
  it('a name with a path in it', () => { expectUsageError(['wallet', 'generate', '../x', '--seed', SEED_A], 'Invalid wallet name'); });

  it('a name too long, refused before the passphrase is asked for or set', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'mn-usage-long-')));
    try {
      expectUsageError(['wallet', 'generate', 'x'.repeat(300), '--seed', SEED_A], 'Wallet name is 300 characters; at most 64', fresh);
      expect(existsSync(join(fresh, '.midnight', 'keystore.json'))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('a wallet that exists already', () => { expectUsageError(['wallet', 'generate', 'alice', '--seed', SEED_A], 'already exists'); });
  it('removing the active wallet', () => { expectUsageError(['wallet', 'remove', 'bob'], 'Cannot remove the active wallet'); });
  it('a --wallet that is not a wallet file', () => {
    const file = join(home, 'not-a-wallet.json');
    writeFileSync(file, 'root:x:0:0\n');
    expectUsageError(['wallet', 'info', '--wallet', file], 'Invalid JSON in wallet file');
  });

  it('removing the only wallet', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'mn-usage-only-')));
    try {
      expect(runCli(fresh, ['wallet', 'generate', 'solo', '--seed', SEED_A, '--json'], { env: PASSPHRASE }).status).toBe(0);
      // The active wallet named by hand, so solo is the only wallet but not the active one.
      writeFileSync(join(fresh, '.midnight', 'config.json'), JSON.stringify({ network: 'undeployed', wallet: 'gone' }));
      expectUsageError(['wallet', 'remove', 'solo'], 'it is the only wallet', fresh);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('networks', () => {
  it('a --network mn does not know', () => { expectUsageError(['wallet', 'list', '--network', 'bogus'], 'Invalid network: "bogus"'); });

  it('config set network offers only the networks it can save (not mainnet)', () => {
    const result = expectUsageError(['config', 'set', 'network', 'bogus'], 'Invalid network: "bogus"');
    expect(result.message).not.toContain('mainnet');
  });

  it('airdrop on a network without one', () => { expectUsageError(['airdrop', '10', '--network', 'preview'], 'only available on the "undeployed" network'); });
});

describe('config', () => {
  it('an unknown key', () => { expectUsageError(['config', 'get', 'bogus'], 'Unknown config key'); });

  it.each([
    ['node', 'http://localhost:9944', 'ws:// or wss://'],
    ['indexer-ws', 'https://localhost:8088/api/v4/graphql/ws', 'ws:// or wss://'],
    ['proof-server', 'ws://localhost:6300', 'http:// or https://'],
    ['node', 'not-a-url', 'ws:// or wss://'],
  ])('%s %s: a URL of a scheme that endpoint is not reached by', (key, value, schemes) => {
    expectUsageError(['config', 'set', key, value], schemes);
  });

  it('a wallet that does not exist, refused like wallet use, leaving the active wallet', () => {
    const before = readFileSync(join(home, '.midnight', 'config.json'), 'utf8');
    expectUsageError(['config', 'set', 'wallet', 'nope'], 'Wallet "nope" not found');
    expect(readFileSync(join(home, '.midnight', 'config.json'), 'utf8')).toBe(before);
  });

  it('takes a wallet that exists', () => {
    const run = runCli(home, ['config', 'set', 'wallet', 'bob', '--json'], { env: PASSPHRASE });
    expect(run.status).toBe(0);
  });
});

describe('numbers', () => {
  it.each(['0', 'abc', '70000', '80x'])('serve --port %s', (port) => { expectUsageError(['serve', '--port', port], `Invalid port: "${port}"`); });
  it.each(['99999999999', '-1', '1.5'])('address --index %s', (index) => { expectUsageError(['address', '--seed', SEED_A, '--index', index], 'Key index must be a non-negative integer, at most 2147483647'); });
});

describe('the hidden status command', () => {
  // Like an unknown command: a usage error, where `mn status --help` shows the help (exit 0).
  it('is refused as a usage error', () => { expectUsageError(['status'], 'being reworked'); });
});
