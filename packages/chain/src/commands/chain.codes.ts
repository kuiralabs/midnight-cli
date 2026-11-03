// The error codes the chain package's checks raise: the chain's ledger, the
// local stack's endpoints, and the chain's clock.

import { defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_NETWORK_ERROR } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const chainCodes = defineCodes([
  { code: 'UNSUPPORTED_LEDGER', exitCode: EXIT_NETWORK_ERROR, summary: 'The chain is on ledger 8; this build supports ledger 9 only.', recovery: 'Use midnight-wallet-cli 0.5.x for that network.' },
  { code: 'LOCAL_STACK_UNREACHABLE', exitCode: EXIT_NETWORK_ERROR, summary: 'No ledger-9 stack answers at the configured endpoints.', recovery: 'Start one, or fix the endpoints.' },
  { code: 'CHAIN_CLOCK_BEHIND', exitCode: EXIT_NETWORK_ERROR, summary: "The chain's clock is behind this computer's (a local chain after the machine slept), so Dust estimates don't hold.", recovery: 'Wait for it to catch up, or restart the local chain.' },
]);
