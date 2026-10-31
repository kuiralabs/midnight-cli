// Airdrop: unshielded NIGHT from the genesis wallet (seed 0x01) of a local
// devnet. `mn airdrop` and `mn dev` both fund wallets through here; the
// caller has already checked that the network is the local one.

import { GENESIS_SEED } from './constants.ts';
import { executeTransfer, type TransferParams, type TransferResult } from './transfer.ts';

export type AirdropParams = Omit<TransferParams, 'seedBuffer'>;

/** Sends `amountNight` NIGHT from genesis to `recipientAddress`. */
export async function airdropNight(params: AirdropParams): Promise<TransferResult> {
  try {
    return await executeTransfer({ ...params, seedBuffer: Buffer.from(GENESIS_SEED, 'hex') });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('dust')) {
      throw new Error(
        `${err.message}\n\n` +
        `On a fresh localnet, the minimum airdrop is ~1 NIGHT.\n` +
        `Try: midnight airdrop 1`
      );
    }
    throw err;
  }
}
