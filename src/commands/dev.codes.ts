// The error codes the dev package owns.

import { defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_NETWORK_ERROR } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const devCodes = defineCodes([
  { code: 'LOCALNET_UNAVAILABLE', exitCode: EXIT_NETWORK_ERROR, summary: "`mn localnet up` can't start a ledger-9 stack on this build.", recovery: 'Run one yourself and point mn at it (endpoint flags or `midnight config set`).' },
]);
