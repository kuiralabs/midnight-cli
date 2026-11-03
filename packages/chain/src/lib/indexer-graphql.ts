// One GraphQL query to the indexer's HTTP endpoint.

import { assertEndpointUsable, endpointRefusal } from '@kuiralabs/midnight-cli-core/lib/blockfrost';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';

/** The indexer could not answer a query: unreachable, an HTTP error, a non-JSON body, or GraphQL errors. */
export class IndexerQueryError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'IndexerQueryError';
    Object.setPrototypeOf(this, IndexerQueryError.prototype);
  }
}

/** The indexer could not be reached (refused, no such host, timed out): fetch's own words, and fetch's error as the cause. */
export class IndexerUnreachableError extends IndexerQueryError {
  readonly code = 'NETWORK_ERROR';

  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'IndexerUnreachableError';
    Object.setPrototypeOf(this, IndexerUnreachableError.prototype);
  }
}

/**
 * POST `query` to the indexer and return its `data`. Throws IndexerQueryError
 * when there is none to return, and CancelledError when `signal` cancels it.
 */
export async function queryIndexer<TData>(
  indexerHttpUrl: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TData> {
  assertEndpointUsable(indexerHttpUrl);
  throwIfCancelled(signal);
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
  } catch (err) {
    throwIfCancelled(signal);
    throw new IndexerUnreachableError((err as Error).message, { cause: err });
  }
  if (!res.ok) throw endpointRefusal(indexerHttpUrl, res.status) ?? new IndexerQueryError(`HTTP ${res.status} ${res.statusText}`.trim());
  let body: { data?: TData | null; errors?: Array<{ message: string }> };
  try {
    body = await res.json() as typeof body;
  } catch (err) {
    throwIfCancelled(signal);
    throw new IndexerQueryError(`the answer is not JSON: ${(err as Error).message}`);
  }
  if (body.errors?.length) throw new IndexerQueryError(body.errors.map((e) => e.message).join('; '));
  if (body.data == null) throw new IndexerQueryError('the answer has no data');
  return body.data;
}
