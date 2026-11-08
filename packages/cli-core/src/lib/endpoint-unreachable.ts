// One way of saying that an endpoint mn needs can't be reached: which one
// (node, indexer, proof server), its URL, why in a few words, and what to
// check. The reachability check before a command starts (chain's
// endpoint-check.ts), the indexer queries and the proof errors all say it so.

import { NetworkError } from './errors.ts';

/** An endpoint a network has. */
export type EndpointRole = 'node' | 'indexer' | 'proof server';

/** The flag, and the config key, that set each endpoint. */
const SETTING_OF: Readonly<Record<EndpointRole, string>> = { node: 'node', indexer: 'indexer-ws', 'proof server': 'proof-server' };

/** A transport's codes, in words. */
const REASON_OF_CODE: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'no such host',
  EAI_AGAIN: 'no such host (DNS lookup failed)',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  // Bun's fetch: its one code for a refused connection and a host that doesn't resolve.
  ConnectionRefused: 'cannot connect (connection refused, or no such host)',
};

/** Messages that say nothing about the failure: fetch's own, and an event turned into a string. */
const EMPTY_MESSAGE = /^(fetch failed|\[object \w+\]|)$/i;

/**
 * Why a connection failed, in a few words: from a transport's code on the
 * failure or its causes (connection refused, no such host), a timeout's name,
 * or else the first message that says something.
 */
export function transportReason(failure: unknown): string {
  const seen = new Set<unknown>();
  const pending: unknown[] = [failure];
  let said: string | undefined;
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; error?: unknown; errors?: unknown };
    if (typeof e.code === 'string' && REASON_OF_CODE[e.code] !== undefined) return REASON_OF_CODE[e.code]!;
    if (e.name === 'TimeoutError') return 'no answer in time';
    if (said === undefined && typeof e.message === 'string' && !EMPTY_MESSAGE.test(e.message.trim())) said = e.message.trim();
    pending.push(e.cause, e.error, ...(Array.isArray(e.errors) ? e.errors : []));
  }
  return said ?? 'the connection failed';
}

/** An endpoint the command needs did not answer: NETWORK_ERROR, naming it, its URL, why, and what to check. */
export class EndpointUnreachableError extends NetworkError {
  readonly endpoint: EndpointRole;
  readonly url: string;

  constructor(endpoint: EndpointRole, url: string, reason: string, options?: { cause?: unknown }) {
    const setting = SETTING_OF[endpoint];
    super(
      `Cannot reach the ${endpoint} at ${url}: ${reason}.\n`
      + `Check that it is running and that the URL is right (--${setting}, or: midnight config set ${setting} <url>).`,
      options,
    );
    this.endpoint = endpoint;
    this.url = url;
    this.name = 'EndpointUnreachableError';
    Object.setPrototypeOf(this, EndpointUnreachableError.prototype);
  }
}

/** The failure to reach `url`, as an EndpointUnreachableError with the failure as its cause. */
export function endpointUnreachable(endpoint: EndpointRole, url: string, failure: unknown): EndpointUnreachableError {
  return new EndpointUnreachableError(endpoint, url, transportReason(failure), { cause: failure });
}
