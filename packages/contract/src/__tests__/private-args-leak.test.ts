// A circuit's arguments are private inputs to its proof. On their way into a
// deploy or call script they must not land where others read them: the
// script's text (a file in the dApp's folder, where git picks it up), its
// argv (`ps`), or a file anyone else may read. These run real Node processes
// through executeScript, and read the scripts the rc engine writes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core';
import type { CallScript, DeployScript } from '@kuiralabs/midnight-cli-core/engine';
import { CancelledError } from '@kuiralabs/midnight-cli-core';
import { SCRIPT_PARTS, SCRIPT_PRELUDE, ContractScriptError, executeScript, sweepLeftoverScripts } from '../lib/contract/runner.ts';
import { CONTRACT_ARGS_FILE_ENV, contractArgsDir, readContractArgsFile, sweepContractArgsFiles, writeContractArgsFile } from '../lib/contract/contract-args-file.ts';
import { rcEngine } from '../../../../test-support/rc-engine.ts';

const SECRET = 'a-bid-of-31337-nobody-may-see';
const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };
const NETWORK: NetworkConfig = {
  indexer: 'http://127.0.0.1:1/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:1/api/v4/graphql/ws',
  node: 'ws://127.0.0.1:1',
  proofServer: 'http://127.0.0.1:1',
  networkId: 'Undeployed',
};

let dapp: string;
let root: string;

beforeEach(() => {
  dapp = mkdtempSync(join(tmpdir(), 'mn-args-dapp-'));
  root = mkdtempSync(join(tmpdir(), 'mn-args-root-'));
});

afterEach(() => {
  rmSync(dapp, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir` with its text. */
function filesUnder(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found[join(entry.parentPath, entry.name)] = readFileSync(join(entry.parentPath, entry.name), 'utf8');
  }
  return found;
}

/** A pid no process has: a child that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid!;
}

describe('the scripts the engine writes', () => {
  // The runner hands the engine the whole of its options, arguments too: the
  // script's text must still hold none of them.
  const base = { networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/escrow', contractName: 'escrow', servePort: 9932 };

  it('hold no argument of a call, though the options they are written from carry them', () => {
    const script = rcEngine.contracts.scripts.call({ ...base, contractAddress: 'ab'.repeat(32), circuit: 'bid', args: [SECRET, { amount: SECRET }] } as CallScript, SCRIPT_PARTS);
    expect(script).not.toContain(SECRET);
    expect(script).toContain(`process.env.${CONTRACT_ARGS_FILE_ENV}`);
  });

  it('hold no constructor argument of a deploy', () => {
    const script = rcEngine.contracts.scripts.deploy({ ...base, args: [SECRET] } as DeployScript, SCRIPT_PARTS);
    expect(script).not.toContain(SECRET);
    expect(script).toContain(`process.env.${CONTRACT_ARGS_FILE_ENV}`);
  });
});

/**
 * A script that reports what it can see of itself as it runs (its argv, its
 * own file's mode, the arguments file's mode, every file in the dApp's folder
 * and the arguments folder), then reads its arguments as a deploy or call
 * script does, and prints them.
 */
const reportingScript = (argsDir: string) => `${SCRIPT_PRELUDE}
import * as mnFs from 'node:fs';
import * as mnPath from 'node:path';
${SCRIPT_PARTS.contractArgsFn}
const argsFile = process.env.${CONTRACT_ARGS_FILE_ENV};
const listing = (dir) => Object.fromEntries(mnFs.readdirSync(dir).filter((name) => mnFs.statSync(mnPath.join(dir, name)).isFile()).map((name) => [name, mnFs.readFileSync(mnPath.join(dir, name), 'utf8')]));
const seen = {
  argv: process.argv,
  scriptMode: mnFs.statSync(process.argv[1]).mode & 0o777,
  argsFileMode: mnFs.statSync(argsFile).mode & 0o777,
  argsDirMode: mnFs.statSync(${JSON.stringify(argsDir)}).mode & 0o777,
  argsFileInArgsDir: mnPath.dirname(argsFile) === ${JSON.stringify(argsDir)},
  dappFiles: listing(process.cwd()),
};
const args = readContractArgsFile(mnFs, argsFile);
seen.argsFileAfterRead = mnFs.existsSync(argsFile);
console.log(JSON.stringify({ seen, args }));
`;

describe('a script given its arguments', () => {
  it('gets them from a 0600 file in a 0700 folder outside the dApp, never on its argv or in any file of the dApp, and nothing of them is left', async () => {
    const argsDir = contractArgsDir(root);
    const out = JSON.parse(await executeScript({ dir: dapp, script: reportingScript(argsDir), overlaySdk: false, packages: NO_PACKAGES, args: { dir: argsDir, values: [SECRET, 5] } })) as {
      seen: { argv: string[]; scriptMode: number; argsFileMode: number; argsDirMode: number; argsFileInArgsDir: boolean; dappFiles: Record<string, string>; argsFileAfterRead: boolean };
      args: unknown[];
    };
    expect(out.args).toEqual([SECRET, 5]);
    expect(JSON.stringify(out.seen.argv)).not.toContain(SECRET);
    expect(out.seen.scriptMode).toBe(0o600);
    expect(out.seen.argsFileMode).toBe(0o600);
    expect(out.seen.argsDirMode).toBe(0o700);
    expect(out.seen.argsFileInArgsDir).toBe(true);
    expect(Object.keys(out.seen.dappFiles)).toHaveLength(1);
    expect(Object.keys(out.seen.dappFiles)[0]).toMatch(new RegExp(`^\\.mn-contract-${process.pid}-\\d+-[0-9a-f]{8}\\.mjs$`));
    expect(JSON.stringify(out.seen.dappFiles)).not.toContain(SECRET);
    // Read once, gone: the script deleted it.
    expect(out.seen.argsFileAfterRead).toBe(false);
    expect(readdirSync(dapp)).toEqual([]);
    expect(readdirSync(argsDir)).toEqual([]);
  });

  it('leaves no arguments file when it fails before reading it', async () => {
    const argsDir = contractArgsDir(root);
    const script = `${SCRIPT_PRELUDE}\nthrow new Error('boom before the arguments were read');\n`;
    await expect(executeScript({ dir: dapp, script, overlaySdk: false, packages: NO_PACKAGES, args: { dir: argsDir, values: [SECRET] } })).rejects.toBeInstanceOf(ContractScriptError);
    expect(readdirSync(argsDir)).toEqual([]);
    expect(readdirSync(dapp)).toEqual([]);
  });

  it('leaves no arguments file when its run is cancelled while it waits', async () => {
    const argsDir = contractArgsDir(root);
    const controller = new AbortController();
    // The script says it started, then waits without reading its arguments.
    const script = `${SCRIPT_PRELUDE}\nprocess.stderr.write('started\\n');\nsetInterval(() => {}, 1000);\n`;
    const run = executeScript({ dir: dapp, script, overlaySdk: false, packages: NO_PACKAGES, args: { dir: argsDir, values: [SECRET] }, signal: controller.signal, onMessage: () => {
      // While it runs the file is there, 0600, and holds the arguments.
      const [name] = readdirSync(argsDir);
      expect(statSync(join(argsDir, name!)).mode & 0o777).toBe(0o600);
      controller.abort();
    } });
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(readdirSync(argsDir)).toEqual([]);
    expect(readdirSync(dapp)).toEqual([]);
  });

  it('does not report the value the compact runtime refused, only the type it wanted', async () => {
    const script = `${SCRIPT_PRELUDE}\nthrow new Error('type error: bid argument 1 (as invoked from Typescript) at escrow.compact line 9 char 1; expected value of type Bytes<32> but received ${SECRET}');\n`;
    const failed = await executeScript({ dir: dapp, script, overlaySdk: false, packages: NO_PACKAGES }).catch((err: unknown) => err as Error);
    expect(failed).toBeInstanceOf(ContractScriptError);
    expect((failed as Error).message).toContain('expected value of type Bytes<32>');
    expect((failed as Error).message).not.toContain(SECRET);
  });
});

describe('what a killed run leaves', () => {
  it('is deleted by the next run: its script in the dApp and its arguments file', async () => {
    const pid = await deadPid();
    const leftScript = join(dapp, `.mn-contract-${pid}-1762800000000-0badcafe.mjs`);
    writeFileSync(leftScript, `const args = [${JSON.stringify(SECRET)}];`);
    // One an mn before the pid was in the name left, long ago.
    const oldScript = join(dapp, '.mn-contract-1762800000000-deadbeef.mjs');
    writeFileSync(oldScript, `const args = [${JSON.stringify(SECRET)}];`);
    utimesSync(oldScript, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const argsDir = contractArgsDir(root);
    mkdirSync(argsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(argsDir, `${pid}-00112233.json`), JSON.stringify([SECRET]), { mode: 0o600 });

    await executeScript({ dir: dapp, script: `${SCRIPT_PRELUDE}\nimport * as mnFs from 'node:fs';\n${SCRIPT_PARTS.contractArgsFn}\nreadContractArgsFile(mnFs, process.env.${CONTRACT_ARGS_FILE_ENV});\n`, overlaySdk: false, packages: NO_PACKAGES, args: { dir: argsDir, values: [] } });

    expect(existsSync(leftScript)).toBe(false);
    expect(existsSync(oldScript)).toBe(false);
    expect(readdirSync(argsDir)).toEqual([]);
    expect(Object.values(filesUnder(dapp)).join('')).not.toContain(SECRET);
  });

  it('keeps what a running mn holds, and files that aren\'t mn\'s', () => {
    const live = join(dapp, `.mn-contract-${process.pid}-1762800000000-0badcafe.mjs`);
    const recentOld = join(dapp, '.mn-contract-1762800000000-deadbeef.mjs');
    const theirs = join(dapp, '.mn-contract-notes.mjs');
    for (const file of [live, recentOld, theirs]) writeFileSync(file, '');
    expect(sweepLeftoverScripts(dapp, () => false)).toEqual([]);
    expect(readdirSync(dapp).sort()).toEqual(['.mn-contract-1762800000000-deadbeef.mjs', `.mn-contract-${process.pid}-1762800000000-0badcafe.mjs`, '.mn-contract-notes.mjs'].sort());
  });
});

describe('the arguments file', () => {
  it('is written 0600 in a folder tightened to 0700, never over a file that is there', () => {
    const dir = contractArgsDir(root);
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const path = writeContractArgsFile(dir, [SECRET]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([SECRET]);
  });

  it('is deleted as it is read, and a file that holds no list is refused', () => {
    const dir = contractArgsDir(root);
    const fs = { readFileSync, unlinkSync: (path: string) => rmSync(path) };
    const path = writeContractArgsFile(dir, [1, 'two']);
    expect(readContractArgsFile(fs, path)).toEqual([1, 'two']);
    expect(existsSync(path)).toBe(false);
    const bad = join(dir, `${process.pid}-ff.json`);
    writeFileSync(bad, '{"a":1}', { mode: 0o600 });
    expect(() => readContractArgsFile(fs, bad)).toThrow('does not hold a list');
    expect(existsSync(bad)).toBe(false);
    expect(() => readContractArgsFile(fs, undefined)).toThrow(CONTRACT_ARGS_FILE_ENV);
  });

  it('of an mn no longer running is swept; one of a running mn is kept', async () => {
    const dir = contractArgsDir(root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dead = await deadPid();
    writeFileSync(join(dir, `${dead}-aa.json`), '[]');
    writeFileSync(join(dir, `${process.pid}-bb.json`), '[]');
    writeFileSync(join(dir, 'notes.txt'), '');
    expect(sweepContractArgsFiles(dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`${process.pid}-bb.json`, 'notes.txt']);
  });
});
