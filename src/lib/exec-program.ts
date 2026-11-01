// Running a program as a call's step: asynchronously, so the process keeps
// serving other calls while it runs, and killed when the call is cancelled.
// No shell: the program and its arguments are passed as they are.

import { spawn } from 'node:child_process';
import { CancelledError } from './errors.ts';

/** How one program runs. */
export interface ExecRun {
  /** The call's cancellation: the program is killed and the run fails with CancelledError. */
  readonly signal: AbortSignal;
  /** The program is killed after this long and the run fails with ProgramTimedOutError; none: no limit. */
  readonly timeoutMs?: number;
  /** Each chunk of the program's stderr as it comes, besides being kept for the error; none: only kept. */
  readonly onStderr?: (text: string) => void;
}

/** How long a program told to stop (SIGTERM) gets before it is killed outright (SIGKILL). */
const KILL_GRACE_MS = 2_000;

/** Runs `file` with `args` and returns its stdout once it exits with code 0. */
export type ExecRunner = (file: string, args: readonly string[], run: ExecRun) => Promise<string>;

/** The program exited with a code other than 0 (null: killed by a signal from elsewhere); its stderr is in the message, and what it printed is kept. */
export class ProgramFailedError extends Error {
  constructor(readonly command: string, readonly exitCode: number | null, readonly stderr: string, readonly stdout: string) {
    super(`Command failed: ${command}\n${stderr}`);
    this.name = 'ProgramFailedError';
    Object.setPrototypeOf(this, ProgramFailedError.prototype);
  }
}

/** The program ran past its time limit and was killed. */
export class ProgramTimedOutError extends Error {
  constructor(readonly command: string, timeoutMs: number) {
    super(`Command timed out (ETIMEDOUT) after ${timeoutMs / 1000}s: ${command}`);
    this.name = 'ProgramTimedOutError';
    Object.setPrototypeOf(this, ProgramTimedOutError.prototype);
  }
}

/** Runs the program as a child process, its stdin closed and its output piped. */
export const execProgram: ExecRunner = (file, args, { signal, timeoutMs, onStderr }) => new Promise<string>((resolve, reject) => {
  if (signal.aborted) { reject(new CancelledError()); return; }
  const command = [file, ...args].join(' ');
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let ended: 'cancelled' | 'timed out' | undefined;
  let forced: NodeJS.Timeout | undefined;
  const end = (why: 'cancelled' | 'timed out'): void => {
    if (ended !== undefined) return;
    ended = why;
    child.kill();
    // A program that ignores SIGTERM would keep the call open: it is killed outright after a grace period.
    forced = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  const onAbort = (): void => end('cancelled');
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => end('timed out'), timeoutMs);
  const settle = (): void => {
    signal.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeout(timer);
    if (forced !== undefined) clearTimeout(forced);
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    onStderr?.(chunk);
  });
  child.on('error', (err) => {
    settle();
    reject(ended === 'cancelled' ? new CancelledError() : err);
  });
  child.on('close', (code) => {
    settle();
    if (ended === 'cancelled') reject(new CancelledError());
    else if (ended === 'timed out') reject(new ProgramTimedOutError(command, timeoutMs ?? 0));
    else if (code !== 0) reject(new ProgramFailedError(command, code, stderr, stdout));
    else resolve(stdout);
  });
});
