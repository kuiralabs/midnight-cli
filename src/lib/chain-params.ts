// The chain's current ledger parameters (block limits, fee prices), as the
// indexer serves them for the latest block, still serialized: the engine for
// the chain's SDK set reads them. They differ from the ledger's initial
// parameters: on a ledger-9 localnet the block limits for read time and
// block usage are 2x and 5x the initial ones.

import { queryIndexer } from '@kuiralabs/midnight-chain/lib/indexer-graphql';

export interface ChainLedgerParameters {
  height: number;
  /** The serialized ledger parameters, hex. */
  parametersHex: string;
}

/** The latest block's ledger parameters. Throws IndexerQueryError when the indexer can't answer, CancelledError when `signal` cancels the read. */
export async function fetchLedgerParameters(indexerHttpUrl: string, signal?: AbortSignal): Promise<ChainLedgerParameters> {
  const data = await queryIndexer<{ block?: { height?: number; ledgerParameters?: string } }>(
    indexerHttpUrl, '{ block { height ledgerParameters } }', undefined, 10_000, signal);
  const hex = data.block?.ledgerParameters;
  if (typeof hex !== 'string' || typeof data.block?.height !== 'number') {
    throw new Error('The indexer returned no ledger parameters for its latest block');
  }
  return { height: data.block.height, parametersHex: hex };
}
