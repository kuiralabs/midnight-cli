// The error codes the contract package owns.

import { defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const contractCodes = defineCodes([
  { code: 'NO_NODE_RUNTIME', exitCode: EXIT_GENERAL_ERROR, order: 200, summary: 'Contract scripts run under Node.js, and none was found on PATH.', recovery: 'Ask the user to install Node.js 22 or later, or to run mn under Node.' },
]);
