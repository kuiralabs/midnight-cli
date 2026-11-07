// A reader that closes early (`mn manual | head -1`): mn finishes quietly with
// its own exit code instead of crashing on EPIPE. Run as the CLI is: this
// checkout's entry point in its own process, its stdout's reader closed at once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isClosedReaderError } from '../lib/closed-reader.ts';

const entryPoint = resolve(import.meta.dirname, '../wallet.ts');
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let home: string;

beforeAll(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-closed-reader-'))); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** Runs mn with its stdout's reader gone before it writes: its exit code and stderr. */
function mnIntoClosedReader(...args: string[]): Promise<{ status: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['--import', tsxLoader, entryPoint, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((done) => child.on('close', (status) => done({ status, stderr })));
}

describe('a reader that closes early', () => {
  it('ends mn quietly with exit 0, not an EPIPE crash', async () => {
    const run = await mnIntoClosedReader('manual', '--no-pager');
    expect(run.stderr).not.toContain('EPIPE');
    expect(run.status).toBe(0);
  }, 30_000);

  it('keeps the command\'s own exit code', async () => {
    const run = await mnIntoClosedReader('help', 'nope', '--json');
    expect(run.stderr).not.toContain('EPIPE');
    expect(run.status).toBe(2);
  }, 30_000);
});

describe('isClosedReaderError', () => {
  it('knows the closed pipe and the destroyed stream, and nothing else', () => {
    expect(isClosedReaderError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    expect(isClosedReaderError(Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
    expect(isClosedReaderError(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe(false);
    expect(isClosedReaderError(new Error('plain'))).toBe(false);
  });
});
