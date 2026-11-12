// Cold-sync heap headroom guard: mn's re-exec.
//
// A cold shielded or Dust sync against a hosted network overflows Node's
// default old-space limit (core's process/sync-heap.ts says why). The limit is
// fixed at start, so before any SDK/WASM module loads mn re-execs itself with
// the `--max-old-space-size` core's syncHeapTargetMb gives. Because the CLI
// dispatches command handlers via dynamic import, calling this from the entry
// point ahead of dispatch means the parent re-execs before the SDK is ever
// loaded — no double load. It is a no-op when the heap is already large enough
// (e.g. the user set NODE_OPTIONS) or when we're already running as the
// re-exec'd child.

import v8 from 'node:v8';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { syncHeapTargetMb } from '@kuiralabs/midnight-cli-core/process';

/** Set on the re-exec'd child so it doesn't recurse. */
const BUMP_ENV = 'MN_HEAP_BUMPED';
/** Power-user override for the target cap, in MB (e.g. on a small machine). */
const OVERRIDE_ENV = 'MN_MAX_OLD_SPACE_MB';
const MB = 1024 * 1024;

/**
 * Re-exec the current process with more old-space headroom when a cold sync
 * would otherwise overflow Node's default heap. No-op when not needed. When a
 * re-exec happens this Promise never resolves — the parent's only remaining job
 * is to forward signals to the child and mirror its exit — so callers must
 * `await` it before dispatching a command.
 *
 * The child's lifetime is tied to the parent: catchable termination signals
 * (`SIGINT`/`SIGTERM`/`SIGHUP`) are forwarded to it, any parent exit kills it,
 * and — for the uncatchable `kill -9 <parent>` case — the child watches for
 * reparenting and terminates itself. Without this, killing the launcher left the
 * re-exec'd child orphaned and still holding e.g. the `mn serve` port.
 */
export async function ensureHeapForSync(): Promise<void> {
  if (process.env[BUMP_ENV]) {
    // We are the re-exec'd child. Guard against the launcher dying without
    // signalling us (SIGKILL): if we get reparented, the launcher is gone, so
    // terminate rather than orphan and keep holding a port.
    watchParentDeath();
    return;
  }

  const overrideRaw = process.env[OVERRIDE_ENV];
  const desiredMb = overrideRaw !== undefined ? Number(overrideRaw) : undefined;

  // Read here rather than through syncHeapAdvice, which advises nothing under
  // bun: mn re-execs under whichever runtime runs it, as it always has.
  const target = syncHeapTargetMb({
    totalMb: Math.floor(os.totalmem() / MB),
    currentLimitMb: Math.floor(v8.getHeapStatistics().heap_size_limit / MB),
    desiredMb,
  });
  if (target === null) return;

  return new Promise<void>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${target}`,
        ...process.execArgv,
        process.argv[1],
        ...process.argv.slice(2),
      ],
      { stdio: reExecStdio(process.argv.slice(2)), env: { ...process.env, [BUMP_ENV]: '1' } },
    );

    // Tie the child's lifetime to the parent (forward signals + kill on exit).
    tieChildLifetime(child);

    child.on('error', () => {
      // Couldn't re-exec (rare). Continue in-process with the heap we have —
      // better to try and maybe OOM than to fail before doing any work. The
      // leftover kill handlers are harmless no-ops (the child never started).
      process.env[BUMP_ENV] = '1';
      resolve();
    });
    // Mirror the child's termination. On the normal re-exec path we exit here and
    // the Promise never resolves — the parent never returns to command dispatch.
    child.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
  });
}

/** A descriptor an argument names by path: /dev/fd/N (zsh's and macOS bash's process substitution) or /proc/self/fd/N. */
const DESCRIPTOR_PATH = /^(?:\/dev\/fd|\/proc\/self\/fd)\/(\d+)$/;

/**
 * The re-exec'd child's stdio: the standard three, and every descriptor above
 * them that an argument names by path, at the same number. A process
 * substitution (`--args-file <(…)`) hands mn /dev/fd/11; a child given only
 * 0-2 would open its own fd 11 there (nothing, or one of Node's own pipes,
 * which reads as EAGAIN), not the shell's pipe.
 */
export function reExecStdio(args: readonly string[]): Array<'inherit' | 'ignore' | number> {
  const named = new Set<number>();
  for (const arg of args) {
    // A flag given as --flag=<path> names its path after the '='.
    const path = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    const fd = DESCRIPTOR_PATH.exec(path)?.[1];
    if (fd !== undefined && Number(fd) > 2) named.add(Number(fd));
  }
  const stdio: Array<'inherit' | 'ignore' | number> = ['inherit', 'inherit', 'inherit'];
  const highest = Math.max(2, ...named);
  for (let fd = 3; fd <= highest; fd++) stdio.push(named.has(fd) ? fd : 'ignore');
  return stdio;
}

/** The subset of a child process we need to signal. */
interface Killable { kill(signal?: NodeJS.Signals): boolean; }

/**
 * Tie a re-exec'd child's lifetime to this (parent) process: forward catchable
 * termination signals (`SIGINT`/`SIGTERM`/`SIGHUP`) to it, and force-kill it on
 * any parent exit. This is what makes killing / Ctrl-C'ing the launcher always
 * take the child down instead of orphaning it (which would leave it holding e.g.
 * the `mn serve` port). `register` is injectable so the wiring is unit-testable.
 */
export function tieChildLifetime(
  child: Killable,
  register: (event: string, handler: () => void) => void = (event, handler) => { process.on(event as NodeJS.Signals, handler); },
): void {
  const forwarded: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of forwarded) {
    register(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  }
  register('exit', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
}

/**
 * Child-side watchdog: if the launcher (our parent) dies without signalling us —
 * e.g. `kill -9 <parent>` — we get reparented (ppid changes). Detect that and
 * terminate gracefully so we don't linger holding a port. Unref'd so it never
 * keeps the process alive on its own.
 */
function watchParentDeath(): void {
  const initialPpid = process.ppid;
  if (!initialPpid || initialPpid <= 1) return; // already top-level; nothing to watch
  const timer = setInterval(() => {
    if (process.ppid !== initialPpid) {
      // Reparented → launcher gone. Prefer a graceful SIGTERM (lets `serve` save
      // its cache / release the port); fall back to a hard exit if unhandled.
      try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
    }
  }, 2_000);
  timer.unref();
}
