// The error codes the contract package owns.

import { defineCodeSet, defineCodes, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';

export const contractCodes = defineCodes([
  { code: 'NO_NODE_RUNTIME', exitCode: EXIT_GENERAL_ERROR, order: 200, summary: 'Contract scripts run under Node.js, and none was found on PATH.', recovery: 'Ask the user to install Node.js 22 or later, or to run mn under Node.' },
  { code: 'CONTRACT_NOT_COMPILED', exitCode: EXIT_GENERAL_ERROR, order: 205, summary: 'No compiled contract was found where the command looked (managed/<name>/compiler/contract-info.json).', recovery: 'Ask the user to compile the contract (compact compile), or pass the dApp folder (path) or the managed folder (managed).' },
  { code: 'CONTRACT_INFO_INVALID', exitCode: EXIT_GENERAL_ERROR, order: 206, summary: "A compiled contract's contract-info.json is not what the Compact compiler writes (not JSON, or its circuits or witnesses missing or malformed).", recovery: 'The message names what is wrong: ask the user to compile the contract again (compact compile).' },
]);

/** Running a compiled contract's script: no compiled contract, a contract-info.json no compiler wrote, no Node.js to run it with. */
export const RUNS_CONTRACTS = defineCodeSet('contract', ['CONTRACT_NOT_COMPILED', 'CONTRACT_INFO_INVALID', 'NO_NODE_RUNTIME']);
