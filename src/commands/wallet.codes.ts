// The error codes the wallet package owns, and the set a command definition
// declares when it opens a saved wallet.

import { defineCodeSet, defineCodes } from '@kuiralabs/midnight-cli-core/lib/error-codes';
import { EXIT_WALLET_NOT_FOUND } from '@kuiralabs/midnight-cli-core/lib/exit-codes';

export const walletCodes = defineCodes([
  { code: 'WALLET_NOT_FOUND', exitCode: EXIT_WALLET_NOT_FOUND, order: 20, summary: "Named wallet doesn't exist on disk.", recovery: '`midnight_wallet_list()` — user may have removed it.' },
]);

/** Opening a saved wallet: none by that name, or its seed sealed with another passphrase or none to be had. */
export const OPENS_WALLET = defineCodeSet('wallet', ['WALLET_NOT_FOUND', 'WRONG_PASSPHRASE', 'PASSPHRASE_REQUIRED']);
