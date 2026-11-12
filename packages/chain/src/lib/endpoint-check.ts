// Asked before a wallet sync starts: the wallet SDK retries an endpoint that
// refuses it without saying why, so mn finds out first. The endpoints mn
// connects to itself are checked where the connection is made.
//
// And asked before a command starts its work: whether the endpoints it needs
// answer at all. The wallet SDK retries an endpoint it can't reach for as long
// as it is let (a transfer waited 92 s for a SYNC_TIMEOUT, mn serve for ever),
// and a dead proof server showed only after the sync. One check, a few seconds
// at most, names the endpoint that failed and what to check.

import WebSocket from 'ws';
import { checkLedgerSupported, fetchProtocolVersion } from './ledger-guard.ts';
import { assertEndpointUsable, endpointRefusal, endpointRefusalFromWsError, endpointUnreachable, isBlockfrostUrl, throwIfCancelled, CancelledError, NotAProofServerError, type EndpointRole, type NetworkConfig } from '@kuiralabs/midnight-cli-core';

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Throws when the network's endpoints can't serve a sync: one was shut down,
 * Blockfrost has no project id to go with, or it refuses the one it is given
 * (asked with one small query; the node takes the same project id). An
 * endpoint that simply can't be reached is left to the sync to report.
 */
export async function assertNetworkAnswers(
  network: Pick<NetworkConfig, 'indexer' | 'indexerWS' | 'node'>,
  request: typeof fetch = fetch,
): Promise<void> {
  for (const url of [network.indexer, network.indexerWS, network.node]) assertEndpointUsable(url);
  if (!isBlockfrostUrl(network.indexer)) return;

  let status: number;
  try {
    const response = await request(network.indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    return;
  }
  const refusal = endpointRefusal(network.indexer, status);
  if (refusal !== undefined) throw refusal;
}

/** How long each endpoint has to answer the reachability check. */
export const REACHABILITY_TIMEOUT_MS = 5_000;

/** The endpoints a command needs: the indexer's (HTTP) URL, the node's and the proof server's. */
export interface NeededEndpoints {
  readonly indexer?: string;
  readonly node?: string;
  readonly proofServer?: string;
}

export interface ReachabilityOptions {
  /** Cancels the check: it fails with CancelledError. */
  readonly signal?: AbortSignal;
  /** How long each endpoint has to answer; REACHABILITY_TIMEOUT_MS when not given. */
  readonly timeoutMs?: number;
  /** The HTTP client for the indexer and proof server; the runtime's fetch when not given. */
  readonly request?: typeof fetch;
}

/**
 * What a probe found: nothing wrong, the endpoint's own error (it can't be
 * used as configured, refused the upgrade, or the check was cancelled), or
 * why it couldn't be reached. Kept apart by the probe, because the runtimes
 * shape a transport failure differently (Node's fetch throws a TypeError with
 * the reason as its cause, Bun's an Error with code "ConnectionRefused").
 */
type ProbeOutcome = undefined | { readonly refused: Error } | { readonly unreachable: unknown };

/**
 * The endpoints `network` has that `needs` names (by default the indexer and
 * the node; the proof server for a command that proves).
 */
export function endpointsOf(network: Pick<NetworkConfig, 'indexer' | 'node' | 'proofServer'>, needs: { proofServer?: boolean; node?: boolean } = {}): NeededEndpoints {
  return {
    indexer: network.indexer,
    ...(needs.node === false ? {} : { node: network.node }),
    ...(needs.proofServer === true ? { proofServer: network.proofServer } : {}),
  };
}

/**
 * Throws, within a few seconds, when an endpoint the command needs doesn't
 * answer: an EndpointUnreachableError (NETWORK_ERROR) naming it, its URL and
 * why, for the first of them in the order indexer, node, proof server. The
 * node counts as answering when it takes a WebSocket upgrade. The indexer
 * when it answers a query with a status below 500: a 502 is a gateway with no
 * indexer behind it, and a sync against it waits out its deadline. The proof
 * server when its `/version` gives a version; one that answers something else
 * isn't a proof server (NotAProofServerError, NOT_A_PROOF_SERVER). An
 * endpoint that can't be used as configured (shut down, Blockfrost without a
 * project id or refusing it) or refuses the upgrade throws that endpoint's
 * own error.
 */
export async function assertEndpointsReachable(needed: NeededEndpoints, options: ReachabilityOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? REACHABILITY_TIMEOUT_MS;
  const request = options.request ?? fetch;
  const probes: Array<[EndpointRole, string, Promise<ProbeOutcome>]> = [];
  if (needed.indexer !== undefined) probes.push(['indexer', needed.indexer, probeHttp(request, needed.indexer, 'POST', timeoutMs, options.signal, indexerAnswer)]);
  if (needed.node !== undefined) probes.push(['node', needed.node, probeWebSocket(needed.node, timeoutMs, options.signal)]);
  if (needed.proofServer !== undefined) probes.push(['proof server', needed.proofServer, probeHttp(request, versionUrlOf(needed.proofServer), 'GET', timeoutMs, options.signal, proofServerAnswer(needed.proofServer))]);
  const outcomes = await Promise.all(probes.map(([, , probe]) => probe));
  throwIfCancelled(options.signal);
  for (let i = 0; i < probes.length; i++) {
    const outcome = outcomes[i];
    if (outcome === undefined) continue;
    if ('refused' in outcome) throw outcome.refused;
    const [role, url] = probes[i]!;
    throw endpointUnreachable(role, url, outcome.unreachable);
  }
}

/** What an answer of an HTTP endpoint makes it: as good as answering (undefined), its own error, or a reason it can't serve. */
type AnswerCheck = (url: string, response: Response) => Promise<ProbeOutcome>;

/** A status in words: "HTTP 502 Bad Gateway". */
function statusText(response: Response): string {
  return `HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`;
}

/**
 * The indexer answers when its status is below 500 (what a 4xx says is for the
 * command's own query to read). A Blockfrost refusal is that error; a 5xx is a
 * gateway or server with no indexer serving behind it.
 */
const indexerAnswer: AnswerCheck = async (url, response) => {
  await response.body?.cancel().catch(() => {});
  const refusal = endpointRefusal(url, response.status);
  if (refusal !== undefined) return { refused: refusal };
  return response.status >= 500 ? { unreachable: new Error(`it answered ${statusText(response)}, so no indexer is serving there`) } : undefined;
};

/** A proof server's `/version` body: "9.0.0". */
const VERSION_BODY = /^\d+\.\d+\.\d+\S*$/;

/** The longest `/version` body quoted back. */
const QUOTED_BODY_CHARS = 60;

/** The proof server's `/version` URL. */
function versionUrlOf(proofServerUrl: string): string {
  return `${proofServerUrl.replace(/\/+$/, '')}/version`;
}

/** The proof server answers when its `/version` gives a version; a 5xx is a server that can't serve; anything else isn't a proof server. */
function proofServerAnswer(proofServerUrl: string): AnswerCheck {
  return async (_url, response) => {
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      return { unreachable: new Error(`it answered ${statusText(response)}`) };
    }
    const body = (await response.text().catch(() => '')).trim();
    if (response.ok && VERSION_BODY.test(body)) return undefined;
    const quoted = body === '' ? 'nothing' : JSON.stringify(body.length > QUOTED_BODY_CHARS ? `${body.slice(0, QUOTED_BODY_CHARS)}…` : body);
    return { refused: new NotAProofServerError(proofServerUrl, `answered ${statusText(response)} with ${quoted}, not a version`) };
  };
}

/** Undefined when the URL answers an HTTP request as `check` wants it to; else why it didn't. */
async function probeHttp(request: typeof fetch, url: string, method: 'GET' | 'POST', timeoutMs: number, signal: AbortSignal | undefined, check: AnswerCheck): Promise<ProbeOutcome> {
  try {
    assertEndpointUsable(url);
  } catch (err) {
    return { refused: err as Error };
  }
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await request(url, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ __typename }' }) } : {}),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
    return await check(url, response);
  } catch (err) {
    return signal?.aborted === true ? { refused: new CancelledError() } : { unreachable: err };
  }
}

/** Undefined when the URL accepts a WebSocket connection; else why it didn't. */
function probeWebSocket(url: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    try {
      assertEndpointUsable(url);
    } catch (err) {
      resolve({ refused: err as Error });
      return;
    }
    if (signal?.aborted === true) { resolve({ refused: new CancelledError() }); return; }
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      ws.removeAllListeners();
      // A socket that never opened is torn down; an open one is closed.
      ws.on('error', () => {});
      try { if (ws.readyState === WebSocket.CONNECTING) ws.terminate(); else ws.close(); } catch { /* already gone */ }
      resolve(outcome);
    };
    const onAbort = (): void => finish({ refused: new CancelledError() });
    const timer = setTimeout(() => finish({ unreachable: Object.assign(new Error(`no answer within ${timeoutMs / 1000} s`), { name: 'TimeoutError' }) }), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.on('open', () => finish(undefined));
    ws.on('error', (err) => { const refusal = endpointRefusalFromWsError(url, err); finish(refusal === undefined ? { unreachable: err } : { refused: refusal }); });
  });
}

/**
 * What a wallet operation asks before it syncs: the chain is on ledger 9
 * (UNSUPPORTED_LEDGER when the indexer says otherwise), and the endpoints it
 * needs answer (assertEndpointsReachable).
 */
export async function assertNetworkReady(
  networkName: string,
  network: Pick<NetworkConfig, 'indexer' | 'node' | 'proofServer'>,
  needs: { proofServer?: boolean; node?: boolean } = {},
  options: ReachabilityOptions = {},
): Promise<void> {
  checkLedgerSupported(networkName, await fetchProtocolVersion(network.indexer, options.signal));
  await assertEndpointsReachable(endpointsOf(network, needs), options);
}
