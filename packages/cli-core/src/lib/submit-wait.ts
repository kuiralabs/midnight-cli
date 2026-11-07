// Proving and submitting a transaction, as far as the call waits for them.
//
// A proof is local work: a call cancelled while it runs stops waiting and
// says so; nothing was sent. A submit is not: the wallet SDK's submit waits
// for the node to finalize the transaction, and against a node that went away
// it never returns (polkadot-js reconnects for ever). So the wait is bounded:
// the node is asked every few seconds whether it still answers, and the call
// waits SUBMIT_WAIT_MS at most. A submit cut short (the node gone, the
// deadline, a cancel) says the transaction may still land, with its
// identifier for `midnight tx status`.

import { CancelledError, NetworkError, ProofTimeoutError, SyncTimeoutError } from './errors.ts';

/** How long a call waits for the node to finalize a submitted transaction (12 to 30 s typically). */
export const SUBMIT_WAIT_MS = 180_000;
/** How often a submit's wait asks the node whether it still answers. */
export const SUBMIT_NODE_CHECK_MS = 10_000;
/** How long the node has to accept that connection. */
const NODE_CHECK_TIMEOUT_MS = 5_000;

/** Waits for `work` until `timeoutMs` passes (`onTimeout` is thrown then) or `signal` aborts (`onCancel`); clears its timer either way. */
function waitBounded<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, onTimeout: () => Error, onCancel: () => Error, watch?: (fail: (err: Error) => void) => () => void): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(onCancel());
  return new Promise<T>((resolve, reject) => {
    let unwatch = (): void => {};
    const finish = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); unwatch(); };
    const fail = (err: Error): void => { finish(); reject(err); };
    const cancel = (): void => fail(onCancel());
    const timer = setTimeout(() => fail(onTimeout()), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (watch !== undefined) unwatch = watch(fail);
    work.then((value) => { finish(); resolve(value); }, (err: unknown) => { finish(); reject(err); });
  });
}

/** The proof `work` makes, within `timeoutMs` (ProofTimeoutError after); CancelledError at once when `signal` aborts: nothing was sent. */
export function proveWithin<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return waitBounded(work, timeoutMs, signal, () => new ProofTimeoutError(), () => new CancelledError());
}

/** Whether the node at `url` accepts a WebSocket connection within `timeoutMs`. */
export function nodeAnswers(url: string, timeoutMs: number = NODE_CHECK_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (answers: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      try { socket.close(); } catch { /* already closed */ }
      resolve(answers);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.onopen = () => done(true);
    socket.onerror = () => done(false);
  });
}

export interface SubmitWaitOptions {
  /** The transaction's identifier, for `midnight tx status`. */
  readonly txId?: string;
  /** The node it is submitted to: asked every SUBMIT_NODE_CHECK_MS whether it still answers, and named when it doesn't. */
  readonly node?: string;
  /** How long to wait at most; SUBMIT_WAIT_MS when not given. */
  readonly timeoutMs?: number;
  /** How often to ask the node; SUBMIT_NODE_CHECK_MS when not given. */
  readonly nodeCheckMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * The submit `work` makes, waited for as long as the node answers and
 * `timeoutMs` at most. A node that stops answering is a NetworkError naming
 * it; past the deadline, a SyncTimeoutError; cancelled, a CancelledError:
 * each saying the transaction may still land and how to check.
 */
export function submitWithin<T>(work: Promise<T>, options: SubmitWaitOptions = {}): Promise<T> {
  const { txId, node, signal } = options;
  const timeoutMs = options.timeoutMs ?? SUBMIT_WAIT_MS;
  const check = txId === undefined ? '' : ` Check with: midnight tx status ${txId}`;
  const at = node === undefined ? 'The node' : `The node at ${node}`;
  const watchNode = node === undefined ? undefined : (fail: (err: Error) => void): (() => void) => {
    let stopped = false;
    const ask = async (): Promise<void> => {
      if (stopped) return;
      if (!(await nodeAnswers(node))) {
        if (!stopped) fail(new NetworkError(`${at} stopped answering while the transaction was submitted: it may have been sent and may still land.${check}\nCheck that the node is running and that the URL is right (--node, or: midnight config set node <url>).`));
        return;
      }
      if (!stopped) timer = setTimeout(() => { void ask(); }, options.nodeCheckMs ?? SUBMIT_NODE_CHECK_MS);
    };
    let timer = setTimeout(() => { void ask(); }, options.nodeCheckMs ?? SUBMIT_NODE_CHECK_MS);
    return () => { stopped = true; clearTimeout(timer); };
  };
  return waitBounded(
    work,
    timeoutMs,
    signal,
    () => new SyncTimeoutError(`${at} did not confirm the transaction within ${Math.round(timeoutMs / 1000)} s: it was sent and may still land.${check}`),
    () => new CancelledError(`Cancelled while the transaction was being submitted: it was sent and may still land.${check}`),
    watchNode,
  );
}
