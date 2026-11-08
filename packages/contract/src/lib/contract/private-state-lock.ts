// Waiting for a contract's private-state store another process holds.
//
// The store is a LevelDB folder, and LevelDB lets one process at a time open
// it (its LOCK file). midnight-js's level provider opens it for each read or
// write and closes it after, and refuses at once when another process has it
// open ("IO error: lock .../LOCK: Resource temporarily unavailable", code
// LEVEL_LOCKED). Two calls of one contract at the same time collided there
// and the second failed. A refused open did nothing, so the operation is run
// again once the store is free: waitForPrivateState wraps the provider so each
// operation waits, saying once that it waits and for whom, then how long,
// and gives up after PRIVATE_STATE_BUSY_WAIT_MS.
//
// Who holds it: each mn that runs a contract script writes a small file in the
// store's folder, mn-holder-<pid>.json, with its pid and its command, and
// removes it when the script ends. A waiting script names the holders whose
// process still runs. A holder that is not mn (or an mn before this one) is
// waited for all the same, unnamed.
//
// waitForPrivateState goes into the generated script with `.toString()`, so it
// imports nothing and refers to nothing outside itself: what it uses comes in
// `deps`.

/** How long an operation waits for the store: 3 minutes. A contract script holds it only while it reads or writes (seconds); 3 minutes is several other calls' turns ahead of this one, past which the holder is stuck, not busy. */
export const PRIVATE_STATE_BUSY_WAIT_MS = 180_000;

/** The code a script fails with when the store stayed busy for PRIVATE_STATE_BUSY_WAIT_MS. */
export const CONTRACT_STATE_BUSY = 'CONTRACT_STATE_BUSY';

/** Marks a line a generated script writes for mn's notices (once, as the wait starts), apart from its progress lines. */
export const SCRIPT_NOTICE_MARKER = '__MN_NOTICE__';

/** The holder file of the mn process `pid`, in the store's folder (waitForPrivateState reads the same names). */
export const holderFileName = (pid: number): string => `mn-holder-${pid}.json`;

/** An mn process that runs a contract script on the store. */
export interface PrivateStateHolder {
  pid: number;
  /** Its command, without its flags' values: `mn contract call`. */
  command: string;
}

/** The filesystem calls a holder file is written and removed with. */
export interface HolderFileDeps {
  fs: {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
    writeFileSync(path: string, data: string, options: { mode: number }): void;
    rmSync(path: string, options: { force: boolean }): void;
  };
  join(...parts: string[]): string;
}

/** Says, in the store's folder, that `holder` runs a script on it; the function returned takes that back. */
export function claimPrivateStateStore({ fs, join }: HolderFileDeps, dir: string, holder: PrivateStateHolder): () => void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, holderFileName(holder.pid));
  fs.writeFileSync(file, JSON.stringify(holder) + '\n', { mode: 0o600 });
  return () => fs.rmSync(file, { force: true });
}

/** A command as a holder file names it: the program's name and the words before the first flag, so no flag's value (a secret key) is written. */
export function holderCommandOf(argv: readonly string[]): string {
  const program = (argv[1] ?? 'mn').split(/[\\/]/).pop()!.replace(/\.(m?js|ts)$/, '');
  const words: string[] = [];
  for (const word of argv.slice(2)) {
    if (word.startsWith('-')) break;
    words.push(word);
  }
  return [program === 'wallet' || program === 'midnight' ? 'mn' : program, ...words].join(' ');
}

/** What waitForPrivateState uses. */
export interface PrivateStateWaitDeps {
  fs: {
    existsSync(path: string): boolean;
    readdirSync(path: string): string[];
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  join(...parts: string[]): string;
  /** Whether the process `pid` runs. */
  isAlive(pid: number): boolean;
  /** Milliseconds since some fixed time. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Said once, as an operation starts to wait (an mn notice). */
  notice(line: string): void;
  /** Said at each retry, with the time waited (the progress line). */
  progress(line: string): void;
}

export interface PrivateStateWaitOptions {
  /** The store's folder. */
  dir: string;
  /** The contract it is the private state of, for what the wait says; undefined for a deploy before its address is known. */
  address: string | undefined;
  /** This script's mn, whose own holder file is not another's. */
  ownPid: number;
  /** How long one operation waits before failing with CONTRACT_STATE_BUSY. */
  timeoutMs: number;
}

/**
 * The provider, each of whose operations waits while another process holds
 * the store (an open refused with LEVEL_LOCKED), retrying every 0.5 s and up
 * to every 2 s. As it starts to wait it says so (deps.notice), naming the
 * contract and the other mn processes on it, once for the script while they stay the same; then the time waited
 * (deps.progress). Past `timeoutMs` it fails with CONTRACT_STATE_BUSY.
 */
export function waitForPrivateState<P extends object>(provider: P, deps: PrivateStateWaitDeps, options: PrivateStateWaitOptions): P {
  const { dir, address, ownPid, timeoutMs } = options;
  const what = address === undefined ? 'The private state of the contract being deployed' : `Contract ${address}'s private state`;
  // What the notice last said: said again only when the store's holders differ.
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
        // The other mn processes on the store, from their holder files; a file whose process ended is left out.
        const holders: string[] = [];
        if (deps.fs.existsSync(dir)) {
          for (const file of deps.fs.readdirSync(dir)) {
            const match = /^mn-holder-(\d+)\.json$/.exec(file);
            if (match === null || Number(match[1]) === ownPid || !deps.isAlive(Number(match[1]))) continue;
            try {
              const holder = JSON.parse(deps.fs.readFileSync(deps.join(dir, file), 'utf8')) as { command?: unknown };
              holders.push(`pid ${Number(match[1])}${typeof holder.command === 'string' ? `, ${holder.command}` : ''}`);
            } catch {
              holders.push(`pid ${Number(match[1])}`);
            }
          }
        }
        const by = holders.length === 0 ? 'another process' : `another mn (${holders.join('; ')})`;
        const waited = deps.now() - started;
        if (waited >= timeoutMs) {
          throw Object.assign(new Error(
            `${what} stayed in use by ${by} for ${Math.round(waited / 1000)} s, so this mn stopped waiting for it. `
            + 'Let the other finish (or stop it if it is stuck). Its private state is read before the transaction is submitted and written after it lands, '
            + 'so check the contract\'s state (midnight contract state) before running this again.',
          ), { code: 'CONTRACT_STATE_BUSY', cause: err });
        }
        if (said !== by) {
          said = by;
          deps.notice(`${what} is in use by ${by}: waiting for it.`);
        }
        deps.progress(`Waiting for ${what.charAt(0).toLowerCase()}${what.slice(1)}, in use by ${by} (${Math.round(waited / 1000)} s)...`);
        await deps.sleep(Math.min(delay, timeoutMs - waited));
        delay = Math.min(delay * 2, 2000);
        pending = Promise.resolve().then(attempt);
      }
    }
  };
  // Each method as it is, its promise retried while the store is locked; a plain object it returns synchronously (forContract's view of one contract) wrapped the same way.
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
