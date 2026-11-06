// Airdrop: unshielded NIGHT from the genesis wallet (seed 0x01) of a local
// devnet. `mn airdrop` and `mn dev` both fund wallets through here; the
// caller has already checked that the network is the local one.

import { EngineError, toEngineError, type AirdropParams } from '@kuiralabs/midnight-cli-core/engine';
import { GENESIS_SEED } from '@kuiralabs/midnight-cli-core';
import { executeTransfer, type TransferParams, type TransferResult } from './transfer.ts';
import type { WalletDataRepository } from './wallet-data-repository.ts';
export type { AirdropParams } from '@kuiralabs/midnight-cli-core/engine';


/** Sends `amount` micro-NIGHT from genesis to `recipientAddress`, on the engine's repository `repo`. */
export async function airdropNight(repo: WalletDataRepository, params: AirdropParams): Promise<TransferResult> {
  try {
    return await executeTransfer(repo, { ...params, seedBuffer: Buffer.from(GENESIS_SEED, 'hex') });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('dust')) {
      const message = `${err.message}\n\n` +
        `On a fresh localnet, the minimum airdrop is ~1 NIGHT.\n` +
        `Try: midnight airdrop 1`;
      // The note keeps the failure's code: the one it carries, or the engine contract's for the SDK's error.
      const code = (toEngineError(err) as { code?: unknown }).code;
      throw typeof code === 'string' ? new EngineError(code, message, { cause: err }) : new Error(message, { cause: err });
    }
    throw err;
  }
}
