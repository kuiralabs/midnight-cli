// Whether a swap offer can still be taken: none of the coins it spends may be
// spent already. Asked of the indexer before the taker builds or proves
// anything, because the ledger refuses a dead offer only after the taker's
// proof is done.

import { queryIndexer } from './indexer-graphql.ts';
import { subscribeGraphqlWs } from './graphql-ws-subscription.ts';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';

const SPENT_NULLIFIERS = `subscription Spent($prefixes: [HexEncoded!]!, $fromBlock: Int, $toBlock: Int) {
  shieldedNullifierTransactions(nullifierPrefixes: $prefixes, fromBlock: $fromBlock, toBlock: $toBlock) {
    nullifier
    transactionHash
    blockHeight
  }
}`;

/** How long the indexer may take to answer, and to finish the spend check, before it fails rather than hangs. */
const ANSWER_TIMEOUT_MS = 60_000;
/** Silence between two spends after which the check counts as finished. */
const SPEND_IDLE_MS = 15_000;

/** One of an offer's coins, spent on chain. */
export interface CoinSpend {
  nullifier: string;
  transactionHash: string;
  blockHeight: number;
}

/** The indexer did not finish the spend check, so whether the offer is live is unknown. */
export class LivenessUnknownError extends Error {
  constructor(reason: string) {
    super(`Can't tell whether the offer is still live: ${reason}`);
    this.name = 'LivenessUnknownError';
  }
}

/**
 * The spends of the coins with these nullifiers (hex), from `fromBlock` to the
 * chain's current tip; empty while none is spent.
 */
export async function spendsOf(
  indexer: { indexer: string; indexerWS: string },
  nullifiers: readonly string[],
  options: { fromBlock?: number; signal?: AbortSignal } = {},
): Promise<CoinSpend[]> {
  throwIfCancelled(options.signal);
  const { block } = await queryIndexer<{ block: { height: number } | null }>(indexer.indexer, '{ block { height } }', undefined, ANSWER_TIMEOUT_MS, options.signal);
  if (block === null) throw new LivenessUnknownError('the indexer has no blocks yet');
  const wanted = new Set(nullifiers.map((n) => n.toLowerCase()));
  const spends: CoinSpend[] = [];
  const finished = await subscribeGraphqlWs<boolean>(indexer.indexerWS, {
    query: SPENT_NULLIFIERS,
    variables: { prefixes: nullifiers, fromBlock: options.fromBlock ?? 0, toBlock: block.height },
    onNext: (data) => {
      const spend = (data as { shieldedNullifierTransactions?: CoinSpend }).shieldedNullifierTransactions;
      // Prefixes match more than the exact nullifier; only an exact one is a spend of the offer's coin.
      if (spend !== undefined && wanted.has(spend.nullifier.toLowerCase())) spends.push(spend);
      return false;
    },
    buildResult: (partial) => !partial,
    timeoutMs: ANSWER_TIMEOUT_MS,
    idleMs: SPEND_IDLE_MS,
    signal: options.signal,
  });
  if (!finished) throw new LivenessUnknownError(`the indexer didn't finish the spend check in ${ANSWER_TIMEOUT_MS / 1000} s`);
  return spends;
}
