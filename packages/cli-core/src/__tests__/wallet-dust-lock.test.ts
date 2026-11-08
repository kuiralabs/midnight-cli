// One payment at a time from a wallet's Dust, across mn processes: another
// process (an mn paying from the same wallet) holds the wallet's Dust lock,
// taken with this same code; this one waits, says once why and for whom, and
// takes it once the other lets go; past its wait it goes ahead without it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { walletDustLock, walletDustLockFile } from '../lib/wallet-dust-lock.ts';

const LOCK_MODULE = pathToFileURL(fileURLToPath(new URL('../lib/wallet-dust-lock.ts', import.meta.url))).href;

let root: string;
let file: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-dust-lock-'));
  file = walletDustLockFile(root, 'undeployed', 'mn_addr_undeployed1example');
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});

/** Another mn process holding the wallet's Dust lock until told to let go (a line on its stdin). */
async function otherMnHolding(): Promise<{ pid: number; release: () => Promise<void> }> {
  const script = path.join(root, 'holder.mts');
  fs.writeFileSync(script, `
    import { walletDustLock } from ${JSON.stringify(LOCK_MODULE)};
    const lock = walletDustLock(${JSON.stringify(file)});
    await lock.hold({ notice: () => {}, progress: () => {} });
    process.stdout.write('held\\n');
    process.stdin.once('data', () => { lock.release(); process.stdout.write('released\\n'); process.exit(0); });
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', script, 'contract', 'call', '--secret-key', 'f00d'], { stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const said = (word: string) => new Promise<void>((resolve) => {
    const listen = (chunk: Buffer) => { if (chunk.toString().includes(word)) { child.stdout!.off('data', listen); resolve(); } };
    child.stdout!.on('data', listen);
  });
  await said('held');
  return { pid: child.pid!, release: async () => { const done = said('released'); child.stdin!.write('go\n'); await done; } };
}

const heard = () => {
  const notices: string[] = [];
  const progress: string[] = [];
  return { notices, progress, say: { notice: (line: string) => notices.push(line), progress: (line: string) => progress.push(line) } };
};

describe('the wallet Dust lock', () => {
  it('waits while another mn holds it, saying once why and for whom, and takes it when it is let go', async () => {
    const other = await otherMnHolding();
    const lock = walletDustLock(file);
    const { notices, progress, say } = heard();

    const taking = lock.hold(say);
    while (progress.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lock.held).toBe(false);
    await other.release();
    await taking;

    expect(lock.held).toBe(true);
    // The other's command names no flag value.
    expect(notices).toEqual([`This wallet's Dust is in use by another mn (pid ${other.pid}, holder contract call), which is paying a fee with it: waiting for it, so the two don't spend the same Dust.`]);
    expect(progress[0]).toMatch(new RegExp(`^Waiting for this wallet's Dust, in use by another mn \\(pid ${other.pid}, holder contract call\\) \\(\\d+ s\\)\\.\\.\\.$`));
    lock.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('goes ahead without it past its wait, saying so, and takes it the next time it is free', async () => {
    const other = await otherMnHolding();
    const lock = walletDustLock(file, { timeoutMs: 1_200 });
    const { notices, say } = heard();

    await lock.hold(say);

    expect(lock.held).toBe(false);
    expect(notices.at(-1)).toBe(`Waited about 2 seconds for this wallet's Dust, in use by another mn (pid ${other.pid}, holder contract call): going ahead. If both spend the same Dust, the node refuses one and mn builds it again.`);
    await other.release();
    await lock.hold(say);
    expect(lock.held).toBe(true);
    lock.release();
  });

  it('is taken once by two balancings of one process', async () => {
    const lock = walletDustLock(file);
    const { notices, say } = heard();
    await Promise.all([lock.hold(say), lock.hold(say)]);
    expect(lock.held).toBe(true);
    expect(notices).toEqual([]);
    lock.release();
  });
});
