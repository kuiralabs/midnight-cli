// What the chain package (the error codes its chain checks raise) tells agents:
// its pieces of `help --agent` and of the two skills, each
// naming its section and its place there.

import { codeGuidancePieces, type PackageGuidance } from '@kuiralabs/midnight-cli-core';
import { chainCodes } from './chain.codes.ts';

export const chainGuidance: PackageGuidance = {
  pieces: [
    // Its error codes' rows in the manual and the full skill, from their definitions.
    ...codeGuidancePieces(chainCodes),
  ],
  toolsTable: [
    { tool: 'midnight_tx_status', group: 'transactions', order: 50, description: ['What became of a transaction: block, fee, result'] },
  ],
};
