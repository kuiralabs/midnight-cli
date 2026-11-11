// How a deploy or call script gets its arguments: never in its text or argv,
// where a circuit's private inputs would sit in the dApp's folder and in `ps`,
// but in a file only the user can read (0600, in a 0700 folder under mn's
// state root), named to the script by its environment. The script reads the
// file and deletes it at once; mn deletes it too when the script ends,
// however it ends. A file left by an mn that was killed is deleted by the
// next run.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The environment variable naming a script's arguments file. */
export const CONTRACT_ARGS_FILE_ENV = 'MN_CONTRACT_ARGS_FILE';

/** The folder under mn's state root that holds the arguments files of running scripts. */
export const CONTRACT_ARGS_DIR = 'contract-args';

/** An arguments file's name: the pid of the mn that wrote it, then random hex. */
const ARGS_FILE_NAME = /^(\d+)-[0-9a-f]+\.json$/;

/** The folder of the arguments files under the state root `root`. */
export function contractArgsDir(root: string): string {
  return join(root, CONTRACT_ARGS_DIR);
}

/** Whether a process with this pid is running (one of another user counts: it can't be ours to clean). */
export function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === 'EPERM';
  }
}

/**
 * Deletes the arguments files in `dir` whose mn is no longer running: what a
 * run killed before it could clean up left. Returns how many it deleted.
 */
export function sweepContractArgsFiles(dir: string, isAlive: (pid: number) => boolean = processRuns): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = ARGS_FILE_NAME.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch { /* already gone */ }
  }
  return removed;
}

/**
 * Writes `args` as JSON to a new file in `dir`, created 0600 (and never over
 * an existing one), the folder made or tightened to 0700 first and its
 * leftovers swept. Returns the file's path.
 */
export function writeContractArgsFile(dir: string, args: readonly unknown[]): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A folder that exists already keeps its mode: tightened, as the store's is.
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  sweepContractArgsFiles(dir);
  const path = join(dir, `${process.pid}-${randomBytes(8).toString('hex')}.json`);
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(args));
  } catch (err) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw err;
  }
  closeSync(fd);
  return path;
}

/** Deletes an arguments file; one already gone (the script deleted it) is fine. */
export function removeContractArgsFile(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Reads a script's arguments from the file `path` names and deletes the file
 * at once, read or not. Serialized into the generated script (runner.ts), so
 * it imports nothing: the script gives it `node:fs`.
 */
export function readContractArgsFile(fs: { readFileSync(path: string, encoding: 'utf8'): string; unlinkSync(path: string): void }, path: string | undefined): unknown[] {
  if (typeof path !== 'string' || path === '') {
    throw new Error('The contract script was given no arguments file (MN_CONTRACT_ARGS_FILE): it is started by mn contract deploy or call, which write one.');
  }
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } finally {
    try { fs.unlinkSync(path); } catch { /* mn deletes it when the script ends */ }
  }
  const args: unknown = JSON.parse(text);
  if (!Array.isArray(args)) throw new Error('The contract script\'s arguments file does not hold a list of arguments.');
  return args;
}
