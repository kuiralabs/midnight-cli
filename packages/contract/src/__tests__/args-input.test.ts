// A deploy's or call's arguments come from --args (public values), from a
// file (--args-file) or from the standard input (--args -), and no refusal
// quotes what they hold.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError } from '@kuiralabs/midnight-cli-core';
import { readGivenArgs } from '../lib/contract/args-input.ts';
import { resolveContractCallRequest } from '../lib/contract/request.ts';

const SECRET = 'bid-31337';
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-args-input-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readGivenArgs', () => {
  it('reads --args-file, relative to the working directory, an object as its values in order', () => {
    writeFileSync(join(dir, 'bid.json'), JSON.stringify({ amount: 5, salt: SECRET }));
    expect(readGivenArgs({ argsFile: 'bid.json' }, dir)).toEqual({ args: [5, SECRET], source: 'file' });
  });

  it('reads --args - from the standard input it is given a reader of', () => {
    expect(readGivenArgs({ args: '-' }, dir, () => `[${JSON.stringify(SECRET)}]`)).toEqual({ args: [SECRET], source: 'stdin' });
  });

  it('reads --args as given, and nothing as no arguments', () => {
    expect(readGivenArgs({ args: '[1,2]' }, dir)).toEqual({ args: [1, 2], source: 'inline' });
    expect(readGivenArgs({}, dir)).toEqual({ args: [], source: 'none' });
  });

  it.each([
    [{ args: '[1]', argsFile: 'x.json' }, undefined, 'Give the arguments once: --args or --args-file, not both.'],
    [{ args: '-' }, undefined, '--args - reads the arguments from the standard input, which this caller has none of'],
    [{ argsFile: 'missing.json' }, undefined, 'Can\'t read --args-file'],
    [{ args: '-' }, () => `{"bid": "${SECRET}"`, 'The arguments in the standard input (--args -) are not valid JSON'],
    [{ args: `"${SECRET}"` }, undefined, 'The arguments in --args are JSON of type string'],
  ])('refuses %j, quoting nothing of the arguments', (flags, readStdin, message) => {
    const run = () => readGivenArgs(flags, dir, readStdin);
    expect(run).toThrow(UsageError);
    expect(run).toThrow(message);
    try { run(); } catch (err) { expect((err as Error).message).not.toContain(SECRET); }
  });

  // `--args-file <(echo …)` names a pipe: a FIFO whose writer may not have written yet.
  it('reads --args-file from a FIFO written after the read starts', async () => {
    const fifo = join(dir, 'args.fifo');
    execFileSync('mkfifo', [fifo]);
    const writer = spawn('bash', ['-c', `sleep 0.3; echo '[1,"${SECRET}"]' > "${fifo}"`], { stdio: 'ignore' });
    try {
      expect(readGivenArgs({ argsFile: fifo }, dir)).toEqual({ args: [1, SECRET], source: 'file' });
    } finally {
      await new Promise((resolve) => writer.once('exit', resolve));
    }
  });

  it('refuses a file that isn\'t JSON without quoting it', () => {
    writeFileSync(join(dir, 'bad.json'), `{"salt": ${SECRET}}`);
    expect(() => readGivenArgs({ argsFile: 'bad.json' }, dir)).toThrow(/^The arguments in --args-file .*bad\.json are not valid JSON/);
    try { readGivenArgs({ argsFile: 'bad.json' }, dir); } catch (err) { expect((err as Error).message).not.toContain(SECRET); }
  });
});

describe('--args - from a real standard input', () => {
  it('reaches a call request through the process\'s own standard input', () => {
    const compiler = join(dir, 'managed', 'counter', 'compiler');
    mkdirSync(compiler, { recursive: true });
    writeFileSync(join(compiler, 'contract-info.json'), JSON.stringify({
      'compiler-version': '0.36.0', 'language-version': '0.28.0', 'runtime-version': '0.21.0',
      circuits: [{ name: 'add', pure: false, proof: true, arguments: [{ name: 'x', type: { 'type-name': 'Uint', maxval: 255 } }, { name: 'y', type: { 'type-name': 'Uint', maxval: 255 } }], 'result-type': { 'type-name': 'Tuple', types: [] } }],
      witnesses: [],
    }));
    const request = fileURLToPath(new URL('../lib/contract/request.ts', import.meta.url));
    const input = fileURLToPath(new URL('../lib/contract/args-input.ts', import.meta.url));
    const program = `
      const { resolveContractCallRequest } = await import(${JSON.stringify(request)});
      const { readProcessStdin } = await import(${JSON.stringify(input)});
      const { parseArgs } = await import('@kuiralabs/midnight-cli-core');
      const r = resolveContractCallRequest(parseArgs(['contract', 'call', '--path', ${JSON.stringify(dir)}, '--address', '${'ab'.repeat(32)}', '--circuit', 'add', '--args', '-']), process.cwd(), readProcessStdin);
      console.log(JSON.stringify({ args: r.callArgs, source: r.argsSource }));
    `;
    const tsx = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
    const run = spawnSync(tsx, ['--conditions=midnight-cli-source', '--input-type=module', '-e', program], { input: '{"x": 3, "y": 4}', encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual({ args: [3, 4], source: 'stdin' });
    // Without a reader (an MCP call's), refused.
    expect(() => resolveContractCallRequest(parseArgs(['contract', 'call', '--path', dir, '--address', 'ab'.repeat(32), '--circuit', 'add', '--args', '-']), dir)).toThrow(UsageError);
  });
});
