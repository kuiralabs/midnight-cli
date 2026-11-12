// The error codes the wallet package owns, and the set a command definition
// declares when it opens a saved wallet.

import { defineCodeSet, defineCodes, EXIT_INVALID_ARGS, EXIT_WALLET_NOT_FOUND } from '@kuiralabs/midnight-cli-core';

export const walletCodes = defineCodes([
  { code: 'WALLET_NOT_FOUND', exitCode: EXIT_WALLET_NOT_FOUND, order: 20, summary: "Named wallet doesn't exist on disk.", recovery: '`midnight_wallet_list()` — user may have removed it.' },
  { code: 'WALLET_ADDRESS_MISMATCH', exitCode: EXIT_INVALID_ARGS, order: 21, summary: "A wallet file's saved addresses are not the ones its seed derives: the file was edited or mixed with another wallet's. Nothing was sent.", recovery: "Don't retry. Ask the user to restore the wallet file from a backup, or the wallet from its mnemonic (`midnight wallet generate <name> --mnemonic \"...\" --force`, at their terminal)." },
  { code: 'OFFER_TAKEN', exitCode: EXIT_INVALID_ARGS, order: 355, summary: "A swap offer's coins are already spent: it was taken, or its maker cancelled it, first (also when the node refuses a take or a cancel for that).", recovery: "Don't retry. Taking: ask the maker for a new offer. Cancelling: nothing is left to do; mn's record of the offer is closed." },
]);

/** Opening a saved wallet: none by that name, or its seed sealed with another passphrase or none to be had. */
export const OPENS_WALLET = defineCodeSet('wallet', ['WALLET_NOT_FOUND', 'WALLET_ADDRESS_MISMATCH', 'WRONG_PASSPHRASE', 'PASSPHRASE_REQUIRED']);
