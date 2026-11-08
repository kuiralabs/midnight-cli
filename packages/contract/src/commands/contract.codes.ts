// The error codes the contract package owns.

import { defineCodeSet, defineCodes, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';

export const contractCodes = defineCodes([
  { code: 'NO_NODE_RUNTIME', exitCode: EXIT_GENERAL_ERROR, order: 200, summary: 'Contract scripts run under Node.js, and none was found on PATH.', recovery: 'Ask the user to install Node.js 22 or later, or to run mn under Node.' },
  { code: 'CONTRACT_NOT_COMPILED', exitCode: EXIT_GENERAL_ERROR, order: 205, summary: 'No compiled contract was found where the command looked (managed/<name>/compiler/contract-info.json).', recovery: 'Ask the user to compile the contract (compact compile), or pass the dApp folder (path) or the managed folder (managed).' },
  { code: 'CONTRACT_INFO_INVALID', exitCode: EXIT_GENERAL_ERROR, order: 206, summary: "A compiled contract's contract-info.json is not what the Compact compiler writes (not JSON, or its circuits or witnesses missing or malformed).", recovery: 'The message names what is wrong: ask the user to compile the contract again (compact compile).' },
  { code: 'CONTRACT_STATE_BUSY', exitCode: EXIT_GENERAL_ERROR, order: 207, summary: "A contract's private-state store stayed in use by another process (another mn running a call of the same contract) for the 3 minutes a call waits for it. The message names the contract and, when it is an mn, its pid and command.", recovery: 'Let the other mn finish, or stop it if it is stuck. A call reads the store before it submits and writes it after, so read the contract state (`midnight_contract_state`) to see whether the call landed before retrying it.' },
]);

/** Running a compiled contract's script: no compiled contract, a contract-info.json no compiler wrote, no Node.js to run it with, a private-state store that stayed in use, a state on chain the ledger can't decode. */
export const RUNS_CONTRACTS = defineCodeSet('contract', ['CONTRACT_NOT_COMPILED', 'CONTRACT_INFO_INVALID', 'NO_NODE_RUNTIME', 'CONTRACT_STATE_BUSY', 'CONTRACT_STATE_UNREADABLE']);
