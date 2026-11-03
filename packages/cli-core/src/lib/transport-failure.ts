// A connection that could not be made (refused, a host not found, timed out),
// recognised where mn meets code that doesn't name its failures: the engine
// boundary (sdk-errors.ts), a contract script's process, and grant's account
// package. Classification itself reads only an error's code.

import { NetworkError } from './errors.ts';

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
