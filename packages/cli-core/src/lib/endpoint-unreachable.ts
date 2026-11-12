// One way of saying that an endpoint mn needs can't be reached: which one
// (node, indexer, proof server), its URL, why in a few words, and what to
// check. The reachability check before a command starts (chain's
// endpoint-check.ts), the indexer queries and the proof errors all say it so.

import { PROOF_SERVER_DOCKER_RUN } from './constants.ts';
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

/** Where a proof server comes from: every network proves on the user's own machine. */
const PROOF_SERVER_HINT =
  `mn proves on this machine on every network. On preview, preprod and mainnet start a proof server with: ${PROOF_SERVER_DOCKER_RUN}`
  + ' (on undeployed, midnight localnet up starts one).';

/** An endpoint the command needs did not answer: NETWORK_ERROR, naming it, its URL, why, and what to check. */
export class EndpointUnreachableError extends NetworkError {
  readonly endpoint: EndpointRole;
  readonly url: string;

  constructor(endpoint: EndpointRole, url: string, reason: string, options?: { cause?: unknown }) {
    const setting = SETTING_OF[endpoint];
    super(
      `Cannot reach the ${endpoint} at ${url}: ${reason}.\n`
      + `Check that it is running and that the URL is right (--${setting}, or: midnight config set ${setting} <url>).`
      + (endpoint === 'proof server' ? `\n${PROOF_SERVER_HINT}` : ''),
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

/**
 * The proof server URL answers, but not as a proof server: its `/version`
 * doesn't give a version (another service on that port, a proxy that answers
 * everything). Refused before anything is built, rather than failing at the
 * proof.
 */
export class NotAProofServerError extends Error {
  readonly code = 'NOT_A_PROOF_SERVER';
  readonly url: string;

  constructor(url: string, answered: string) {
    super(
      `The proof server URL ${url} answers, but not as a proof server: GET ${url.replace(/\/+$/, '')}/version ${answered}.\n`
      + `Check that the URL is the proof server's (--proof-server, or: midnight config set proof-server <url>).\n${PROOF_SERVER_HINT}`,
    );
    this.url = url;
    this.name = 'NotAProofServerError';
    Object.setPrototypeOf(this, NotAProofServerError.prototype);
  }
}

/**
 * The proof server took a proof request and the connection dropped before it
 * answered, and it answers again now: it stopped mid-proof and came back, which
 * a proof server does when it runs out of memory on a large circuit (an account
 * contract's k256 circuits have prover keys of about 235 MB each). NETWORK_ERROR:
 * nothing was proven or sent, and the same command can run again.
 */
export class ProofServerDroppedError extends NetworkError {
  readonly url: string;
  readonly circuit: string | undefined;

  constructor(url: string, reason: string, circuit: string | undefined, options?: { cause?: unknown }) {
    super(
      `The proof server at ${url} dropped the connection while proving ${circuit === undefined ? 'the transaction' : `circuit '${circuit}'`} (${reason}), and answers again now: `
      + 'it most likely stopped mid-proof and restarted, which a proof server does when it runs out of memory on a large circuit. Nothing was sent.\n'
      + 'Check its logs and its memory limit (docker logs / docker stats on its container), then run the command again.',
      options,
    );
    this.url = url;
    this.circuit = circuit;
    this.name = 'ProofServerDroppedError';
    Object.setPrototypeOf(this, ProofServerDroppedError.prototype);
  }
}
