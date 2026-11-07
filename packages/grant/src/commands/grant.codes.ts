// The error codes the grant package owns.

import { defineCodes, EXIT_GENERAL_ERROR, EXIT_INVALID_ARGS } from '@kuiralabs/midnight-cli-core';

export const grantCodes = defineCodes([
  { code: 'NO_ACCOUNT', exitCode: EXIT_GENERAL_ERROR, order: 210, summary: 'A grant command (`midnight_grant_*` tool) was called for a wallet that has no account on this network.', recovery: 'Offer `midnight_grant_deploy()`, after telling the user how its owner key is kept (see the allowance flow).' },
  { code: 'ACCOUNT_KEYS_UNAVAILABLE', exitCode: EXIT_GENERAL_ERROR, order: 217, summary: "A proving key of the account contract couldn't be had: the installed account build's keys are not published (HTTP 404), or fetching them failed. Nothing was submitted.", recovery: 'Show the message: it names the key and the build. Not published: tell the user mn grant needs an mn release whose account keys are published; don\'t retry. A failed fetch: retry once.' },
  { code: 'CALLER_PIN_UNSUPPORTED', exitCode: EXIT_INVALID_ARGS, order: 215, summary: 'A grant request pins the contract that calls the account, and the account on this network (stagenet) has no caller pin; nothing was submitted.', recovery: 'Tell the user; ask the agent for a grant request that names no calling contract, or issue it on undeployed.' },
]);
