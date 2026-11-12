// A wallet's name, checked once for every place that takes one: an argument,
// a flag, an MCP parameter, or the active wallet the config names. A name
// becomes a file name under the wallets folder, so anything else is refused
// before a file is touched or a passphrase asked for.

import { isValidWalletName, MAX_WALLET_NAME_LENGTH, WALLET_NAME_RULE } from './constants.ts';
import { UsageError } from './errors.ts';

/** A wallet name mn won't use: what is wrong with it, and what a name may be. */
export class InvalidWalletNameError extends UsageError {
  /** `where` says where the name came from when not the command line; `fix`, what to do about it there. */
  constructor(name: string, where?: string, fix?: string) {
    const length = [...name].length;
    const why = length > MAX_WALLET_NAME_LENGTH
      ? `Wallet name is ${length} characters; at most ${MAX_WALLET_NAME_LENGTH}.`
      : `Invalid wallet name: "${name}"\n${WALLET_NAME_RULE}`;
    super((where === undefined ? why : `${where}: ${why}`) + (fix === undefined ? '' : `\n${fix}`));
    this.name = 'InvalidWalletNameError';
    Object.setPrototypeOf(this, InvalidWalletNameError.prototype);
  }
}

/** Throws InvalidWalletNameError unless `name` is a wallet name. */
export function assertValidWalletName(name: string): void {
  if (!isValidWalletName(name)) throw new InvalidWalletNameError(name);
}
