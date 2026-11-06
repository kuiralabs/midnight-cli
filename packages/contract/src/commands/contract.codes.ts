// The error codes the contract package owns.

import { defineCodes, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';

export const contractCodes = defineCodes([
  { code: 'NO_NODE_RUNTIME', exitCode: EXIT_GENERAL_ERROR, order: 200, summary: 'Contract scripts run under Node.js, and none was found on PATH.', recovery: 'Ask the user to install Node.js 22 or later, or to run mn under Node.' },
  { code: 'CONTRACT_NOT_COMPILED', exitCode: EXIT_GENERAL_ERROR, order: 205, summary: 'No compiled contract was found where the command looked (managed/<name>/compiler/contract-info.json).', recovery: 'Ask the user to compile the contract (compact compile), or pass the dApp folder (path) or the managed folder (managed).' },
]);
