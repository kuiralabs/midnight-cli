// Libraries leave the host process alone (spec §3.1). The check finds each
// kind of break in a module planted for it, skips strings and comments, and
// finds nothing in src/ beyond what its allowlist names. The SDK's noise is
// filtered by the shell: a transient Wallet.* rejection reaches the library
// listening for it and the run goes on; any other rejection still exits 1.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
