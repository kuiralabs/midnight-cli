// The error codes the contract package owns.

import { defineCodeSet, defineCodes, EXIT_GENERAL_ERROR, EXIT_INVALID_ARGS } from '@kuiralabs/midnight-cli-core';

export const contractCodes = defineCodes([
  { code: 'NO_NODE_RUNTIME', exitCode: EXIT_GENERAL_ERROR, order: 200, summary: 'Contract scripts run under Node.js, and none was found on PATH.', recovery: 'Ask the user to install Node.js 22 or later, or to run mn under Node.' },
  { code: 'CONTRACT_NOT_COMPILED', exitCode: EXIT_GENERAL_ERROR, order: 205, summary: 'No compiled contract was found where the command looked (managed/<name>/compiler/contract-info.json).', recovery: 'Ask the user to compile the contract (compact compile), or pass the dApp folder (path) or the managed folder (managed).' },
  { code: 'CONTRACT_INFO_INVALID', exitCode: EXIT_GENERAL_ERROR, order: 206, summary: "A compiled contract's contract-info.json is not what the Compact compiler writes (not JSON, or its circuits or witnesses missing or malformed).", recovery: 'The message names what is wrong: ask the user to compile the contract again (compact compile).' },
  { code: 'CONTRACT_STATE_BUSY', exitCode: EXIT_GENERAL_ERROR, order: 207, summary: "A contract's private-state store stayed in use by another process (another mn running a call of the same contract) for the 3 minutes a call waits for it. The message names the contract and, when it is an mn, its pid and command.", recovery: 'Let the other mn finish, or stop it if it is stuck. A call reads the store before it submits and writes it after, so read the contract state (`midnight_contract_state`) to see whether the call landed before retrying it.' },
  // Exit 2, as the other refusals of a request before anything is sent (MAINNET_REFUSED, OFFER_EXPIRED): the contract's own rule refused these arguments on its current state; retrying the same call fails the same way until one of them changes.
  { code: 'CONTRACT_ASSERTION_FAILED', exitCode: EXIT_INVALID_ARGS, order: 208, summary: "A Compact `assert` in the circuit called (or in the constructor, for a deploy) failed while the contract ran on this machine, before anything was proven or sent. The message names the contract, the circuit and the assert's own text (e.g. \"Still locked\").", recovery: "Nothing was sent or paid. Tell the user the contract refused the call and why, in the assert's words. Don't retry the same call: change its arguments, or wait until the contract's state allows it (a time lock, another party's step)." },
]);

/** Running a compiled contract's script: no compiled contract, a contract-info.json no compiler wrote, no Node.js to run it with, a private-state store that stayed in use, a state on chain the ledger can't decode, an assert the contract failed. */
export const RUNS_CONTRACTS = defineCodeSet('contract', ['CONTRACT_NOT_COMPILED', 'CONTRACT_INFO_INVALID', 'NO_NODE_RUNTIME', 'CONTRACT_STATE_BUSY', 'CONTRACT_STATE_UNREADABLE', 'CONTRACT_ASSERTION_FAILED']);
