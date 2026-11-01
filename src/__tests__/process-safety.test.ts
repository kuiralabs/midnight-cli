// Libraries leave the host process alone (spec §3.1). The check finds each
// kind of break in a module planted for it, skips strings and comments, and
// finds nothing in src/ beyond what its allowlist names. The SDK's noise is
// filtered by the shell: a transient Wallet.* rejection reaches the library
// listening for it and the run goes on; any other rejection still exits 1.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { findViolations } from '../../scripts/check-process-safety.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-process-safety-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the process-safety check', () => {
  it('finds every kind of break in a library module', () => {
    const planted = join(dir, 'planted.ts');
    writeFileSync(planted, [
      "import * as readline from 'node:readline';",
      "process.stderr.write('hi');",
      'process.exit(1);',
      "process.on('unhandledRejection', () => {});",
      'console.error = () => {};',
      "process.chdir('/');",
      'const v = process.env.HOME;',
      "const root = join(homedir(), '.midnight');",
    ].join('\n'));
    expect(findViolations([planted], {}).map((v) => `${v.line} ${v.rule}`)).toEqual([
      '2 writes to the terminal',
      '3 exits',
      '4 installs a process handler',
      '5 patches console or stdout',
      '6 changes directory',
      '1 opens a prompt',
      '7 reads the environment',
      '8 computes a path from the home directory',
    ]);
  });

  it("still sees code inside a template's ${…} and after a regex holding a quote, and a child handed the terminal", () => {
    const hidden = join(dir, 'hidden.ts');
    writeFileSync(hidden, [
      'const a = `home: ${process.env.HOME}`;',
      "const r = /'/;",
      'process.exit(1);',
      'console.log(a, r);',
      "spawn('x', [], { stdio: 'inherit' });",
      'process.stdin.setRawMode(true);',
    ].join('\n'));
    expect(findViolations([hidden], {}).map((v) => `${v.line} ${v.rule}`)).toEqual([
      '4 writes to the terminal',
      '3 exits',
      '1 reads the environment',
      '6 reads the terminal',
      '5 hands a child the terminal',
    ]);
  });

  it('skips strings, template literals and comments', () => {
    const quiet = join(dir, 'quiet.ts');
    writeFileSync(quiet, [
      '// process.exit(1) in a comment',
      "const script = `process.stderr.write('generated'); process.exit(0);`;",
      "const text = 'process.env.HOME';",
    ].join('\n'));
    expect(findViolations([quiet], {})).toEqual([]);
  });

  it('finds nothing in src/ beyond its allowlist', () => {
    expect(findViolations()).toEqual([]);
  });
});

// Nothing about a call lives in module globals (spec §4.4, D21, 2F).
describe("the process-safety check keeps calls' state out of modules", () => {
  const plant = (name: string, lines: string[]) => {
    const file = join(dir, name);
    writeFileSync(file, lines.join('\n'));
    return file;
  };
  const found = (file: string, allowedState: Record<string, Record<string, string>> = {}) =>
    findViolations([file], {}, allowedState).map((v) => `${v.line} ${v.rule}${v.name === undefined ? '' : ` ${v.name}`}`);

  it('finds module-level mutable state: a let or var, a Map, Set or array not typed readonly, an empty object to fill', () => {
    const file = plant('state.ts', [
      'let target: ((json: string) => void) | null = null;',
      'export var count = 0;',
      'const memo = new Map<string, number>();',
      'const seen = new Set<string>();',
      'const listeners: Array<() => void> = [];',
      'const frames = [',
      "  'a',",
      '];',
      'const cache: Record<string, string> = {};',
    ]);
    expect(found(file)).toEqual([
      '1 keeps module state target',
      '2 keeps module state count',
      '3 keeps module state memo',
      '4 keeps module state seen',
      '5 keeps module state listeners',
      '6 keeps module state frames',
      '9 keeps module state cache',
    ]);
  });

  it("doesn't count constants typed readonly, a table of constants, or state inside a function or a string", () => {
    const file = plant('constants.ts', [
      "const KEYS: ReadonlySet<string> = new Set(['node', 'indexer-ws']);",
      'const BY_NAME: ReadonlyMap<string, number> = new Map([',
      "  ['a', 1],",
      ']);',
      "const NAMES: readonly string[] = ['a', 'b'];",
      "const STEPS = ['up', 'down'] as const;",
      "const MORE: ReadonlyArray<string> = ['c'];",
      "const TABLE = { node: 'Node RPC URL' };",
      'const handler = (x: number) => x + 1;',
      'export function run(): number {',
      '  let calls = 0;',
      '  const memo = new Map<string, number>();',
      '  memo.set("a", calls += 1);',
      '  return memo.size;',
      '}',
      "const script = `let generated = 0;`;",
      '// let commented = 1;',
    ]);
    expect(found(file)).toEqual([]);
  });

  it('allows module state only by name, and reports an allowlist entry whose state is gone', () => {
    const file = plant('shared.ts', [
      'const unlocked = new Map<string, string>();',
      'let other = 0;',
    ]);
    const rel = relative(resolve(ROOT, 'src'), file);
    expect(found(file, { [rel]: { unlocked: 'shared on purpose', removed: 'removed by S9 (2F)' } })).toEqual([
      '2 keeps module state other',
      '0 allowlists module state it no longer keeps removed',
    ]);
  });

  it('finds the process exit code set outside the shell, and not a read of it or a returned one', () => {
    const trips = plant('sets-exit.ts', [
      'process.exitCode = 1;',
      'process.exitCode ??= 2;',
    ]);
    expect(found(trips)).toEqual(['1 sets the process exit code', '2 sets the process exit code']);
    const quiet = plant('returns-exit.ts', [
      'if (process.exitCode === 1) console.log;',
      'export const outcome = { exitCode: 2 };',
      "const text = 'process.exitCode = 1';",
    ]);
    expect(found(quiet).filter((v) => v.includes('exit code'))).toEqual([]);
  });

  it('finds ambient per-call storage outside the shell\'s noise filter, and not a mention in a comment or string', () => {
    const trips = plant('ambient.ts', [
      "import { AsyncLocalStorage } from 'node:async_hooks';",
      'const store = new AsyncLocalStorage<string>();',
      "import { createHook } from 'async_hooks';",
    ]);
    expect(found(trips)).toEqual([
      '1 keeps ambient per-call storage',
      '2 keeps ambient per-call storage',
      '3 keeps ambient per-call storage',
    ]);
    const quiet = plant('explicit.ts', [
      '// no AsyncLocalStorage here: the context is passed in',
      "const why = 'not AsyncLocalStorage';",
    ]);
    expect(found(quiet)).toEqual([]);
  });

  it('lets the shell set the exit code and its noise filter keep ambient storage', () => {
    const shell = findViolations([join(ROOT, 'src/wallet.ts'), join(ROOT, 'src/lib/sdk-noise.ts')]);
    expect(shell).toEqual([]);
  });
});

describe('the shell filters the SDK noise', () => {
  const run = (body: string) => {
    const script = join(dir, 'noise.mjs');
    writeFileSync(script, [
      `const { installSdkNoiseFilters } = await import(${JSON.stringify(join(ROOT, 'src/lib/sdk-noise.ts'))});`,
      `const { onSdkWarning } = await import(${JSON.stringify(join(ROOT, 'src/lib/sdk-warnings.ts'))});`,
      'installSdkNoiseFilters();',
      body,
    ].join('\n'));
    return spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  };

  it('hands a transient Wallet.* rejection to the listening library and goes on', () => {
    const result = run([
      "onSdkWarning((tag, message) => console.log('warned', tag, message));",
      "Promise.reject(Object.assign(new Error('Internal Server Error'), { _tag: 'Wallet.Sync' }));",
      "console.warn('RPC-CORE: submitAndWatchExtrinsic: Custom error: 138');",
      "setTimeout(() => console.log('still running'), 50);",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('warned Wallet.Sync Internal Server Error\nstill running\n');
    expect(result.stderr).not.toContain('RPC-CORE');
  });

  it("hands the SDK's Wallet.* console.error traces, object or string, to the listener, and prints anything else", () => {
    const result = run([
      "onSdkWarning((tag, message) => console.log('warned', tag, message));",
      "console.error({ _tag: 'Wallet.Sync', message: 'Internal Server Error' });",
      "console.error('Wallet.Sync: Internal Server Error\\n    at somewhere');",
      "console.error('a real problem');",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('warned Wallet.Sync Internal Server Error\nwarned Wallet.Sync transient error\n');
    expect(result.stderr).toBe('a real problem\n');
  });

  it('touches nothing while no call listens: SDK traces and RPC noise print as they would without the filters', () => {
    const result = run([
      "console.error({ _tag: 'Wallet.Sync', message: 'Internal Server Error' });",
      "console.warn('RPC-CORE: submitAndWatchExtrinsic: Custom error: 138');",
      "const stop = onSdkWarning(undefined);",
      "console.warn('RPC-CORE: kept off while listening');",
      "stop();",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Wallet.Sync');
    expect(result.stderr).toContain('RPC-CORE: submitAndWatchExtrinsic');
    expect(result.stderr).not.toContain('kept off while listening');
  });

  it('exits 1 on a Wallet.* rejection while no call listens, as before the filters', () => {
    const result = run("Promise.reject(Object.assign(new Error('Internal Server Error'), { _tag: 'Wallet.Sync' }));\nsetTimeout(() => console.log('still running'), 500);");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('still exits 1 on a rejection that is only a string, even one starting Wallet.', () => {
    const result = run("onSdkWarning(() => console.log('warned'));\nPromise.reject('Wallet.Sync: not an SDK error object');\nsetTimeout(() => console.log('still running'), 500);");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('still exits 1 on any other unhandled rejection', () => {
    const result = run("Promise.reject(new Error('a real failure'));\nsetTimeout(() => console.log('still running'), 500);");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a real failure');
    expect(result.stdout).not.toContain('still running');
  });
});
