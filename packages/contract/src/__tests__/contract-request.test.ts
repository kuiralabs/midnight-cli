// A deploy or call is read from its arguments and the compiled contract on
// disk (contract-info.json, witnesses.js), with no wallet and no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contractCallRequest, contractDeployRequest, resolveContractCallRequest, resolveContractDeployRequest, resolveScanDir } from '../lib/contract/request.ts';
import { parseArgs, UsageError } from '@kuiralabs/midnight-cli-core';
import { inlineSecretKeyWarning } from '../lib/contract/secret-key-input.ts';
import { spawn, execFileSync } from 'node:child_process';

const UINT = { 'type-name': 'Uint', maxval: 255 };
const ADDRESS = 'cb5230e1ac98e07520d3b330016743a05fec38dd8fe894ae5b9ac3f71cac5190';
let dir: string;

/** A compiled contract as compactc lays it out: managed/<name>/compiler/contract-info.json. */
function compiledContract(name: string, witnesses: { name: string }[] = []): void {
  const compiler = join(dir, 'managed', name, 'compiler');
  mkdirSync(compiler, { recursive: true });
  writeFileSync(join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.36.0', 'language-version': '0.28.0', 'runtime-version': '0.21.0',
    circuits: [
      { name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } },
      { name: 'add', pure: false, proof: true, arguments: [{ name: 'x', type: UINT }, { name: 'y', type: UINT }], 'result-type': UINT },
    ],
    witnesses: witnesses.map((w) => ({ ...w, arguments: [], 'result type': UINT })),
  }));
}

// The working directory the readers are given is not the dApp: --path names it.
const call = (...flags: string[]) => resolveContractCallRequest(parseArgs(['contract', 'call', '--path', dir, ...flags]), tmpdir());
const deploy = (...flags: string[]) => resolveContractDeployRequest(parseArgs(['contract', 'deploy', '--path', dir, ...flags]), tmpdir());

beforeEach(() => {
  dir = join(tmpdir(), `mn-contract-request-${process.pid}-${Date.now()}`);
  compiledContract('counter');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveContractCallRequest', () => {
  it('reads the address, circuit and arguments; an object\'s values are the arguments in order', () => {
    expect(call('--address', ADDRESS, '--circuit', 'add', '--args', '{"x":1,"y":2}'))
      .toMatchObject({ dappDir: dir, address: ADDRESS, circuit: 'add', callArgs: [1, 2], info: { name: 'counter' } });
    expect(call('--address', ADDRESS, '--circuit', 'increment').callArgs).toEqual([]);
  });

  it.each([
    [['--circuit', 'increment'], 'contract address'],
    [['--address', ADDRESS], 'circuit name'],
    [['--address', 'deadbeef', '--circuit', 'increment'], 'A contract address is 64 hex characters'],
    [['--address', ADDRESS, '--circuit', 'decrement'], 'counter has no circuit "decrement"'],
    [['--address', ADDRESS, '--circuit', 'add', '--args', '[1]'], 'add takes 2 arguments (x, y); 1 was given.'],
    [['--address', ADDRESS, '--circuit', 'add', '--args', '[1,'], 'The arguments in --args are not valid JSON'],
    [['--address', ADDRESS, '--circuit', 'add', '--args', '"12"'], 'The arguments in --args are JSON of type string: give an array or an object of the arguments.'],
  ])('refuses %j', (flags, message) => {
    expect(() => call(...flags)).toThrow(message);
  });

  it('refuses a call where there is no compiled contract', () => {
    rmSync(join(dir, 'managed'), { recursive: true });
    expect(() => call('--address', ADDRESS, '--circuit', 'increment')).toThrow(`No compiled contract found in ${dir}`);
  });
});

describe('resolveContractDeployRequest', () => {
  it('reads the constructor arguments and the private-state key', () => {
    const key = 'ab'.repeat(32);
    expect(deploy('--args', '[7]', '--secret-key', key))
      .toMatchObject({ dappDir: dir, constructorArgs: [7], privateStateSecretKey: key, info: { name: 'counter' } });
  });

  it('refuses a secret key that is not 32 bytes of hex', () => {
    expect(() => deploy('--secret-key', 'abc')).toThrow(UsageError);
    expect(() => deploy('--secret-key', 'abc')).toThrow('(--secret-key, --secret-key-file) must be 32 bytes of hex (64 chars)');
  });

  it('refuses a contract that declares witnesses with no compiled witnesses.js, naming them', () => {
    rmSync(join(dir, 'managed'), { recursive: true });
    compiledContract('owned', [{ name: 'secret_key' }]);
    expect(() => deploy()).toThrow('secret_key');

    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'witnesses.js'), 'export const witnesses = {};\n');
    expect(deploy().info.name).toBe('owned');
  });

  it('refuses the missing witnesses.js with its own code, on a deploy and on a call, before any wallet', () => {
    rmSync(join(dir, 'managed'), { recursive: true });
    compiledContract('owned', [{ name: 'secret_key' }]);
    expect(() => deploy()).toThrow(expect.objectContaining({ code: 'WITNESSES_NOT_FOUND', name: 'WitnessesNotFoundError' }));
    expect(() => call('--address', ADDRESS, '--circuit', 'increment')).toThrow(expect.objectContaining({ code: 'WITNESSES_NOT_FOUND' }));
  });

  it('refuses a count of constructor arguments the constructor doesn\'t take, naming its parameters, as a call\'s count is', () => {
    // The compiler's declaration of the contract names the constructor's parameters after the context.
    mkdirSync(join(dir, 'managed', 'counter', 'contract'), { recursive: true });
    writeFileSync(join(dir, 'managed', 'counter', 'contract', 'index.d.ts'),
      'export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {\n'
      + '  initialState(context: __compactRuntime.ConstructorContext<PS>, start_0: bigint, owner_0: { bytes: Uint8Array }): Promise<__compactRuntime.ConstructorResult<PS>>;\n}\n');
    expect(() => deploy()).toThrow(UsageError);
    expect(() => deploy()).toThrow("counter's constructor takes 2 arguments (start, owner); 0 were given.");
    expect(() => deploy('--args', '[7]')).toThrow("counter's constructor takes 2 arguments (start, owner); 1 was given.");
    expect(deploy('--args', '[7, {"bytes": [1]}]').constructorArgs).toHaveLength(2);
  });
});

describe('the plain builders', () => {
  it('build the same request from plain values a program holds, with no flags and no working directory', () => {
    // The readers say where the arguments came from as well (argsSource).
    expect(contractCallRequest({ dappDir: dir, address: ADDRESS, circuit: 'add', args: [1, 2] }))
      .toEqual({ ...call('--address', ADDRESS, '--circuit', 'add', '--args', '[1,2]'), argsSource: undefined, secretKeySource: undefined });
    const key = 'ab'.repeat(32);
    expect(contractDeployRequest({ dappDir: dir, args: [7], secretKey: key })).toEqual({ ...deploy('--args', '[7]', '--secret-key', key), argsSource: undefined, secretKeySource: undefined });
    expect(contractDeployRequest({ dappDir: dir })).toMatchObject({ constructorArgs: [], privateStateSecretKey: undefined });
  });

  it('look for the compiled contract in managedDir when given, and pick one by name', () => {
    compiledContract('token');
    const managedDir = join(dir, 'managed', 'token');
    expect(contractDeployRequest({ dappDir: tmpdir(), managedDir }).info.name).toBe('token');
    expect(contractDeployRequest({ dappDir: dir, name: 'token' }).info.name).toBe('token');
    expect(contractDeployRequest({ dappDir: dir }).info.name).toBe('counter');
  });

  it('refuse a call\'s bad address, unknown circuit and wrong count of arguments as usage mistakes', () => {
    expect(() => contractCallRequest({ dappDir: dir, address: 'deadbeef', circuit: 'increment' })).toThrow(UsageError);
    expect(() => contractCallRequest({ dappDir: dir, address: ADDRESS, circuit: 'decrement' })).toThrow('counter has no circuit "decrement"');
    expect(() => contractCallRequest({ dappDir: dir, address: ADDRESS, circuit: 'add', args: [1] })).toThrow('add takes 2 arguments (x, y); 1 was given.');
  });
});

describe('--secret-key', () => {
  const key = 'ab'.repeat(32);

  it('reaches a call too, for a contract deployed with one: its owner\'s secret', () => {
    expect(call('--address', ADDRESS, '--circuit', 'increment', '--secret-key', key).privateStateSecretKey).toBe(key);
    expect(call('--address', ADDRESS, '--circuit', 'increment').privateStateSecretKey).toBeUndefined();
  });

  it('takes legacy on a call, for a contract an mn before 0.6.0 deployed with its default', () => {
    expect(call('--address', ADDRESS, '--circuit', 'increment', '--secret-key', 'legacy').privateStateSecretKey).toBe('legacy');
  });

  // The legacy secret is the wallet's public coin key: a contract deployed with it can be taken over.
  it('refuses legacy on a deploy, and anything but 32 bytes of hex on either', () => {
    expect(() => deploy('--secret-key', 'legacy')).toThrow(UsageError);
    expect(() => deploy('--secret-key', 'legacy')).toThrow(/must not be deployed with it/);
    expect(() => deploy('--secret-key', 'abcd')).toThrow('(--secret-key, --secret-key-file) must be 32 bytes of hex (64 chars)');
    expect(() => call('--address', ADDRESS, '--circuit', 'increment', '--secret-key', 'abcd')).toThrow(UsageError);
  });
});

// The owner's secret has ways in that keep it off the command line, as private arguments do.
describe('--secret-key-file and --secret-key -', () => {
  const key = 'cd'.repeat(32);

  it('read the secret from a file (trimmed), and from the standard input', () => {
    writeFileSync(join(dir, 'owner.key'), `${key}\n`, { mode: 0o600 });
    const fromFile = resolveContractCallRequest(parseArgs(['contract', 'call', '--path', dir, '--address', ADDRESS, '--circuit', 'increment', '--secret-key-file', 'owner.key']), dir);
    expect(fromFile).toMatchObject({ privateStateSecretKey: key, secretKeySource: 'file' });
    const fromStdin = resolveContractDeployRequest(parseArgs(['contract', 'deploy', '--path', dir, '--secret-key', '-']), dir, () => `${key}\n`);
    expect(fromStdin).toMatchObject({ privateStateSecretKey: key, secretKeySource: 'stdin' });
    expect(deploy('--secret-key', key).secretKeySource).toBe('inline');
    expect(deploy().secretKeySource).toBe('none');
  });

  // The bug's shape: a FIFO (what <(…) names) whose writer has not written yet.
  it('read a FIFO to its end, written after the read starts', async () => {
    const fifo = join(dir, 'owner.fifo');
    execFileSync('mkfifo', [fifo]);
    const writer = spawn('bash', ['-c', `sleep 0.3; printf '%s\\n' ${key} > "${fifo}"`], { stdio: 'ignore' });
    try {
      expect(call('--address', ADDRESS, '--circuit', 'increment', '--secret-key-file', fifo)).toMatchObject({ privateStateSecretKey: key, secretKeySource: 'file' });
    } finally {
      await new Promise((resolve) => writer.once('exit', resolve));
    }
  });

  it('refuse both flags, both - inputs, an empty file, - with no standard input, and never quote what was read', () => {
    writeFileSync(join(dir, 'empty.key'), '\n');
    writeFileSync(join(dir, 'bad.key'), 'not-the-secret-123');
    expect(() => deploy('--secret-key', key, '--secret-key-file', 'x')).toThrow('Give the private-state secret once');
    expect(() => resolveContractCallRequest(parseArgs(['contract', 'call', '--path', dir, '--address', ADDRESS, '--circuit', 'add', '--args', '-', '--secret-key', '-']), dir, () => '[1,2]')).toThrow('--args - and --secret-key - both read the standard input');
    expect(() => deploy('--secret-key-file', join(dir, 'empty.key'))).toThrow('holds no private-state secret');
    expect(() => deploy('--secret-key', '-')).toThrow('--secret-key - reads the secret from the standard input');
    expect(() => deploy('--secret-key-file', join(dir, 'missing.key'))).toThrow(/Can't read --secret-key-file .*missing\.key \(ENOENT\)/);
    try { deploy('--secret-key-file', join(dir, 'bad.key')); } catch (err) { expect((err as Error).message).not.toContain('not-the-secret-123'); }
  });

  it('warn when the secret is on the command line, never for a file, the standard input or legacy', () => {
    expect(inlineSecretKeyWarning({ secretKey: key, source: 'inline' })).toMatch(/^--secret-key put the contract's private-state secret .* on the command line.*--secret-key-file <path> or --secret-key -/);
    expect(inlineSecretKeyWarning({ secretKey: key, source: 'inline' })).not.toContain(key);
    expect(inlineSecretKeyWarning({ secretKey: key, source: 'file' })).toBeUndefined();
    expect(inlineSecretKeyWarning({ secretKey: key, source: 'stdin' })).toBeUndefined();
    expect(inlineSecretKeyWarning({ secretKey: 'legacy', source: 'inline' })).toBeUndefined();
  });
});

describe('the argument readers\' working directory', () => {
  it('is where the contract is looked for when neither --path nor --managed is given', () => {
    expect(resolveContractDeployRequest(parseArgs(['contract', 'deploy']), dir)).toMatchObject({ dappDir: dir, info: { name: 'counter' } });
    expect(resolveScanDir(parseArgs(['contract', 'inspect']), dir)).toBe(dir);
    expect(resolveScanDir(parseArgs(['contract', 'inspect', '--managed', 'managed/counter']), dir)).toBe(join(dir, 'managed', 'counter'));
  });
});
