// The error codes the connect package owns.

import { defineCodes, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';

export const connectCodes = defineCodes([
  { code: 'SERVE_PORT_IN_USE', exitCode: EXIT_GENERAL_ERROR, order: 315, summary: 'The port mn serve was to use is taken by a process that can\'t serve this command (another program, or an mn serve for another network, chain or wallet).', recovery: 'The message names the port and how to find the process on it: ask the user to stop that process, or run on another port.' },
  { code: 'APPROVAL_UNAVAILABLE', exitCode: EXIT_GENERAL_ERROR, order: 316, summary: 'A request to mn serve needed approval and nobody could be asked: the serve has no terminal and was not started to approve it without asking.', recovery: 'Ask the user to restart mn serve with --approve-all (or --approve-fees for a wallet that only pays an agent\'s Dust fee), or to run it at a terminal.' },
]);
