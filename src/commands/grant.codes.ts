// The error codes the grant package owns.

import { defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const grantCodes = defineCodes([
  { code: 'NO_ACCOUNT', exitCode: EXIT_GENERAL_ERROR, summary: 'The wallet has no account on this network yet.', recovery: '`mn grant deploy`.' },
]);
