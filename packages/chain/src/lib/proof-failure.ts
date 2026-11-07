// The wallet SDK reports every failed proof as "Failed to prove transaction":
// a proof server that is down and one that refused the proof read the same,
// with no URL. Where mn knows the proof server's URL it says which it was.

import { EndpointUnreachableError, ProofFailureError } from '@kuiralabs/midnight-cli-core';
import { assertEndpointsReachable } from './endpoint-check.ts';

/** The SDK's own wrappers, which say nothing of the cause. */
const WRAPPERS: readonly string[] = ['failed to prove transaction', 'failed to prove'];
/** The SDK's words for a proof server it could not connect to. */
const CONNECT_FAILED = /^Failed to connect to Proof Server:\s*/i;

/** The messages under the SDK's wrappers, outermost first, each once. */
function causesSaid(err: unknown): string[] {
  const said: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    const text = typeof message === 'string' ? message.trim() : '';
    if (text !== '' && !WRAPPERS.includes(text.toLowerCase()) && !said.includes(text)) said.push(text);
    current = (current as { cause?: unknown }).cause;
  }
  return said;
}

/**
 * A PROOF_FAILURE as what it was, when the proof server is at `proofServerUrl`:
 * a NETWORK_ERROR naming the proof server when it can't be reached (now, or
 * when the SDK tried), else a PROOF_FAILURE naming the proof server and what
 * it said. Any other error is returned as it is.
 */
export async function explainProofFailure(err: unknown, proofServerUrl: string, signal?: AbortSignal): Promise<unknown> {
  if (err === null || typeof err !== 'object' || (err as { code?: unknown }).code !== 'PROOF_FAILURE') return err;
  const said = causesSaid(err);
  const connectFailure = said.find((text) => CONNECT_FAILED.test(text));
  if (connectFailure !== undefined) return new EndpointUnreachableError('proof server', proofServerUrl, connectFailure.replace(CONNECT_FAILED, '') || 'the connection failed', { cause: err });
  try {
    await assertEndpointsReachable({ proofServer: proofServerUrl }, { signal });
  } catch (unreachable) {
    if (unreachable instanceof EndpointUnreachableError) return unreachable;
    throw unreachable;
  }
  const detail = said.join(': ');
  return new ProofFailureError(
    `The proof server at ${proofServerUrl} refused to prove the transaction${detail === '' ? '' : `: ${detail}`}.\n`
    + 'Check the proof server\'s logs and that its version fits the chain; a wallet state out of step with the chain does this too (midnight cache clear --wallet <name>, then retry).',
    { cause: err },
  );
}
