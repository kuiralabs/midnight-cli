// The error codes the contract package owns.

import { defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const contractCodes = defineCodes([
  { code: 'NO_NODE_RUNTIME', exitCode: EXIT_GENERAL_ERROR, summary: 'Contract scripts run under Node.js, and none was found on PATH.', recovery: 'Install Node.js 22 or later, or run mn under Node.' },
]);
