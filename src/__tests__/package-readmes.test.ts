// The public packages' READMEs: each has its sections, its table of codes as
// the package's code definitions give it, and a mounting (or, for an engine,
// loading) example that runs as it is written: copied into a program of its
// own, in a child process with the packages resolved as an install beside it
// would, a home of the test's own and no network. Each run is checked for
// what its README says it does, typed errors included.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PUBLIC_PACKAGES } from '../../scripts/api-report.mjs';
import { PACKAGE_CODES, README_CODES_END, README_CODES_START, withPackageCodeTable } from '../lib/package-readmes.ts';
import { closedPort } from '../../test-support/closed-port.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const readme = (dir: string): string => readFileSync(join(ROOT, 'packages', dir, 'README.md'), 'utf8');
const ENGINES = ['engine-rc'];

/** The first js block under the heading `heading`. */
function blockUnder(text: string, heading: string): string {
  const at = text.indexOf(`\n${heading}\n`);
  if (at === -1) throw new Error(`no "${heading}" section`);
  const block = /```js\n([\s\S]*?)```/.exec(text.slice(at));
  if (block === null) throw new Error(`no js block under "${heading}"`);
  return block[1]!;
}

const exampleOf = (dir: string): string => blockUnder(readme(dir), dir === 'cli-core' ? '## Mounting commands in your program' : ENGINES.includes(dir) ? '## Loading it' : '## Mounting its commands');

describe('each public package\'s README', () => {
  it.each(PUBLIC_PACKAGES)('%s has its sections and links its API report', (dir) => {
    const text = readme(dir);
    const name = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')).name as string;
    expect(text.startsWith(`# ${name}\n`)).toBe(true);
    for (const heading of ['## Install', '## Entry points', '## Codes']) expect(text, heading).toContain(`\n${heading}\n`);
    expect(text).toContain(`packages/${dir}/api-report.md`);
    expect(exampleOf(dir).length).toBeGreaterThan(0);
  });

  it.each(PUBLIC_PACKAGES)('%s lists the codes it owns as its code definitions give them (npm run package-readmes)', (dir) => {
    const text = readme(dir);
    const codes = PACKAGE_CODES[dir];
    if (codes === undefined) {
      expect(text).not.toContain(README_CODES_START);
      return;
    }
    expect(text).toBe(withPackageCodeTable(text, dir, codes));
    for (const { code } of codes) expect(text).toContain(`| \`${code}\` |`);
    expect(text.indexOf(README_CODES_END)).toBeGreaterThan(text.indexOf(README_CODES_START));
  });
});

describe('each README\'s example, run as it is written', () => {
  let dir: string;
  let home: string;
  let closed: number;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mn-package-readmes-')));
    home = join(dir, 'home');
    mkdirSync(home);
    // The packages resolve as they would installed beside the program.
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    closed = await closedPort();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the package's example with `argv` from `cwd` (the test's folder by default). */
  function run(pkg: string, argv: string[], cwd = dir): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const program = join(dir, `${pkg}.mjs`);
    writeFileSync(program, exampleOf(pkg));
    return new Promise((done) => {
      const child = spawn(process.execPath, ['--conditions=midnight-cli-source', '--import', 'tsx', program, ...argv], {
        cwd,
        env: { ...process.env, HOME: home, MN_PASSPHRASE: 'readme example passphrase', MN_NO_LOCAL_DETECT: '1', NO_COLOR: '1', WALLET_SEED: '07'.repeat(32) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const hung = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.on('exit', (code) => { clearTimeout(hung); done({ code, stdout, stderr }); });
    });
  }
  const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

  it('core: config set and get, under the program\'s own state root', async () => {
    expect((await run('cli-core', ['config', 'set', 'network', 'preview'])).code).toBe(0);
    const got = await run('cli-core', ['config', 'get', 'network', '--json']);
    expect(got.code).toBe(0);
    expect(lastJson(got.stdout)).toMatchObject({ key: 'network', value: 'preview' });
    expect(existsSync(join(home, '.my-app', 'config.json'))).toBe(true);
    expect(existsSync(join(home, '.midnight'))).toBe(false);
  }, 120_000);

  it('wallet: generates a wallet in the program\'s state root, and a missing one is WALLET_NOT_FOUND, exit 3', async () => {
    const made = await run('wallet', ['wallet', 'generate', 'alice', '--json']);
    expect(made.code, made.stderr).toBe(0);
    expect(lastJson(made.stdout)).toMatchObject({ name: 'alice' });
    expect(existsSync(join(home, '.my-app', 'wallets', 'alice.json'))).toBe(true);
    const missing = await run('wallet', ['wallet', 'info', 'bob', '--json']);
    expect(missing.code).toBe(3);
    expect(missing.stderr.startsWith('WALLET_NOT_FOUND: ')).toBe(true);
  }, 120_000);

  it('chain: tx status against an indexer that doesn\'t answer is NETWORK_ERROR, exit 4', async () => {
    const result = await run('chain', ['tx', 'status', 'ab'.repeat(32), '--network', 'undeployed', '--indexer-ws', `ws://127.0.0.1:${closed}/api/v4/graphql/ws`, '--json']);
    expect(result.code).toBe(4);
    expect(result.stderr.startsWith('NETWORK_ERROR: ')).toBe(true);
  }, 120_000);

  it('contract: inspect where nothing is compiled is CONTRACT_NOT_COMPILED, exit 1', async () => {
    const empty = join(dir, 'no-contract');
    mkdirSync(empty, { recursive: true });
    const result = await run('contract', ['contract', 'inspect', '--path', empty, '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr.startsWith('CONTRACT_NOT_COMPILED: ')).toBe(true);
  }, 120_000);

  it('connect: serve for a wallet that doesn\'t exist is WALLET_NOT_FOUND, exit 3', async () => {
    const result = await run('connect', ['serve', '--wallet', 'nobody', '--network', 'undeployed', '--json']);
    expect(result.code).toBe(3);
    expect(result.stderr.startsWith('WALLET_NOT_FOUND: ')).toBe(true);
  }, 120_000);

  it('dev: test list in a folder with no dapp.test.json is NO_TEST_CONFIG, exit 1', async () => {
    const result = await run('dev', ['test', 'list', '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr.startsWith('NO_TEST_CONFIG: ')).toBe(true);
  }, 120_000);

  it('grant: grant list for a wallet with no account is NO_ACCOUNT, exit 1', async () => {
    // alice, from the wallet example: the same state root.
    const result = await run('grant', ['grant', 'list', '--wallet', 'alice', '--network', 'undeployed', '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr.startsWith('NO_ACCOUNT: ')).toBe(true);
  }, 120_000);

  it.each([['engine-rc', 'rc', 'mn_addr_undeployed1']])('%s: loads its engine and derives the address', async (pkg, set, prefix) => {
    const result = await run(pkg, []);
    expect(result.code, result.stderr).toBe(0);
    const [printedSet, address] = result.stdout.trim().split(' ');
    expect(printedSet).toBe(set);
    expect(address!.startsWith(prefix)).toBe(true);
  }, 120_000);
});
