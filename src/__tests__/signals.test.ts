// Ctrl+C and SIGTERM, through the shell: the running call stops on its signal
// and ends CANCELLED (exit 7), its JSON on stdout, instead of the process
// being cut off by the 5 s fallback. Run as the CLI is: this checkout's entry
// point in its own process, with a temporary home whose indexer never lists
// the transaction asked for, so `tx status --wait` waits until stopped.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLocalIndexer, type LocalIndexer } from '../../test-support/local-indexer.ts';

const entryPoint = resolve(import.meta.dirname, '../wallet.ts');
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const HASH = 'ab'.repeat(32);

let home: string;
let indexer: LocalIndexer;

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-signals-')));
  indexer = await startLocalIndexer(() => JSON.stringify({ data: { transactions: [] } }));
  mkdirSync(join(home, '.midnight'), { recursive: true });
  writeFileSync(join(home, '.midnight', 'config.json'), JSON.stringify({ network: 'undeployed', networks: { undeployed: { 'indexer-ws': indexer.url.replace('http', 'ws') + '/ws' } } }));
});
afterAll(async () => {
  await indexer.close();
  rmSync(home, { recursive: true, force: true });
});

/** Runs `tx status --wait`, sends `signal` once it is waiting, and gives how it ended and how long after the signal. */
function waitThenSignal(signal: NodeJS.Signals): Promise<{ status: number | null; stdout: string; afterSignalMs: number }> {
  const child = spawn(process.execPath, ['--import', tsxLoader, entryPoint, 'tx', 'status', HASH, '--wait', '--timeout', '120', '--json'], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  let sentAt = 0;
  // Signalled once the indexer has been asked: the command is waiting by then.
  const poll = setInterval(() => {
    if (indexer.requests.length > 0 && sentAt === 0) {
      sentAt = Date.now();
      child.kill(signal);
      clearInterval(poll);
    }
  }, 50);
  return new Promise((done) => child.on('close', (status) => {
    clearInterval(poll);
    done({ status, stdout, afterSignalMs: Date.now() - sentAt });
  }));
}

describe('a signal while a call waits', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('%s ends the call CANCELLED, exit 7, with its JSON, at once', async (signal) => {
    indexer.requests.length = 0;
    const run = await waitThenSignal(signal);
    expect(run.status).toBe(7);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'CANCELLED', exitCode: 7 });
    expect(run.afterSignalMs).toBeLessThan(4_000);
  }, 60_000);
});
