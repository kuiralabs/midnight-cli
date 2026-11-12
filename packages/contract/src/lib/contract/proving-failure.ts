// A proof a contract script asked of the proof server and didn't get. midnight-js
// reports it as "proveTx rejected the transaction (circuit '…')", its proof
// provider's failure only on `cause`: a proof server that died mid-proof and
// one that refused read the same, and it crossed the process as UNKNOWN. The
// script now carries the circuit and what the provider said (midnight-js has
// already redacted it of transaction and witness material) out with its
// failure, and mn names the proof server and what happened, as for a transfer.

import { explainProofFailure } from '@kuiralabs/midnight-chain';

/** What a failed proof's report carries out of the script: the circuit(s) midnight-js named, and the provider's failure, outermost first. */
export interface ProvingFailure {
  readonly circuit?: string;
  readonly causes: readonly string[];
}

/** The most cause messages carried out, and their longest text. */
const MAX_CAUSES = 4;
const MAX_CAUSE_CHARS = 300;

/**
 * For the script: what a midnight-js proveTx failure carries out, or undefined
 * for any other failure. Self-contained, with nothing from outside its body:
 * the script's prelude carries it as its source text.
 */
export function provingFailureOf(e: unknown): { circuit?: string; causes: string[] } | undefined {
  const failure = e as { name?: unknown; method?: unknown; circuitId?: unknown; cause?: unknown } | null;
  if (failure === null || typeof failure !== 'object' || failure.name !== 'ProviderFailedError' || failure.method !== 'proveTx') return undefined;
  const circuit = Array.isArray(failure.circuitId) ? failure.circuitId.join(', ') : typeof failure.circuitId === 'string' ? failure.circuitId : undefined;
  const causes: string[] = [];
  let current: unknown = failure.cause;
  while (current !== null && typeof current === 'object' && causes.length < 4) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') causes.push(message.split('\n')[0]!.slice(0, 300));
    current = (current as { cause?: unknown }).cause;
  }
  return { ...(circuit === undefined ? {} : { circuit }), causes };
}

/** provingFailureOf serialized for the generated script (the same .toString()-inlining as the prelude's other helpers). */
export const PROVING_FAILURE_FN = `\nconst provingFailureOf = (${provingFailureOf.toString()});\n`;

/** A script's `proving` report as mn reads it back; undefined when it isn't one. */
export function provingFailureFromWire(wire: unknown): ProvingFailure | undefined {
  if (wire === null || typeof wire !== 'object') return undefined;
  const { circuit, causes } = wire as { circuit?: unknown; causes?: unknown };
  if (!Array.isArray(causes)) return undefined;
  return {
    ...(typeof circuit === 'string' ? { circuit } : {}),
    causes: causes.filter((cause): cause is string => typeof cause === 'string').slice(0, MAX_CAUSES).map((cause) => cause.slice(0, MAX_CAUSE_CHARS)),
  };
}

/**
 * A script's failed proof as what it was, at the proof server at
 * `proofServerUrl` (explainProofFailure): a NETWORK_ERROR naming it when it
 * can't be reached or dropped the connection mid-proof, a PROOF_FAILURE naming
 * it and the circuit when it refused. Any other failure as it is.
 */
export async function namingProofServer(err: unknown, proofServerUrl: string, signal?: AbortSignal): Promise<unknown> {
  const proving = (err as { proving?: ProvingFailure } | null)?.proving;
  if (proving === undefined || !(err instanceof Error)) return err;
  // The provider's failure as midnight-js reported it, rebuilt from the messages the script carried out.
  const cause = proving.causes.reduceRight<Error | undefined>((inner, message) => new Error(message, inner === undefined ? undefined : { cause: inner }), undefined);
  const reported = Object.assign(new Error(err.message, cause === undefined ? undefined : { cause }), { name: 'ProviderFailedError', method: 'proveTx', circuitId: proving.circuit });
  const explained = await explainProofFailure(reported, proofServerUrl, signal);
  return explained === reported ? err : explained;
}
