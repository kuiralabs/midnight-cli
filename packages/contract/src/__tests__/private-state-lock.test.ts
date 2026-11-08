// A contract's private-state store another process holds: a second process
// keeps the real LevelDB folder open (its LOCK), as another mn's call does
// while it reads or writes the store, with the holder file that mn writes. A
// generated script, run as mn runs one, writes through midnight-js's real
// level provider wrapped in waitForPrivateState (as the deploy and call
// scripts wrap theirs): it waits, says once why and for whom, then the time
// waited, and writes once the folder is free; or fails as CONTRACT_STATE_BUSY.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CancelledError } from '@kuiralabs/midnight-cli-core';
import { CONTRACT_STATE_BUSY, claimPrivateStateStore, holderCommandOf } from '../lib/contract/private-state-lock.ts';
import { ContractStateBusyError, SCRIPT_PARTS, executeScript } from '../lib/contract/runner.ts';

const ADDRESS = 'ab'.repeat(32);
const require = createRequire(import.meta.url);
/** midnight-js's level provider, and the LevelDB binding it opens folders with, as the scripts load them. */
const PROVIDER = require.resolve('@midnight-ntwrk/midnight-js-level-private-state-provider');
const LEVEL = createRequire(PROVIDER).resolve('level');
const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };

let work: string;
let dir: string;
let holder: ChildProcess | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-private-state-lock-'));
  dir = path.join(work, 'store');
});

afterEach(() => {
  holder?.kill('SIGKILL');
  holder = undefined;
  fs.rmSync(work, { recursive: true, force: true });
});

/** Another process holding the store's folder open until it is told to let go (a line on its stdin); resolves once it holds it. */
async function holdStore(): Promise<{ pid: number; release: () => Promise<void> }> {
  const code = `
    const { Level } = await import(${JSON.stringify(pathToFileURL(LEVEL).href)});
    const db = new Level(${JSON.stringify(dir)});
    await db.open();
    process.stdout.write('held\\n');
    process.stdin.once('data', async () => { await db.close(); process.stdout.write('released\\n'); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  holder = child;
  const said = (word: string) => new Promise<void>((resolve) => {
    const listen = (chunk: Buffer) => { if (chunk.toString().includes(word)) { child.stdout!.off('data', listen); resolve(); } };
    child.stdout!.on('data', listen);
  });
  await said('held');
  return { pid: child.pid!, release: async () => { const done = said('released'); child.stdin!.write('go\n'); await done; } };
}

/** A script that writes the contract's private state and reads it back, through the waiting provider, as the call script does. */
const writingScript = (timeoutMs: number) => `${SCRIPT_PARTS.prelude}
import * as mnFs from 'node:fs';
import * as mnPath from 'node:path';
import { levelPrivateStateProvider } from ${JSON.stringify(pathToFileURL(PROVIDER).href)};
${SCRIPT_PARTS.privateStateWaitFn}
const provider = waitForPrivateState(levelPrivateStateProvider({
  midnightDbName: ${JSON.stringify(dir)},
  privateStateStoreName: 'counterPrivateState',
  privateStoragePasswordProvider: () => 'A-wallet-password-0f-length',
  accountId: 'the-wallet',
}), {
  fs: mnFs,
  join: mnPath.join,
  isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; } },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notice: (line) => process.stderr.write('\\n${SCRIPT_PARTS.noticeMarker} ' + JSON.stringify(line) + '\\n'),
  progress: (line) => process.stderr.write(line + '\\n'),
}, { dir: ${JSON.stringify(dir)}, address: ${JSON.stringify(ADDRESS)}, ownPid: process.ppid, timeoutMs: ${timeoutMs} });
await provider.forContract(${JSON.stringify(ADDRESS)}).set('counterPrivateState', { count: 1 });
console.log(JSON.stringify(await provider.forContract(${JSON.stringify(ADDRESS)}).get('counterPrivateState')));
process.exit(0);
`;

/** Runs the script as mn runs one, collecting its notices and progress lines. */
function run(timeoutMs: number, signal?: AbortSignal) {
  const notices: string[] = [];
  const progress: string[] = [];
  // A read of the script's stderr can carry several lines.
  const result = executeScript({ dir: work, script: writingScript(timeoutMs), overlaySdk: false, packages: NO_PACKAGES, onNotice: (line) => notices.push(line), onMessage: (lines) => progress.push(...lines.split('\n')), signal });
  result.catch(() => {});
  return { result, notices, progress };
}

const until = async (check: () => boolean, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('a contract script whose private-state store another mn holds', () => {
  beforeAll(() => {
    // The store's folder exists, as a call's does before its script runs.
    expect(fs.existsSync(PROVIDER)).toBe(true);
  });

  it('waits, says once that it waits and for whom, then writes once the store is free', async () => {
    const other = await holdStore();
    claimPrivateStateStore({ fs, join: path.join }, dir, { pid: other.pid, command: holderCommandOf([process.execPath, '/usr/local/bin/mn', 'contract', 'call', '--address', ADDRESS, '--secret-key', 'never-written']) });
    // A holder file left by an mn that ended is not named.
    fs.writeFileSync(path.join(dir, 'mn-holder-999999.json'), JSON.stringify({ pid: 999999, command: 'mn contract call' }));

    const { result, notices, progress } = run(60_000);
    await until(() => progress.filter((line) => line.startsWith('Waiting for')).length >= 2);
    await other.release();

    expect(JSON.parse(await result)).toEqual({ count: 1 });
    expect(notices).toEqual([`Contract ${ADDRESS}'s private state is in use by another mn (pid ${other.pid}, mn contract call): waiting for it.`]);
    expect(progress.some((line) => /^Waiting for contract (ab)+'s private state, in use by another mn \(pid \d+, mn contract call\) \(\d+ s\)\.\.\.$/.test(line))).toBe(true);
    expect(notices.join('')).not.toContain('never-written');
  });

  it('fails as CONTRACT_STATE_BUSY when the store stays in use past the wait, naming it and its holder', async () => {
    const other = await holdStore();
    claimPrivateStateStore({ fs, join: path.join }, dir, { pid: other.pid, command: 'mn contract call' });

    const err = await run(1_500).result.then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(ContractStateBusyError);
    expect(err).toMatchObject({ code: CONTRACT_STATE_BUSY });
    expect((err as Error).message).toContain(`Contract ${ADDRESS}'s private state stayed in use by another mn (pid ${other.pid}, mn contract call)`);
    expect((err as Error).message).toContain('check the contract\'s state (midnight contract state) before running this again');
  });

  it('stops waiting at once when the call is cancelled', async () => {
    await holdStore();
    const controller = new AbortController();
    const { result, progress } = run(60_000, controller.signal);
    await until(() => progress.some((line) => line.startsWith('Waiting for')));

    const started = Date.now();
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('names no holder for a process that wrote no holder file', async () => {
    const other = await holdStore();
    const { result, notices } = run(60_000);
    await until(() => notices.length > 0);
    await other.release();

    await result;
    expect(notices).toEqual([`Contract ${ADDRESS}'s private state is in use by another process: waiting for it.`]);
  });
});

describe('the holder file', () => {
  it('names the command by its words before the first flag, so no flag value is written', () => {
    expect(holderCommandOf(['/usr/bin/node', '/opt/mn/dist/wallet.js', 'contract', 'call', '--address', ADDRESS, '--secret-key', 'f00d'])).toBe('mn contract call');
    expect(holderCommandOf(['/usr/bin/node', '/usr/local/bin/midnight-wallet-mcp'])).toBe('midnight-wallet-mcp');
  });

  it('is written in the store folder, owner-only, and removed when the run ends', () => {
    const release = claimPrivateStateStore({ fs, join: path.join }, dir, { pid: 4242, command: 'mn contract call' });
    const file = path.join(dir, 'mn-holder-4242.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: 4242, command: 'mn contract call' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    release();
    expect(fs.existsSync(file)).toBe(false);
  });
});
