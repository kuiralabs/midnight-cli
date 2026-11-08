// Libraries leave the host process alone. The check finds each
// kind of break in a module planted for it, skips strings and comments, and
// finds nothing in src/ beyond what its allowlist names. The guard that
// filters the SDK's noise is core's host-called process code, tested with it
// (packages/cli-core/src/__tests__/sdk-process-guard.test.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { CORE_PROCESS_DIR, findViolations } from '../../scripts/check-process-safety.mjs';

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

  it('finds a command writing to the terminal itself, not through its call, and lets ui/ write', () => {
    // Planted under a folder of their own, read as src/ is.
    for (const sub of ['commands', 'ui']) mkdirSync(join(dir, sub));
    const command = join(dir, 'commands', 'planted.ts');
    writeFileSync(command, [
      "process.stdout.write('result');",
      "ctx.output.stderr('through the call');",
      "console.log('also the terminal');",
      'const v = process.env.HOME;',
    ].join('\n'));
    const spinner = join(dir, 'ui', 'planted.ts');
    writeFileSync(spinner, "process.stderr.write('frame');");
    expect(findViolations([command, spinner], {}, {}, dir).map((v) => `${v.file}:${v.line} ${v.rule}`)).toEqual([
      'commands/planted.ts:1 writes to the terminal',
      'commands/planted.ts:3 writes to the terminal',
    ]);
  });

  it('finds nothing in src/ beyond its allowlist', () => {
    expect(findViolations()).toEqual([]);
  });
});

// Nothing about a call lives in module globals.
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
    expect(found(file, { [rel]: { unlocked: 'shared on purpose', removed: 'no longer kept' } })).toEqual([
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

  it("lets the shell set the exit code and core's host-called process guard keep ambient storage", () => {
    const shell = findViolations([join(ROOT, 'src/wallet.ts'), join(ROOT, 'packages/cli-core/src/process/sdk-process-guard.ts')]);
    expect(shell).toEqual([]);
  });

  it("lets core's process directory touch the process as a host asks it to, and refuses the same code anywhere else", () => {
    const touches = [
      "import { AsyncLocalStorage } from 'node:async_hooks';",
      "process.on('unhandledRejection', () => {});",
      'console.error = () => {};',
      "process.stderr.write('hi');",
      'process.exit(1);',
      'const v = process.env.HOME;',
    ];
    // The same code in a process/ folder of anything but core is a library's.
    mkdirSync(join(dir, 'process'));
    const elsewhere = join(dir, 'process', 'guard.ts');
    writeFileSync(elsewhere, touches.join('\n'));
    expect(findViolations([elsewhere], {}, {}, dir).map((v) => `${v.line} ${v.rule}`)).toEqual([
      '4 writes to the terminal',
      '5 exits',
      '2 installs a process handler',
      '3 patches console or stdout',
      '6 reads the environment',
      '1 keeps ambient per-call storage',
    ]);
    // Core's process code does each of these but read the environment, and passes.
    const guard = join(CORE_PROCESS_DIR, 'sdk-process-guard.ts');
    const source = readFileSync(guard, 'utf8');
    for (const done of [/process\.on\(/, /process\.exit\(/, /console\.error = /, /AsyncLocalStorage/]) expect(source).toMatch(done);
    expect(findViolations([guard, join(CORE_PROCESS_DIR, 'sync-heap.ts')])).toEqual([]);
  });
});

// What a library needs from its host comes in through the host it is passed, never a module-level setter.
describe('the process-safety check finds a library exporting a setter of host state', () => {
  const plant = (rel: string, lines: string[]) => {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, lines.join('\n'));
    return file;
  };
  const setters = (file: string, allowedSetters?: Record<string, Record<string, string>>) =>
    findViolations([file], {}, {}, dir, allowedSetters).filter((v) => v.rule.includes('setter')).map((v) => `${v.line} ${v.rule} ${v.name}`);

  it('by its name, or by an exported function assigning a module-level let, however it is exported', () => {
    const file = plant('lib/sources.ts', [
      "import type { Settings } from './settings.ts';",
      'export function setSettingsSource(next: (() => Settings) | null): void {}',
      'export const setNoticeSink = (sink: (line: string) => void) => {};',
      'export function setPrompter(p: unknown): void {}',
      'export async function setEngineLoader(l: unknown): Promise<void> {}',
      'let root: string | undefined;',
      'export function useRoot(next: string): void {',
      '  root = next;',
      '}',
      'let calls = 0;',
      'function count(): number {',
      '  return ++calls;',
      '}',
      'export { count as countCall };',
    ]);
    expect(setters(file)).toEqual([
      '2 exports a setter of host state setSettingsSource',
      '3 exports a setter of host state setNoticeSink',
      '4 exports a setter of host state setPrompter',
      '5 exports a setter of host state setEngineLoader',
      '7 exports a setter of host state useRoot',
      '11 exports a setter of host state count',
    ]);
  });

  it('not a function that only reads module state, assigns its own local, or stays unexported, nor a setter of state on disk', () => {
    const file = plant('lib/readers.ts', [
      'let loaded: string | undefined;',
      'export function current(): string | undefined {',
      '  return loaded === undefined ? undefined : loaded;',
      '}',
      'export function tally(items: string[]): number {',
      '  let loaded = 0;',
      '  for (const _ of items) loaded += 1;',
      '  return loaded;',
      '}',
      'function remember(next: string): void {',
      '  loaded = next;',
      '}',
      'export const isLoaded = (x: string) => x === loaded;',
      'export function setConfigValue(key: string, value: string, root: string): void {}',
      "const note = 'export function setSettingsSource() {}';",
    ]);
    expect(setters(file)).toEqual([]);
  });

  it('allows a setter only where the allowlist names it, and reports an entry whose setter is gone', () => {
    const allowlist = { 'lib/engine.ts': { claimSdkSet: 'a process guard' } };
    const guard = plant('lib/engine.ts', [
      'let loadedSet: string | undefined;',
      'export function claimSdkSet(set: string): void {',
      '  if (loadedSet !== undefined && loadedSet !== set) throw new Error(set);',
      '  loadedSet = set;',
      '}',
    ]);
    expect(setters(guard, allowlist)).toEqual([]);
    expect(setters(guard, {})).toEqual(['2 exports a setter of host state claimSdkSet']);
    const elsewhere = plant('lib/other.ts', [
      'let loadedSet: string | undefined;',
      'export function claimSdkSet(set: string): void { loadedSet = set; }',
    ]);
    expect(setters(elsewhere, allowlist)).toEqual(['2 exports a setter of host state claimSdkSet']);
    expect(setters(plant('lib/engine.ts', ['export const NONE = 1;']), allowlist)).toEqual(['0 allowlists a setter it no longer exports claimSdkSet']);
  });
});
