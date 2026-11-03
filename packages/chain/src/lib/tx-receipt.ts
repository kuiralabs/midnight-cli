// A submitted transaction's receipt: its block, time, fee and result, once the
// indexer lists it. mn's submits return when the node has finalized the
// transaction; the indexer may list it a few seconds later.

import { CancelledError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { toDust } from '@kuiralabs/midnight-cli-core/ui/format';
import { IndexerQueryError } from './indexer-graphql.ts';
import { type FinalTransaction, type TransactionStatus, parseTxReference, waitForTransactionStatus } from './tx-status.ts';

/** How long a command that submitted waits for the indexer to list its transaction. */
export const RECEIPT_WAIT_MS = 60_000;

/** What a command that submitted reports about its transaction. */
export type Receipt =
  | { readonly listed: true; readonly transaction: FinalTransaction }
  | { readonly listed: false; readonly reason: string };

/**
 * The receipt of a transaction this call submitted (`txId`, its hash or
 * identifier). Never throws: the transaction is submitted whatever the indexer
 * says, so a lagging or unreachable indexer, or the call's cancellation, gives
 * a receipt that says why it is missing.
 */
export async function receiptOf(indexerHttpUrl: string, txId: string, signal?: AbortSignal, waitMs: number = RECEIPT_WAIT_MS): Promise<Receipt> {
  try {
    const status = await waitForTransactionStatus(indexerHttpUrl, parseTxReference(txId), waitMs, signal);
    if (status.state === 'final') return { listed: true, transaction: status };
    return { listed: false, reason: `the indexer has not listed it after ${Math.round(waitMs / 1000)} s` };
  } catch (err) {
    if (err instanceof CancelledError) return { listed: false, reason: 'cancelled while waiting for the indexer' };
    if (err instanceof IndexerQueryError) return { listed: false, reason: `the indexer did not answer: ${err.message}` };
    throw err;
  }
}

/** A final transaction's fields, as `--json` output carries them. */
export function finalTransactionJson(tx: FinalTransaction): Record<string, unknown> {
  return {
    kind: tx.kind,
    hash: tx.hash,
    ...(tx.kind === 'regular' ? { identifiers: tx.identifiers } : {}),
    ...(tx.result === undefined ? {} : { result: tx.result }),
    ...(tx.segments === undefined ? {} : { segments: tx.segments }),
    ...(tx.feeSpecks === undefined ? {} : { fee: toDust(tx.feeSpecks), feeSpecks: tx.feeSpecks.toString() }),
    blockHeight: tx.block.height,
    blockHash: tx.block.hash,
    blockTime: tx.block.time.toISOString(),
  };
}

/** A status as `--json` output carries it. */
export function transactionStatusJson(status: TransactionStatus): Record<string, unknown> {
  return status.state === 'final' ? { state: 'final', ...finalTransactionJson(status) } : { state: 'notFound' };
}

/** A receipt as the `receipt` field of a submitting command's `--json` output: the transaction, or null with why. */
export function receiptJson(receipt: Receipt): Record<string, unknown> {
  return receipt.listed
    ? { receipt: finalTransactionJson(receipt.transaction) }
    : { receipt: null, receiptMissing: receipt.reason };
}
