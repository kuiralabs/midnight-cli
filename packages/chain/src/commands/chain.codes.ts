// The error codes the chain package's checks raise: the chain's ledger, the
// local stack's endpoints, and the chain's clock; and the set a command
// definition declares when it checks the chain's ledger.

import { defineCodeSet, defineCodes, EXIT_NETWORK_ERROR } from '@kuiralabs/midnight-cli-core';

export const chainCodes = defineCodes([
  { code: 'UNSUPPORTED_LEDGER', exitCode: EXIT_NETWORK_ERROR, order: 150, summary: 'The network is on ledger 8; this build supports ledger 9 only.', recovery: "Tell the user: this network needs midnight-wallet-cli 0.5.x. Don't retry." },
  { code: 'LOCAL_STACK_UNREACHABLE', exitCode: EXIT_NETWORK_ERROR, order: 170, summary: 'No ledger-9 stack answers at the configured endpoints.', recovery: 'Ask the user to start their stack or fix the configured node / indexer-ws / proof-server endpoints.' },
  { code: 'CHAIN_CLOCK_BEHIND', exitCode: EXIT_NETWORK_ERROR, order: 140, summary: "The chain's clock lags this computer's (a local chain after sleep), so Dust estimates don't hold.", recovery: 'Wait for it to catch up, or ask the user to restart the local chain.' },
]);

/** Checking the chain a command reaches runs ledger 9: a chain on ledger 8, or no local stack answering. */
export const READS_CHAIN = defineCodeSet('chain', ['UNSUPPORTED_LEDGER', 'LOCAL_STACK_UNREACHABLE']);
