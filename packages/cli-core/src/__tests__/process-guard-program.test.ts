// The SDK process guard as a program meets it: its defaults, in a child
// process that imports "./process" by its package name, on Node and, when it
// is installed, on bun. A floating Wallet.Sync rejection (the SDK's transient
// failure, retried by the SDK) kills a program without the guard and not one
// with it, which reports it instead; a real error still exits 1; importing
// "./process" installs nothing; uninstall gives the process back.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** The SDK's transient failure, escaping as an unhandled rejection, then work that shows whether the program went on. */
const FLOATING_SYNC_REJECTION = [
  "Promise.reject(Object.assign(new Error('Internal Server Error'), { _tag: 'Wallet.Sync' }));",
  "setTimeout(() => console.log('still running'), 200);",
].join('\n');

interface Runtime {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

const NODE: Runtime = { name: 'Node', command: process.execPath, args: ['--import', 'tsx'] };
// bun runs the workspace's TypeScript sources itself, through the same export condition.
const BUN: Runtime = { name: 'bun', command: 'bun', args: ['--conditions=midnight-cli-source'] };
const bunInstalled = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mn-guard-program-'));
  // The program resolves the packages as one installed beside it would.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runProgram(runtime: Runtime, body: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  writeFileSync(join(dir, 'program.mjs'), body);
  return new Promise((done) => {
    const child = spawn(runtime.command, [...runtime.args, 'program.mjs'], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** "./process" by its package name, as a program outside the repository imports it (the test itself imports nothing of it). */
const PROCESS_ENTRY = '@kuiralabs/midnight-cli-core/process';
const importGuard = `import { installSdkProcessGuard } from ${JSON.stringify(PROCESS_ENTRY)};`;

describe.each([NODE, ...(bunInstalled ? [BUN] : [])])('the SDK process guard in a program, on $name', (runtime) => {
  it('without it, a floating Wallet.Sync rejection kills the program: exit 1', async () => {
    const { code, stdout } = await runProgram(runtime, FLOATING_SYNC_REJECTION);
    expect(code).toBe(1);
    expect(stdout).not.toContain('still running');
  });

  it('with it, the program goes on and the rejection is reported: exit 0, a line on console.warn by default', async () => {
    const { code, stdout, stderr } = await runProgram(runtime, [importGuard, 'installSdkProcessGuard();', FLOATING_SYNC_REJECTION].join('\n'));
    expect(code, stderr).toBe(0);
    expect(stdout).toBe('still running\n');
    expect(stderr).toBe('Wallet.Sync: Internal Server Error (a transient wallet SDK error; the SDK retries)\n');
  });

  it("with it, the rejection goes to the program's onWarning when it gives one", async () => {
    const { code, stdout, stderr } = await runProgram(runtime, [
      importGuard,
      "installSdkProcessGuard({ onWarning: (tag, message) => console.log('reported', tag, message) });",
      FLOATING_SYNC_REJECTION,
    ].join('\n'));
    expect(code, stderr).toBe(0);
    expect(stdout).toBe('reported Wallet.Sync Internal Server Error\nstill running\n');
    expect(stderr).toBe('');
  });

  it('with it, a real error still exits 1', async () => {
    const { code, stdout, stderr } = await runProgram(runtime, [
      importGuard,
      'installSdkProcessGuard();',
      "Promise.reject(new Error('a real failure'));",
      "setTimeout(() => console.log('still running'), 200);",
    ].join('\n'));
    expect(code).toBe(1);
    expect(stderr).toContain('a real failure');
    expect(stdout).not.toContain('still running');
  });

  it('importing "./process" installs nothing: no handler, the console untouched, and the rejection still kills', async () => {
    const { code, stdout } = await runProgram(runtime, [
      'const before = { handlers: process.listenerCount("unhandledRejection"), error: console.error, warn: console.warn };',
      `await import(${JSON.stringify(PROCESS_ENTRY)});`,
      'console.log(JSON.stringify({ handlers: process.listenerCount("unhandledRejection") - before.handlers, error: console.error === before.error, warn: console.warn === before.warn }));',
      FLOATING_SYNC_REJECTION,
    ].join('\n'));
    expect(code).toBe(1);
    expect(stdout).toBe('{"handlers":0,"error":true,"warn":true}\n');
  });

  it('uninstall gives the process back: its handler gone, the console restored, and the rejection kills again', async () => {
    const { code, stdout } = await runProgram(runtime, [
      importGuard,
      'const before = { handlers: process.listenerCount("unhandledRejection"), error: console.error, warn: console.warn };',
      'const guard = installSdkProcessGuard({ console: true });',
      'const installed = { handlers: process.listenerCount("unhandledRejection") - before.handlers, error: console.error === before.error, warn: console.warn === before.warn };',
      'guard.uninstall();',
      'const uninstalled = { handlers: process.listenerCount("unhandledRejection") - before.handlers, error: console.error === before.error, warn: console.warn === before.warn };',
      'console.log(JSON.stringify({ installed, uninstalled }));',
      FLOATING_SYNC_REJECTION,
    ].join('\n'));
    expect(code).toBe(1);
    expect(JSON.parse(stdout.trim())).toEqual({
      installed: { handlers: 1, error: false, warn: false },
      uninstalled: { handlers: 0, error: true, warn: true },
    });
  });
});
