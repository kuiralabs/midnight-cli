// A transaction as stagenet's indexer described it on 2026-11-03 (the City's
// first swap; a 4.4 indexer, 4.3's transaction fields the same): what the
// chain's transaction-status tests and mn tx status's are answered with.

export const IDENTIFIER = '00408d0e7f195ae3a57b908f10513f2200386533960fcdc3fb152076dd84559086';
export const HASH = '1dc5749135a08df5fb95560e1ef1ff3fea6febdd8b263dbd2b371e2f9cb178f8';
export const BLOCK = { height: 1146592, hash: 'd3d3af4c0a35110377d12c1296274603fa75583b274191c8b7063bc913db2f75', timestamp: 1793696118000 };

export const answer = (transactions: unknown[]) => JSON.stringify({ data: { transactions } });
export const regular = (status: string, segments: unknown = null) => ({
  __typename: 'RegularTransaction',
  hash: HASH,
  block: BLOCK,
  identifiers: [IDENTIFIER],
  fee: '845170285714286',
  transactionResult: { status, segments },
});
