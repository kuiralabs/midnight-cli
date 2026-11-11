// @kuiralabs/midnight-chain: read-only network access: node, indexer and
// proof-server readiness, the chain id, tip and events, the ledger-version
// guard, transaction status and receipts, and offer liveness. Each name is
// listed, so the API is what this file says. The chain's commands, codes and
// guidance are "./commands".

export { type BalanceSummary, checkBalance, isNativeToken } from './lib/balance-subscription.ts';
export { assertChainClockCurrent, ChainClockBehindError, fetchChainTime } from './lib/chain-clock.ts';
export { getChainGenesisHash } from './lib/chain-id.ts';
export { assertEndpointsReachable, assertNetworkAnswers, assertNetworkReady, endpointsOf, type NeededEndpoints, REACHABILITY_TIMEOUT_MS, type ReachabilityOptions } from './lib/endpoint-check.ts';
export { fetchEventTip, isCursorBeyondTip, isStreamEmpty, type LedgerEventStream } from './lib/event-tip.ts';
export { subscribeGraphqlWs } from './lib/graphql-ws-subscription.ts';
export { queryIndexer } from './lib/indexer-graphql.ts';
export { waitForAddressFunded } from './lib/indexer-ready.ts';
export {
  assertLedger9StackReachable, assertLedgerSupported, checkLedgerSupported, fetchGenesisProtocolVersion, fetchProtocolVersion, LocalStackUnreachableError,
  UnsupportedLedgerError, walletsBelowLedger9
} from './lib/ledger-guard.ts';
export { waitForFirstBlock } from './lib/node-ready.ts';
export { callNodeRpc } from './lib/node-rpc.ts';
export { type CoinSpend, spendsOf } from './lib/offer-liveness.ts';
export { explainProofFailure } from './lib/proof-failure.ts';
export { waitForProofServerReady } from './lib/proof-server-ready.ts';
export { type Receipt, RECEIPT_WAIT_MS, receiptJson, receiptOf } from './lib/tx-receipt.ts';
export { fetchPartialSuccessSegments, type SegmentResult } from './lib/tx-segments.ts';
export { transactionStatus } from './lib/tx-status.ts';
