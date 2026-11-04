// The error codes the dev package owns.

import { defineCodes, EXIT_GENERAL_ERROR, EXIT_NETWORK_ERROR } from '@kuiralabs/midnight-cli-core';

export const devCodes = defineCodes([
  { code: 'LOCALNET_UNAVAILABLE', exitCode: EXIT_NETWORK_ERROR, order: 160, summary: "`mn localnet up` (`midnight_localnet_up()`) can't start a ledger-9 stack on this build.", recovery: 'Ask the user to start their ledger-9 stack and point mn at it (endpoint config).' },
  { code: 'NO_TEST_CONFIG', exitCode: EXIT_GENERAL_ERROR, order: 165, summary: 'No dapp.test.json in the folder the test command ran in.', recovery: 'Ask the user to run it from the dApp\'s root, or create one with `mn test create`.' },
]);
