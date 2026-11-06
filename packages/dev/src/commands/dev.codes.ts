// The error codes the dev package owns.

import { defineCodes, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';

export const devCodes = defineCodes([
  { code: 'NO_TEST_CONFIG', exitCode: EXIT_GENERAL_ERROR, order: 165, summary: 'No dapp.test.json in the folder the test command ran in.', recovery: 'Ask the user to run it from the dApp\'s root, or create one with `mn test create`.' },
]);
