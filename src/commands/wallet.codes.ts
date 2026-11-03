// The error codes the wallet package owns.

import { defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_WALLET_NOT_FOUND } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const walletCodes = defineCodes([
  { code: 'WALLET_NOT_FOUND', exitCode: EXIT_WALLET_NOT_FOUND, summary: 'Wallet file does not exist.', recovery: '`midnight wallet list` shows the wallets there are.' },
]);
