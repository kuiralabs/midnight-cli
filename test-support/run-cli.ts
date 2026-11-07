// The CLI run as a user runs it: this checkout's entry point in a process of
// its own, with the home given (so its state root is the test's), no colour,
// and no MN_PASSPHRASE unless the test sets one.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entryPoint = resolve(import.meta.dirname, '../src/wallet.ts');
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  /** Variables set for the run, over the test process's own (MN_PASSPHRASE removed). */
  env?: Record<string, string>;
  /** What the run reads on stdin; it ends after this. */
  input?: string;
}

/** Runs `mn <args>` with HOME at `home`, and returns its exit status and output. */
export function runCli(home: string, args: readonly string[], { env = {}, input = '' }: CliRunOptions = {}): CliRun {
  const runEnv: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: '1' };
  delete runEnv.MN_PASSPHRASE;
  Object.assign(runEnv, env);
  const run = spawnSync(process.execPath, ['--import', tsxLoader, entryPoint, ...args], { env: runEnv, encoding: 'utf8', input, timeout: 60_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
