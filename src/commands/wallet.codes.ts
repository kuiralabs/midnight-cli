// The error codes the wallet package owns.

import { defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_WALLET_NOT_FOUND } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const walletCodes = defineCodes([
  { code: 'WALLET_NOT_FOUND', exitCode: EXIT_WALLET_NOT_FOUND, order: 20, summary: "Named wallet doesn't exist on disk.", recovery: '`midnight_wallet_list()` — user may have removed it.' },
]);
