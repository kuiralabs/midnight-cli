// One contract call at a time on a contract's private-state store.
//
// The store is a LevelDB folder that midnight-js's level provider opens for
// each read or write and closes after. A call reads the contract's private
// state before it builds its transaction and writes the new state after the
// transaction lands, so two calls at once would each read the same state and
// the second write would lose the first's update. A call therefore holds the
// store's call lock (CALL_LOCK_FILE in its folder) for the whole run of its
// script: acquireContractCallLock waits for it, says once that it waits and
// for whom, then how long, and gives up after PRIVATE_STATE_BUSY_WAIT_MS.
//
// The lock is a file created exclusively (Node has no flock without a native
// module), holding the holder's pid and command. A lock whose process ended
// (an mn that crashed) is taken over at once.
//
// An mn before this one takes no call lock; LevelDB still refuses it the
// folder while one of its reads or writes runs (code LEVEL_LOCKED), and an
// operation refused that way did nothing. waitForPrivateState wraps the
// script's providers so such an operation waits too, the same way.
//
// waitForPrivateState and privateStateBusyText go into the generated script
// with `.toString()`, so they import nothing and refer to nothing outside
// themselves: what they use comes in `deps`.

import { acquireProcessLock, type LockHolder, type ProcessLockDeps } from '@kuiralabs/midnight-cli-core';

export { holderCommandOf, processIsAlive } from '@kuiralabs/midnight-cli-core';

/** How long a call waits for the store: 3 minutes. A call holds it for its own run (its proof, its submit, the block it lands in: under a minute on a local chain), so 3 minutes is several calls' turns ahead of this one, past which the holder is stuck, not busy. */
export const PRIVATE_STATE_BUSY_WAIT_MS = 180_000;

/** The code a call fails with when the store stayed busy for PRIVATE_STATE_BUSY_WAIT_MS. */
export const CONTRACT_STATE_BUSY = 'CONTRACT_STATE_BUSY';

/** Marks a line a generated script writes for mn's notices (once, as a wait starts), apart from its progress lines. */
export const SCRIPT_NOTICE_MARKER = '__MN_NOTICE__';

/** The call lock's file in the store's folder (waitForPrivateState reads the same name). */
export const CALL_LOCK_FILE = 'mn-call.lock';

/** An mn process that holds the store's call lock. */
export type PrivateStateHolder = LockHolder;

/** What a wait for the store says: the notice as it starts, the progress line, and the failure past the wait. `what` names the private state, `by` its holder. */
export function privateStateBusyText(kind: 'notice' | 'progress' | 'busy', what: string, by: string, waitedMs: number): string {
  const seconds = Math.round(waitedMs / 1000);
  if (kind === 'notice') return `${what} is in use by ${by}: waiting for it.`;
  if (kind === 'progress') return `Waiting for ${what.charAt(0).toLowerCase()}${what.slice(1)}, in use by ${by} (${seconds} s)...`;
  return `${what} stayed in use by ${by} for ${seconds} s, so this mn stopped waiting for it. `
    + 'Let the other finish (or stop it if it is stuck). Its private state is read before the transaction is submitted and written after it lands, '
    + "so check the contract's state (midnight contract state) before running this again.";
}

/** How the store's private state is named in what a wait says. */
export const privateStateNameOf = (address: string | undefined): string =>
  address === undefined ? 'The private state of the contract being deployed' : `Contract ${address}'s private state`;

/** A contract's private-state store stayed in use by another process for as long as a call waits for it (PRIVATE_STATE_BUSY_WAIT_MS). */
export class ContractStateBusyError extends Error {
  readonly code = 'CONTRACT_STATE_BUSY';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContractStateBusyError';
    Object.setPrototypeOf(this, ContractStateBusyError.prototype);
  }
}

/** What the call lock is taken with. */
export type CallLockDeps = Omit<ProcessLockDeps, 'dirname'>;

export interface CallLockOptions {
  /** The contract, for what the wait says. */
  address: string;
  timeoutMs: number;
  /** Said once as the wait starts, and again for another holder. */
  notice(line: string): void;
  /** Said at each retry, with the time waited. */
  progress(line: string): void;
  signal?: AbortSignal;
}

/**
 * Takes the call lock of the store in `dir` for `holder`, waiting while
 * another live process holds it; the function returned lets it go. A lock
 * whose process ended is taken over at once. Fails with
 * ContractStateBusyError past `timeoutMs`, and with CancelledError at once
 * when `signal` aborts.
 */
export async function acquireContractCallLock(deps: CallLockDeps, dir: string, holder: PrivateStateHolder, options: CallLockOptions): Promise<() => void> {
  const what = privateStateNameOf(options.address);
  const lock = await acquireProcessLock({ ...deps, dirname: () => dir }, deps.join(dir, CALL_LOCK_FILE), holder, {
    timeoutMs: options.timeoutMs,
    notice: (by) => options.notice(privateStateBusyText('notice', what, by, 0)),
    progress: (by, waited) => options.progress(privateStateBusyText('progress', what, by, waited)),
    timedOut: (by, waited) => new ContractStateBusyError(privateStateBusyText('busy', what, by, waited)),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return lock.release;
}

/** What waitForPrivateState uses. */
export interface PrivateStateWaitDeps {
  fs: {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  join(...parts: string[]): string;
  /** Whether the process `pid` runs. */
  isAlive(pid: number): boolean;
  /** Milliseconds since some fixed time. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** privateStateBusyText. */
  text(kind: 'notice' | 'progress' | 'busy', what: string, by: string, waitedMs: number): string;
  /** Said once, as an operation starts to wait (an mn notice). */
  notice(line: string): void;
  /** Said at each retry, with the time waited (the progress line). */
  progress(line: string): void;
}

export interface PrivateStateWaitOptions {
  /** The store's folder. */
  dir: string;
  /** The private state, as what a wait says names it (privateStateNameOf). */
  what: string;
  /** This script's mn, which holds the call lock itself. */
  ownPid: number;
  /** How long one operation waits before failing with CONTRACT_STATE_BUSY. */
  timeoutMs: number;
}

/**
 * The provider, each of whose operations waits while another process holds
 * the store's folder (an open refused with LEVEL_LOCKED: an mn that takes no
 * call lock), retrying every 0.5 s and up to every 2 s. As it starts to wait
 * it says so (deps.notice), naming the call lock's holder if it is another
 * live mn, once while the holder stays the same; then the time waited
 * (deps.progress). Past `timeoutMs` it fails with CONTRACT_STATE_BUSY.
 */
export function waitForPrivateState<P extends object>(provider: P, deps: PrivateStateWaitDeps, options: PrivateStateWaitOptions): P {
  const { dir, what, ownPid, timeoutMs } = options;
  // What the notice last said: said again only when the holder differs.
  let said: string | undefined;
  // Runs `attempt` again while its promise is refused with LEVEL_LOCKED (a refused open did nothing).
  const retrying = async (first: Promise<unknown>, attempt: () => unknown): Promise<unknown> => {
    const started = deps.now();
    let delay = 500;
    let pending = first;
    for (;;) {
      try {
        return await pending;
      } catch (err) {
        // Refused because the folder is locked: LEVEL_LOCKED, on the open's error or one of its causes.
        let locked = false;
        const seen = new Set<unknown>();
        for (let current: unknown = err; current !== null && typeof current === 'object' && !seen.has(current); current = (current as { cause?: unknown }).cause) {
          seen.add(current);
          if ((current as { code?: unknown }).code === 'LEVEL_LOCKED') locked = true;
        }
        if (!locked) throw err;
        // The call lock's holder, when it is another live mn.
        let by = 'another process';
        try {
          const lock = JSON.parse(deps.fs.readFileSync(deps.join(dir, 'mn-call.lock'), 'utf8')) as { pid?: unknown; command?: unknown };
          if (typeof lock.pid === 'number' && lock.pid !== ownPid && deps.isAlive(lock.pid)) {
            by = `another mn (pid ${lock.pid}${typeof lock.command === 'string' ? `, ${lock.command}` : ''})`;
          }
        } catch { /* no lock: an mn that takes none, or another program */ }
        const waited = deps.now() - started;
        if (waited >= timeoutMs) throw Object.assign(new Error(deps.text('busy', what, by, waited)), { code: 'CONTRACT_STATE_BUSY', cause: err });
        if (said !== by) {
          said = by;
          deps.notice(deps.text('notice', what, by, waited));
        }
        deps.progress(deps.text('progress', what, by, waited));
        await deps.sleep(Math.min(delay, timeoutMs - waited));
        delay = Math.min(delay * 2, 2000);
        pending = Promise.resolve().then(attempt);
      }
    }
  };
  // Each method as it is, its promise retried while the folder is locked; a plain object it returns synchronously (forContract's view of one contract) wrapped the same way.
  const wrap = <T extends object>(object: T): T => new Proxy(object, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const attempt = () => value.apply(target, args);
        const result = attempt();
        if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') return retrying(result as Promise<unknown>, attempt);
        // Only a plain object (a typed array or a class instance keeps its own internals unproxied).
        return result !== null && typeof result === 'object' && Object.getPrototypeOf(result) === Object.prototype ? wrap(result) : result;
      };
    },
  });
  return wrap(provider);
}
