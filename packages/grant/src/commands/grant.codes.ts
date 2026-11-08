// The error codes the grant package owns.

import { defineCodeSet, defineCodes, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';

export const grantCodes = defineCodes([
  { code: 'NO_ACCOUNT', exitCode: EXIT_GENERAL_ERROR, order: 210, summary: 'A grant command (`midnight_grant_*` tool) was called for a wallet that has no account on this network.', recovery: 'Offer `midnight_grant_deploy()`, after telling the user how its owner key is kept (see the allowance flow).' },
  { code: 'ACCOUNT_KEYS_UNAVAILABLE', exitCode: EXIT_GENERAL_ERROR, order: 217, summary: "A proving key of the account contract couldn't be had: the installed account build's keys are not published (HTTP 404), or fetching them failed. Nothing was submitted.", recovery: 'Show the message: it names the key, the build and where it was fetched from. Not published: tell the user mn grant needs an mn release whose account keys are published, or a local build of the account contract given with `midnight config set account-artifacts <folder>` (or MN_ACCOUNT_ARTIFACTS); don\'t retry. A file the source has that is not this build\'s: the source is another build; ask the user for the right one. A failed fetch: retry once.' },
]);

/** Acting on a wallet's account: none on record, or a proving key of the account contract that can't be had. */
export const ACTS_ON_ACCOUNT = defineCodeSet('account', ['NO_ACCOUNT', 'ACCOUNT_KEYS_UNAVAILABLE']);
