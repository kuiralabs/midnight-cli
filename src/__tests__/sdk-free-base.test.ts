// The base and the network I/O helpers (the files the layering check places
// in core and chain) load with no Midnight SDK: each is imported in a node
// whose module hook refuses every Midnight and kuiralabs package. And the
// built `mn` loads none for --version, help or config, which run before any
// command needs one.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SDK = String.raw`^(@midnight(?:-ntwrk|ntwrk)\/[^/]+|@kuiralabs\/[^/]+)`;

/** A module hook file: `refuse` makes an SDK import fail, otherwise each one is logged to `log`. */
function sdkHook(dir: string, mode: 'refuse' | 'record'): string {
  const log = join(dir, 'sdk.log');
  const hooks = join(dir, `hooks-${mode}.mjs`);
  writeFileSync(hooks, [
    "import { appendFileSync } from 'node:fs';",
    'export async function resolve(specifier, context, next) {',
    `  const m = specifier.match(new RegExp(${JSON.stringify(SDK)}));`,
    mode === 'refuse'
      ? "  if (m) throw new Error('refused SDK import: ' + specifier);"
      : `  if (m) appendFileSync(${JSON.stringify(log)}, m[1] + '\\n');`,
    '  return next(specifier, context);',
    '}',
  ].join('\n'));
  const register = join(dir, `register-${mode}.mjs`);
  writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
  return register;
}

describe('the SDK-free base', () => {
  it('loads every core and chain module with every Midnight SDK import refused', async () => {
    const { sourceFiles, homeOf } = await import('../../scripts/check-layering.mjs');
    const base = sourceFiles().filter((file) => ['core', 'chain'].includes(homeOf(file) ?? ''));
    expect(base.length).toBeGreaterThan(30);

    const dir = mkdtempSync(join(tmpdir(), 'mn-sdk-free-'));
    try {
      const script = join(dir, 'load-all.mjs');
      writeFileSync(script, [
        `const files = ${JSON.stringify(base)};`,
        'const failed = [];',
        "for (const f of files) { try { await import(f); } catch (e) { failed.push(f + ': ' + String(e?.message ?? e).split('\\n')[0]); } }",
        'console.log(JSON.stringify(failed));',
      ].join('\n'));
      const run = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(sdkHook(dir, 'refuse')).href, script], {
        cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, HOME: dir },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('the built mn', () => {
  const bin = join(ROOT, 'dist', 'wallet.js');

  it.skipIf(!existsSync(bin))('loads no Midnight SDK for --version, help or config get', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sdk-loads-'));
    try {
      const register = sdkHook(dir, 'record');
      for (const args of [['--version'], ['help'], ['config', 'get', 'network']]) {
        rmSync(join(dir, 'sdk.log'), { force: true });
        const run = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, bin, ...args], {
          cwd: dir, encoding: 'utf8', timeout: 60_000, input: '', env: { ...process.env, HOME: dir, NO_COLOR: '1' },
        });
        expect(run.status, `${args.join(' ')}: ${run.stderr}`).toBe(0);
        expect(existsSync(join(dir, 'sdk.log')) ? `${args.join(' ')} loaded the SDK` : 'none', args.join(' ')).toBe('none');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
