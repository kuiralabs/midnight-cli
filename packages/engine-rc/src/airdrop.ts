// Airdrop: unshielded NIGHT from the genesis wallet (seed 0x01) of a local
// devnet. `mn airdrop` and `mn dev` both fund wallets through here; the
// caller has already checked that the network is the local one.

import { GENESIS_SEED } from '@kuiralabs/midnight-cli-core/lib/constants';
import { executeTransfer, type TransferParams, type TransferResult } from './transfer.ts';
import type { AirdropParams } from '@kuiralabs/midnight-cli-core/lib/engine';
import type { WalletDataRepository } from './wallet-data-repository.ts';
export type { AirdropParams } from '@kuiralabs/midnight-cli-core/lib/engine';


/** Sends `amountNight` NIGHT from genesis to `recipientAddress`, on the engine's repository `repo`. */
export async function airdropNight(repo: WalletDataRepository, params: AirdropParams): Promise<TransferResult> {
  try {
    return await executeTransfer(repo, { ...params, seedBuffer: Buffer.from(GENESIS_SEED, 'hex') });
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
