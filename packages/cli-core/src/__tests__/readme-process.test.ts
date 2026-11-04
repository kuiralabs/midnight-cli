// The README's "Your process" setup runs as it is written: its code block, in
// a child process of its own, with only the engine standing in. The stand-in
// is the real beta engine whose openConnector, instead of syncing a wallet,
// lets a transient Wallet.Sync rejection escape (as the SDK does mid-sync) and
// hands back a connector answering the balance reads. The program must survive
// the rejection, see it as its session's warning, print the balances, stop the
// wallet on close, and end by itself.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const README = resolve(import.meta.dirname, '..', '..', 'README.md');
const BETA_ENGINE = join(ROOT, 'packages', 'engine-beta', 'src', 'index.ts');
const ENGINE_SPECIFIER = '@kuiralabs/midnight-engine-beta';
const NIGHT = '00'.repeat(32);

/** The README's setup block: the first js block under "### The setup". */
function setupBlock(): string {
  const readme = readFileSync(README, 'utf8');
  const section = readme.slice(readme.indexOf('### The setup'));
  const block = /```js\n([\s\S]*?)```/.exec(section);
  if (block === null) throw new Error('README.md has no js block under "### The setup"');
  return block[1]!;
}

/** The beta engine, its openConnector standing in for a wallet sync. */
const STAND_IN_ENGINE = `
import { createBetaEngine as createRealEngine } from ${JSON.stringify(BETA_ENGINE)};
export function createBetaEngine(host) {
  const engine = createRealEngine(host);
  return { ...engine, wallet: { ...engine.wallet, async openConnector(options) {
    // The SDK's transient failure, escaping as an unhandled rejection while it syncs.
    Promise.reject(Object.assign(new Error('Internal Server Error'), { _tag: 'Wallet.Sync' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const answers = { getUnshieldedBalances: { '${NIGHT}': 5n }, getShieldedBalances: {}, getDustBalance: { balance: 1n } };
    const handlers = Object.fromEntries(Object.entries(answers).map(([method, answer]) => [method, async () => answer]));
    options.onMessage('stand-in wallet opened for ' + options.network);
    return { connector: { handlers, revertPendingTxs: async () => {}, dispose: () => {} }, stop: async () => { console.error('stand-in wallet stopped'); } };
  } } };
}
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mn-readme-process-'));
  // The program resolves the packages as one installed beside it would.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runSetup(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const block = setupBlock();
  if (!block.includes(`'${ENGINE_SPECIFIER}'`)) throw new Error(`the setup block no longer imports ${ENGINE_SPECIFIER}`);
  writeFileSync(join(dir, 'stand-in-engine.mjs'), STAND_IN_ENGINE);
  writeFileSync(join(dir, 'program.mjs'), block.replace(`'${ENGINE_SPECIFIER}'`, "'./stand-in-engine.mjs'"));
  return new Promise((done) => {
    // HOME is the test's folder: the program's state root (~/.my-app) is under it, never the real one.
    const child = spawn(process.execPath, ['--import', 'tsx', 'program.mjs'], {
      cwd: dir,
      env: { ...process.env, HOME: dir, WALLET_SEED: '07'.repeat(32) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const hung = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => {
      clearTimeout(hung);
      done({ code, stdout, stderr });
    });
  });
}

describe("the README's process setup", () => {
  it('opens the wallet, survives the SDK rejection as its warning, prints the balances, closes, and ends by itself', async () => {
    const { code, stdout, stderr } = await runSetup();
    expect(code, stderr).toBe(0);
    expect(stdout).toContain(`'${NIGHT}': 5n`);
    expect(stdout).toContain('dust: 1n');
    expect(stderr).toContain('stand-in wallet opened for stagenet');
    expect(stderr).toContain('SDK: Internal Server Error');
    expect(stderr).not.toContain('Unhandled rejection');
    expect(stderr).toContain('stand-in wallet stopped');
  });

  it('is about 15 lines of setup: the block stays short', () => {
    const lines = setupBlock().split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeLessThanOrEqual(20);
  });
});
