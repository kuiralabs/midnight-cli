// What became of a transaction, from the indexer. The indexer takes in only
// finalized blocks, so a transaction it has is final; one it doesn't have may
// still be on its way, may have been dropped, or may never have existed, and
// the indexer can't tell which.
//
// A transaction is found by its hash (32 bytes) or by one of its identifiers
// (33 bytes): what mn reports as a submitted transaction's `txHash` is the
// wallet SDK's identifier.

import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { sleep } from '@kuiralabs/midnight-cli-core/lib/sleep';
import { queryIndexer } from './indexer-graphql.ts';

const QUERY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

/** How a transaction was looked up: by its hash or by one of its identifiers. */
export type TxReference = { hash: string } | { identifier: string };

/** A transaction's result, as the ledger applied it. A system transaction has none. */
export type TxResultStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE';

/** A transaction the indexer has: in a finalized block. */
export interface FinalTransaction {
  readonly state: 'final';
  readonly kind: 'regular' | 'system';
  readonly hash: string;
  readonly identifiers: readonly string[];
  /** Regular transactions only. */
  readonly result?: TxResultStatus;
  /** Each segment's success, for a partial success (segment 0 is the guaranteed section). */
  readonly segments?: ReadonlyArray<{ id: number; success: boolean }>;
  /** The fee paid, in specks (regular transactions only; a failed one pays it too). */
  readonly feeSpecks?: bigint;
  readonly block: { readonly height: number; readonly hash: string; readonly time: Date };
}

/** A transaction the indexer doesn't have. */
export interface UnknownTransaction {
  readonly state: 'notFound';
}

export type TransactionStatus = FinalTransaction | UnknownTransaction;

const HEX = /^[0-9a-f]+$/;

/**
 * Read a transaction reference given as text: 64 hex characters are a hash, 66
 * an identifier, with or without `0x`. Throws UsageError for anything else.
 */
export function parseTxReference(text: string): TxReference {
  const hex = text.trim().toLowerCase().replace(/^0x/, '');
  if (HEX.test(hex) && hex.length === 64) return { hash: hex };
  if (HEX.test(hex) && hex.length === 66) return { identifier: hex };
  throw new UsageError(`"${text}" is not a transaction hash (64 hex characters) or identifier (66 hex characters)`);
}

const TX_QUERY = `query ($offset: TransactionOffset!) {
  transactions(offset: $offset) {
    __typename
    hash
    block { height hash timestamp }
    ... on RegularTransaction { identifiers fee transactionResult { status segments { id success } } }
  }
}`;

interface RawTransaction {
  __typename: string;
  hash: string;
  block: { height: number; hash: string; timestamp: number };
  identifiers?: string[];
  fee?: string;
  transactionResult?: { status: TxResultStatus; segments?: Array<{ id: number; success: boolean }> | null };
}

/** What the indexer knows of a transaction now. Throws IndexerQueryError when it can't answer. */
export async function fetchTransactionStatus(indexerHttpUrl: string, ref: TxReference, signal?: AbortSignal): Promise<TransactionStatus> {
  const data = await queryIndexer<{ transactions: RawTransaction[] }>(indexerHttpUrl, TX_QUERY, { offset: ref }, QUERY_TIMEOUT_MS, signal);
  // A transaction is applied once; the first is the one that counts.
  const tx = data.transactions[0];
  if (tx === undefined) return { state: 'notFound' };
  const block = { height: tx.block.height, hash: tx.block.hash, time: new Date(tx.block.timestamp) };
  if (tx.__typename !== 'RegularTransaction') return { state: 'final', kind: 'system', hash: tx.hash, identifiers: [], block };
  const result = tx.transactionResult?.status;
  return {
    state: 'final',
    kind: 'regular',
    hash: tx.hash,
    identifiers: tx.identifiers ?? [],
    ...(result === undefined ? {} : { result }),
    ...(result === 'PARTIAL_SUCCESS' ? { segments: tx.transactionResult?.segments ?? [] } : {}),
    ...(tx.fee === undefined ? {} : { feeSpecks: BigInt(tx.fee) }),
    block,
  };
}

/**
 * Ask the indexer until it has the transaction or `timeoutMs` passes; the last
 * answer either way. Throws CancelledError when `signal` cancels it, and
 * IndexerQueryError when the indexer can't answer.
 */
export async function waitForTransactionStatus(
  indexerHttpUrl: string,
  ref: TxReference,
  timeoutMs: number,
  signal?: AbortSignal,
  intervalMs: number = POLL_INTERVAL_MS,
): Promise<TransactionStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await fetchTransactionStatus(indexerHttpUrl, ref, signal);
    const left = deadline - Date.now();
    if (status.state === 'final' || left <= 0) return status;
    await sleep(Math.min(intervalMs, left), signal);
  }
}
