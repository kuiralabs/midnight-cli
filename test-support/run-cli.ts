// The CLI run as a user runs it: this checkout's entry point in a process of
// its own, with the home given (so its state root is the test's), no colour,
// and no MN_PASSPHRASE unless the test sets one.
//
// The run is awaited, not waited on with spawnSync: a test or hook that ran a
// few CLI runs in a row held its vitest worker's event loop for their whole
// length, past the 60 s vitest's worker gives its own calls to the runner, and
// the run failed with "Timeout calling onTaskUpdate" though every test passed.

import { spawn } from 'node:child_process';
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

/** How long a run may take before it's killed (its status is then null). */
const RUN_TIMEOUT_MS = 60_000;

/** Runs `mn <args>` with HOME at `home`, and resolves to its exit status and output. */
export function runCli(home: string, args: readonly string[], { env = {}, input = '' }: CliRunOptions = {}): Promise<CliRun> {
  const runEnv: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: '1' };
  delete runEnv.MN_PASSPHRASE;
  Object.assign(runEnv, env);
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, entryPoint, ...args], { env: runEnv, stdio: ['pipe', 'pipe', 'pipe'], timeout: RUN_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
