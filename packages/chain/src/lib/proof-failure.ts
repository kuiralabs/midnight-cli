// The wallet SDK reports every failed proof as "Failed to prove transaction",
// and midnight-js as "proveTx rejected the transaction": a proof server that
// is down, one that dropped the connection mid-proof, and one that refused the
// proof read the same, with no URL. Where mn knows the proof server's URL it
// says which it was.

import { EndpointUnreachableError, ProofFailureError, ProofServerDroppedError, transportReason } from '@kuiralabs/midnight-cli-core';
import { assertEndpointsReachable } from './endpoint-check.ts';

/** The SDK's own wrappers, which say nothing of the cause. */
const WRAPPERS: readonly string[] = ['failed to prove transaction', 'failed to prove'];

/** Where an Effect `FiberFailure` (what an SDK promise rejects with) keeps the failure it ran into, off its `cause`. */
const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');

/**
 * The words a proof request's connection failed with: the SDK's "Failed to
 * connect to Proof Server: Transport error (POST …/prove)" (said for a refused
 * connection and for one dropped mid-request alike), and fetch's and
 * node-fetch's, which midnight-js's proof provider reports.
 */
const TRANSPORT_FAILED = /failed to connect to proof server|transport error|socket hang up|econnreset|econnrefused|other side closed|fetch failed|request to \S+ failed|proof server request failed|connection reset|terminated/i;

/** The messages under the SDK's wrappers, outermost first, each once: along `cause`, and into an Effect failure's. */
function causesSaid(err: unknown): string[] {
  const said: string[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as Record<PropertyKey, unknown>;
    const text = typeof e.message === 'string' ? e.message.trim() : '';
    if (text !== '' && !WRAPPERS.includes(text.toLowerCase()) && !said.includes(text)) said.push(text);
    pending.push(e.cause, e[FIBER_FAILURE_CAUSE], e.error, e.defect, e.left, e.right);
  }
  return said;
}

/** midnight-js's report of a failed proof: its ProviderFailedError for the proveTx method, with the circuit(s) it ran. */
function proveProviderFailureOf(err: unknown): { circuit: string | undefined } | undefined {
  const e = err as { name?: unknown; method?: unknown; circuitId?: unknown } | null;
  if (e === null || typeof e !== 'object' || e.name !== 'ProviderFailedError' || e.method !== 'proveTx') return undefined;
  const circuit = Array.isArray(e.circuitId) ? e.circuitId.join(', ') : typeof e.circuitId === 'string' ? e.circuitId : undefined;
  return { circuit };
}

/**
 * A failed proof as what it was, when the proof server is at `proofServerUrl`:
 * the SDK's PROOF_FAILURE, or midnight-js's proveTx failure (`circuit` named
 * from it, or as given). One whose connection failed is a NETWORK_ERROR
 * naming the proof server: it can't be reached now (EndpointUnreachableError),
 * or it answers again and dropped the connection mid-proof
 * (ProofServerDroppedError); neither is a stale wallet state. One the proof
 * server answered and refused is a PROOF_FAILURE naming it and what it said.
 * Any other error is returned as it is.
 */
export async function explainProofFailure(err: unknown, proofServerUrl: string, signal?: AbortSignal, circuit?: string): Promise<unknown> {
  const provider = proveProviderFailureOf(err);
  const isProofFailure = provider !== undefined || (err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'PROOF_FAILURE');
  if (!isProofFailure) return err;
  const proving = circuit ?? provider?.circuit;
  const said = causesSaid(err);
  const transport = said.find((text) => TRANSPORT_FAILED.test(text));
  try {
    await assertEndpointsReachable({ proofServer: proofServerUrl }, { signal });
  } catch (unreachable) {
    if (!(unreachable instanceof EndpointUnreachableError)) throw unreachable;
    if (proving === undefined) return unreachable;
    return new EndpointUnreachableError('proof server', proofServerUrl, `${transportReason(unreachable.cause)}; it stopped answering while proving circuit '${proving}'`, { cause: err });
  }
  // The SDK's text can carry a stack after its first line: the reason is that line, from the transport's own words on.
  if (transport !== undefined) return new ProofServerDroppedError(proofServerUrl, transport.split('\n')[0]!.replace(/^.*?failed to connect to proof server:\s*/i, '').trim(), proving, { cause: err });
  const detail = said.filter((text) => provider === undefined || !text.startsWith('proveTx rejected the transaction')).join(': ');
  return new ProofFailureError(
    `The proof server at ${proofServerUrl} refused to prove ${proving === undefined ? 'the transaction' : `circuit '${proving}'`}${detail === '' ? '' : `: ${detail}`}.\n`
    + 'Check the proof server\'s logs and that its version fits the chain; a wallet state out of step with the chain does this too (midnight cache clear --wallet <name>, then retry).',
    { cause: err },
  );
}
