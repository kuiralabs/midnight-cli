// The transaction a deploy or call script reports (midnight-js's finalized
// transaction data: its hash and one of its identifiers), as a deploy or call
// reports it: txHash is the identifier, as every other command that submits
// gives it and `mn tx status` takes it; the hash is the receipt's.

import { receiptOf, type Receipt } from '@kuiralabs/midnight-chain';

/** What a script reports of the transaction it submitted; neither on a run that submitted none. */
export interface ScriptTransaction {
  /** The transaction's hash, 64 hex characters. */
  readonly txHash?: string;
  /** One of its identifiers, 66 hex characters. */
  readonly txId?: string;
}

/**
 * The transaction's identifier as txHash, with its receipt once the indexer at
 * `indexer` lists it; empty when the script reported none.
 */
export async function reportedTransaction(reported: ScriptTransaction, indexer: string, signal?: AbortSignal): Promise<{ txHash?: string; receipt?: Receipt }> {
  const identifier = reported.txId;
  if (identifier === undefined) return {};
  return { txHash: identifier, receipt: await receiptOf(indexer, identifier, signal) };
}
