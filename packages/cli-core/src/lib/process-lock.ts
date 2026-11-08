// A lock several mn processes take in turn: a file created exclusively (Node
// has no flock without a native module), holding the holder's pid and command,
// and a token so a holder lets go only of the lock it took. A lock whose
// process ended (an mn that crashed) is taken over at once. A waiting process
// says once that it waits and for whom, then how long, and after its time
// either fails or goes ahead, as its caller says.

import { CancelledError } from './errors.ts';

/** An mn process that holds a lock. */
export interface LockHolder {
  pid: number;
  /** Its command, without its flags' values: `mn contract call`. */
  command: string;
}

/** A command as a lock names it: the program's name and the words before the first flag, so no flag's value (a secret key) is written. */
export function holderCommandOf(argv: readonly string[]): string {
  const program = (argv[1] ?? 'mn').split(/[\\/]/).pop()!.replace(/\.[mc]?[jt]s$/, '');
  const words: string[] = [];
  for (const word of argv.slice(2)) {
    if (word.startsWith('-')) break;
    words.push(word);
  }
  return [program === 'wallet' || program === 'midnight' ? 'mn' : program, ...words].join(' ');
}

/** Whether the process `pid` runs: signal 0 reaches it, or it is someone else's (EPERM). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === 'EPERM';
  }
}

/** What a lock is taken with. */
export interface ProcessLockDeps {
  fs: {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
    openSync(path: string, flags: string, mode: number): number;
    writeSync(fd: number, data: string): number;
    closeSync(fd: number): void;
    readFileSync(path: string, encoding: 'utf8'): string;
    renameSync(from: string, to: string): void;
    linkSync(existing: string, link: string): void;
    rmSync(path: string, options: { force: boolean }): void;
  };
  join(...parts: string[]): string;
  dirname(path: string): string;
  /** Whether the process `pid` runs. */
  isAlive(pid: number): boolean;
  now(): number;
  /** Waits `ms`, or throws CancelledError when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ProcessLockOptions {
  timeoutMs: number;
  /** Said once as the wait starts, and again for another holder; `by` names it ("another mn (pid 1234, mn contract call)"). */
  notice(by: string): void;
  /** Said at each retry, with the time waited. */
  progress(by: string, waitedMs: number): void;
  /** Past `timeoutMs`: the error to fail with, or undefined to go ahead without the lock. */
  timedOut(by: string, waitedMs: number): Error | undefined;
  signal?: AbortSignal;
}

/** A lock taken, to let go of; `held` false when the wait ended without it (timedOut gave no error). */
export interface TakenLock {
  held: boolean;
  release(): void;
}

/**
 * Takes the lock in `file` for `holder`, waiting while another live process
 * holds it (every 0.5 s, then up to every 2 s). A lock whose process ended is
 * taken over at once. CancelledError at once when `signal` aborts.
 */
export async function acquireProcessLock(deps: ProcessLockDeps, file: string, holder: LockHolder, options: ProcessLockOptions): Promise<TakenLock> {
  const { fs } = deps;
  const token = `${holder.pid}-${deps.now()}-${Math.random().toString(16).slice(2)}`;
  const started = deps.now();
  let delay = 500;
  let said: string | undefined;
  const dir = deps.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    if (options.signal?.aborted === true) throw new CancelledError();
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ ...holder, token }) + '\n');
      } finally {
        fs.closeSync(fd);
      }
      return {
        held: true,
        release: () => {
          // Only the lock this one took: one taken over after it was judged stale stays its new holder's.
          try {
            if ((JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: unknown }).token === token) fs.rmSync(file, { force: true });
          } catch { /* gone already */ }
        },
      };
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
    }
    const current = readLock(fs, file);
    if (current !== undefined && !deps.isAlive(current.pid)) {
      takeOverStale(deps, file, current.raw);
      continue;
    }
    // A lock being written (no content yet), or a live holder.
    const by = current === undefined ? 'another mn' : `another mn (pid ${current.pid}${current.command === undefined ? '' : `, ${current.command}`})`;
    const waited = deps.now() - started;
    if (waited >= options.timeoutMs) {
      const error = options.timedOut(by, waited);
      if (error !== undefined) throw error;
      return { held: false, release: () => {} };
    }
    if (said !== by) {
      said = by;
      options.notice(by);
    }
    options.progress(by, waited);
    await deps.sleep(Math.min(delay, options.timeoutMs - waited), options.signal);
    delay = Math.min(delay * 2, 2000);
  }
}

/** The lock file's holder, and its text; undefined while it has none readable (being written, or just removed). */
function readLock(fs: ProcessLockDeps['fs'], file: string): { pid: number; command?: string; raw: string } | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lock = JSON.parse(raw) as { pid?: unknown; command?: unknown };
    if (typeof lock.pid !== 'number') return undefined;
    return { pid: lock.pid, ...(typeof lock.command === 'string' ? { command: lock.command } : {}), raw };
  } catch {
    return undefined;
  }
}

/**
 * Removes a lock whose holder ended, by moving it aside first, which only one
 * of several takers manages. One that moved a lock taken meanwhile (not the
 * stale one it read) puts it back, unless the place was taken again.
 */
function takeOverStale(deps: ProcessLockDeps, file: string, stale: string): void {
  const { fs } = deps;
  const aside = `${file}.stale-${process.pid}-${deps.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // another taker moved it first
  }
  let moved = '';
  try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* read below as not the stale one */ }
  if (moved !== stale) {
    try { fs.linkSync(aside, file); } catch { /* taken again meanwhile */ }
  }
  fs.rmSync(aside, { force: true });
}
