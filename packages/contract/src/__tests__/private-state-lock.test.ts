// One contract call at a time on a contract's private-state store. Real
// processes and midnight-js's real level provider: generated scripts, run as
// mn runs them, read and write the store; another process holds the call lock
// (an mn running a call) or the LevelDB folder itself (an mn that takes no
// call lock, mid read or write).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CancelledError, sleep } from '@kuiralabs/midnight-cli-core';
import {
  CALL_LOCK_FILE, CONTRACT_STATE_BUSY, ContractStateBusyError, acquireContractCallLock, holderCommandOf, processIsAlive, type CallLockOptions,
} from '../lib/contract/private-state-lock.ts';
import { SCRIPT_PARTS, executeScript } from '../lib/contract/runner.ts';

const ADDRESS = 'ab'.repeat(32);
const WHAT = `Contract ${ADDRESS}'s private state`;
const require = createRequire(import.meta.url);
/** midnight-js's level provider, and the LevelDB binding it opens folders with, as the scripts load them. */
const PROVIDER = require.resolve('@midnight-ntwrk/midnight-js-level-private-state-provider');
const LEVEL = createRequire(PROVIDER).resolve('level');
const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };
const LOCK_DEPS = { fs, join: path.join, isAlive: processIsAlive, now: () => Date.now(), sleep };
const CALL = 'mn contract call';

let work: string;
let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-private-state-lock-'));
  dir = path.join(work, 'store');
  fs.mkdirSync(dir, { mode: 0o700 });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  fs.rmSync(work, { recursive: true, force: true });
});

/** A process that runs until killed: another mn, as far as its pid goes. */
async function liveProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise((resolve) => child.once('spawn', resolve));
  return child;
}

/** The pid of a process that has ended. */
async function endedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

/** Another process holding the store's LevelDB folder open until told to let go; resolves once it holds it. */
async function holdFolder(): Promise<{ release: () => Promise<void> }> {
  const code = `
    const { Level } = await import(${JSON.stringify(pathToFileURL(LEVEL).href)});
    const db = new Level(${JSON.stringify(dir)});
    await db.open();
    process.stdout.write('held\\n');
    process.stdin.once('data', async () => { await db.close(); process.stdout.write('released\\n'); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const said = (word: string) => new Promise<void>((resolve) => {
    const listen = (chunk: Buffer) => { if (chunk.toString().includes(word)) { child.stdout!.off('data', listen); resolve(); } };
    child.stdout!.on('data', listen);
  });
  await said('held');
  return { release: async () => { const done = said('released'); child.stdin!.write('go\n'); await done; } };
}

/**
 * A script that reads the contract's private state, takes `pauseMs` (as a call
 * takes to prove and submit), and writes it back incremented, through the
 * waiting provider the deploy and call scripts use.
 */
const incrementScript = (pauseMs: number, timeoutMs: number) => `${SCRIPT_PARTS.prelude}
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
  text: privateStateBusyText,
  notice: (line) => process.stderr.write('\\n${SCRIPT_PARTS.noticeMarker} ' + JSON.stringify(line) + '\\n'),
  progress: (line) => process.stderr.write(line + '\\n'),
}, { dir: ${JSON.stringify(dir)}, what: ${JSON.stringify(SCRIPT_PARTS.privateStateName(ADDRESS))}, ownPid: process.ppid, timeoutMs: ${timeoutMs} });
const states = provider.forContract(${JSON.stringify(ADDRESS)});
const before = (await states.get('counterPrivateState'))?.count ?? 0;
await new Promise((resolve) => setTimeout(resolve, ${pauseMs}));
await states.set('counterPrivateState', { count: before + 1 });
console.log(JSON.stringify({ count: before + 1 }));
process.exit(0);
`;

/** The counter as the store holds it, read with the real provider. */
async function storedCount(): Promise<number | undefined> {
  const { levelPrivateStateProvider } = await import(pathToFileURL(PROVIDER).href) as { levelPrivateStateProvider: (config: Record<string, unknown>) => { forContract(address: string): { get(id: string): Promise<{ count: number } | null> } } };
  const states = levelPrivateStateProvider({ midnightDbName: dir, privateStateStoreName: 'counterPrivateState', privateStoragePasswordProvider: () => 'A-wallet-password-0f-length', accountId: 'the-wallet' }).forContract(ADDRESS);
  return (await states.get('counterPrivateState'))?.count;
}

/** What a call says while it waits: its notices and progress lines. */
const said = () => {
  const notices: string[] = [];
  const progress: string[] = [];
  // A read of the script's stderr can carry several lines.
  return { notices, progress, onNotice: (line: string) => notices.push(line), onMessage: (lines: string) => progress.push(...lines.split('\n')) };
};

/** A contract call as runCall makes it: the call lock for the script's whole run, then the script. */
async function call(pauseMs: number, heard = said(), options: Partial<CallLockOptions> = {}) {
  const release = await acquireContractCallLock(LOCK_DEPS, dir, { pid: process.pid, command: CALL }, {
    address: ADDRESS, timeoutMs: 60_000, notice: heard.onNotice, progress: heard.onMessage, ...options,
  });
  try {
    return await executeScript({ dir: work, script: incrementScript(pauseMs, 60_000), overlaySdk: false, packages: NO_PACKAGES, onNotice: heard.onNotice, onMessage: heard.onMessage });
  } finally {
    release();
  }
}

/** The script alone, as an mn that takes no call lock runs it. */
const unlockedCall = (pauseMs: number, heard = said(), timeoutMs = 60_000, signal?: AbortSignal) =>
  executeScript({ dir: work, script: incrementScript(pauseMs, timeoutMs), overlaySdk: false, packages: NO_PACKAGES, onNotice: heard.onNotice, onMessage: heard.onMessage, signal });

describe('two calls of one contract at once', () => {
  it('keep both updates: the second reads the state only once the first has written it', async () => {
    const second = said();
    const results = await Promise.all([call(700), (async () => { await sleep(100); return call(700, second); })()]);

    expect(results.map((result) => JSON.parse(result).count).sort()).toEqual([1, 2]);
    expect(await storedCount()).toBe(2);
    expect(second.notices).toEqual([`${WHAT} is in use by another mn (pid ${process.pid}, ${CALL}): waiting for it.`]);
    expect(second.progress.some((line) => line.startsWith(`Waiting for contract ${ADDRESS}'s private state, in use by another mn (pid ${process.pid}, ${CALL}) (`))).toBe(true);
    expect(fs.existsSync(path.join(dir, CALL_LOCK_FILE))).toBe(false);
  });

  it('lose one update without the call lock, which is why a call holds it', async () => {
    await Promise.all([unlockedCall(700), (async () => { await sleep(100); return unlockedCall(700); })()]);

    expect(await storedCount()).toBe(1);
  });
});

describe('the call lock', () => {
  it('is taken over at once from an mn that ended without letting it go', async () => {
    // A lock left by a crashed mn: taken for a pid that has ended, never let go.
    const crashed = await endedPid();
    await acquireContractCallLock(LOCK_DEPS, dir, { pid: crashed, command: CALL }, { address: ADDRESS, timeoutMs: 60_000, notice: () => {}, progress: () => {} });
    expect(JSON.parse(fs.readFileSync(path.join(dir, CALL_LOCK_FILE), 'utf8'))).toMatchObject({ pid: crashed, command: CALL });
    const heard = said();

    const started = Date.now();
    const release = await acquireContractCallLock(LOCK_DEPS, dir, { pid: process.pid, command: CALL }, { address: ADDRESS, timeoutMs: 60_000, notice: heard.onNotice, progress: heard.onMessage });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(heard.notices).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, CALL_LOCK_FILE), 'utf8'))).toMatchObject({ pid: process.pid });
    release();
    expect(fs.existsSync(path.join(dir, CALL_LOCK_FILE))).toBe(false);
  });

  it('fails as CONTRACT_STATE_BUSY when a live mn keeps it past the wait, naming it and its holder', async () => {
    const other = await liveProcess();
    await acquireContractCallLock(LOCK_DEPS, dir, { pid: other.pid!, command: CALL }, { address: ADDRESS, timeoutMs: 60_000, notice: () => {}, progress: () => {} });

    const err = await call(0, said(), { timeoutMs: 1_500 }).then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(ContractStateBusyError);
    expect(err).toMatchObject({ code: CONTRACT_STATE_BUSY });
    expect((err as Error).message).toMatch(new RegExp(`^Contract ${ADDRESS}'s private state stayed in use by another mn \\(pid ${other.pid}, ${CALL}\\) for 2 s`));
    expect((err as Error).message).toContain("check the contract's state (midnight contract state) before running this again");
  });

  it('stops waiting at once when the call is cancelled', async () => {
    const other = await liveProcess();
    await acquireContractCallLock(LOCK_DEPS, dir, { pid: other.pid!, command: CALL }, { address: ADDRESS, timeoutMs: 60_000, notice: () => {}, progress: () => {} });
    const controller = new AbortController();
    const heard = said();
    const waiting = call(0, heard, { signal: controller.signal });
    waiting.catch(() => {});
    await until(() => heard.notices.length > 0);

    const started = Date.now();
    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('names the command by its words before the first flag, so no flag value is written', () => {
    expect(holderCommandOf(['/usr/bin/node', '/opt/mn/dist/wallet.js', 'contract', 'call', '--address', ADDRESS, '--secret-key', 'f00d'])).toBe(CALL);
    expect(holderCommandOf(['/usr/bin/node', '/usr/local/bin/midnight-wallet-mcp'])).toBe('midnight-wallet-mcp');
  });
});

describe('a store whose folder an mn that takes no call lock holds', () => {
  it('waits for the folder, says so once, and writes once it is free', async () => {
    const other = await holdFolder();
    const heard = said();
    const running = unlockedCall(0, heard);
    await until(() => heard.progress.filter((line) => line.startsWith('Waiting for')).length >= 2);
    await other.release();

    expect(JSON.parse(await running)).toEqual({ count: 1 });
    expect(heard.notices).toEqual([`${WHAT} is in use by another process: waiting for it.`]);
  });

  it('fails as CONTRACT_STATE_BUSY when the folder stays held past the wait', async () => {
    await holdFolder();

    const err = await unlockedCall(0, said(), 1_500).then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(ContractStateBusyError);
    expect((err as Error).message).toContain(`${WHAT} stayed in use by another process`);
  });

  it('stops waiting at once when the call is cancelled', async () => {
    await holdFolder();
    const controller = new AbortController();
    const heard = said();
    const running = unlockedCall(0, heard, 60_000, controller.signal);
    running.catch(() => {});
    await until(() => heard.notices.length > 0);

    const started = Date.now();
    controller.abort();

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await sleep(50);
  }
}
