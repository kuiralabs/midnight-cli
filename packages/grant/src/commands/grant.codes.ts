// The error codes the grant package owns.

import { defineCodes, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';

export const grantCodes = defineCodes([
  { code: 'NO_ACCOUNT', exitCode: EXIT_GENERAL_ERROR, order: 210, summary: 'A grant command (`midnight_grant_*` tool) was called for a wallet that has no account on this network.', recovery: 'Offer `midnight_grant_deploy()`, after telling the user how its owner key is kept (see the allowance flow).' },
]);
