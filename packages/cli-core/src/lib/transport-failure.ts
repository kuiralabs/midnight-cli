// A connection that could not be made (refused, a host not found, timed out),
// recognised where mn meets code that doesn't name its failures: the engine
// boundary (sdk-errors.ts), a contract script's process, and grant's account
// package. Classification itself reads only an error's code.

import { NetworkError, throwIfCancelled } from './errors.ts';
import { sleep } from './sleep.ts';

/**
 * Whether the failure is a connection that could not be made: a transport's
 * code for it (ECONNREFUSED, ENOTFOUND, ETIMEDOUT) on the failure or among its
 * causes, an ErrorEvent's error or an AggregateError's members (where fetch
 * keeps them); or the words the SDK and its transports say it with in the
 * failure's own message ("fetch failed", a WebSocket error, node-fetch's
 * "request to … failed, reason:"). Self-contained, with nothing from outside
 * its body: a contract script's prelude carries it as its source text.
 */
export function isTransportFailure(failure: unknown): boolean {
  const TRANSPORT_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'];
  const TRANSPORT_WORDS = ['econnrefused', 'enotfound', 'etimedout', 'websocket', 'connection refused', 'fetch failed'];
  const seen = new Set<unknown>();
  const pending: unknown[] = [failure];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as { code?: unknown; cause?: unknown; error?: unknown; errors?: unknown };
    if (typeof e.code === 'string' && TRANSPORT_CODES.includes(e.code)) return true;
    pending.push(e.cause, e.error, ...(Array.isArray(e.errors) ? e.errors : []));
  }
  let message = '';
  try {
    const said = (failure as { message?: unknown } | null)?.message;
    message = typeof said === 'string' ? said.toLowerCase() : '';
  } catch { /* a message that can't be read says nothing */ }
  return TRANSPORT_WORDS.some((word) => message.includes(word))
    || /request to \S+ failed, reason:/.test(message)
    || (message.includes('network') && message.includes('error'));
}

/** Whether the failure carries a code of its own: a string `code` that is not a transport's (ECONNREFUSED is the socket's, not mn's). */
export function carriesOwnCode(failure: unknown): boolean {
  const code = failure !== null && typeof failure === 'object' ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' && !isTransportFailure({ code });
}

/**
 * The failure as reported at a boundary with no engine (grant's account
 * package): a transport failure that carries no code of its own as a
 * NetworkError, with its message and the failure as its cause; anything else
 * as it is.
 */
export function withTransportCode(err: unknown): unknown {
  if (!(err instanceof Error) || carriesOwnCode(err) || !isTransportFailure(err)) return err;
  return new NetworkError(err.message, { cause: err });
}

/**
 * Whether the failure is a connection that failed and may answer moments
 * later: a NETWORK_ERROR (a WebSocket dropped mid-stream, an upgrade answered
 * 502), or a transport failure that carries no code of its own. An endpoint's
 * own refusal (a Blockfrost project id refused, a host shut down) carries its
 * own code and is not.
 */
export function isTransientNetworkFailure(failure: unknown): boolean {
  const code = failure !== null && typeof failure === 'object' ? (failure as { code?: unknown }).code : undefined;
  if (code === 'NETWORK_ERROR') return true;
  return !carriesOwnCode(failure) && isTransportFailure(failure);
}

/** The waits before each retry of a read whose connection failed: about 15 s in all, enough for an indexer that blinked. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

export interface TransientRetryOptions {
  /** Cancels the waits: CancelledError. */
  readonly signal?: AbortSignal;
  /** The waits before each retry; TRANSIENT_RETRY_DELAYS_MS when not given. */
  readonly delaysMs?: readonly number[];
  /** Told before each retry: the failure, which retry this is (from 1), of how many, and the wait before it. */
  readonly onRetry?: (failure: unknown, retry: number, retries: number, delayMs: number) => void;
}

/**
 * What `attempt` gives, run again after a wait each time it fails with a
 * transient network failure (isTransientNetworkFailure), as many times as
 * there are waits; any other failure, or the last one, is thrown. For reads
 * that resume from their own checkpoint, so a retry repeats no work.
 */
export async function retryingTransient<T>(attempt: () => Promise<T>, options: TransientRetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (failure) {
      throwIfCancelled(options.signal);
      if (retry >= delays.length || !isTransientNetworkFailure(failure)) throw failure;
      const delayMs = delays[retry]!;
      options.onRetry?.(failure, retry + 1, delays.length, delayMs);
      await sleep(delayMs, options.signal);
    }
  }
}
