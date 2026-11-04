// Registering a wallet's NIGHT for Dust generation and waiting until it has
// Dust to spend. `mn dust register` and `mn dev` both register through here.

import { waitForLiteSyncedState } from './facade.ts';
import type { DustRegisterOptions, DustRegistration } from '@kuiralabs/midnight-cli-core/engine';
import { throwIfCancelled, type NetworkConfig, type CallSdkWarnings, type VerboseLog } from '@kuiralabs/midnight-cli-core';
import { ensureDust } from './transfer.ts';
import type { WalletDataRepository } from './wallet-data-repository.ts';
export type { DustRegisterOptions, DustRegistration } from '@kuiralabs/midnight-cli-core/engine';


/** Registers a seed's NIGHT for Dust on the engine's repository `repo`, unless it has Dust already. */
export async function registerDust(repo: WalletDataRepository, seed: Buffer, networkConfig: NetworkConfig, options: DustRegisterOptions): Promise<DustRegistration> {
  const { signal, onStatus, onSyncProgress, onSyncDetail, onSyncWarning, sdkWarnings, log, root, notice } = options;
  const stopListening = sdkWarnings.listen(onSyncWarning);
  try {
    const { result, dustBalance } = await repo.withFacade(
      seed,
      networkConfig,
      async ({ bundle, state }) => {
        throwIfCancelled(signal);
        onStatus?.('Checking dust status...');

        // ensureDust handles: early return if dust exists, registration
        // of unregistered UTXOs, waiting for dust coins.
        const result = await ensureDust(bundle, (status: string) => onStatus?.(status), state);

        throwIfCancelled(signal);

        // Wait for dust data to be fully populated before reading balance.
        const finalState = await waitForLiteSyncedState(bundle);
        return { result, dustBalance: finalState.dust.balance(new Date()) };
      },
      {
        root,
        notice,
        syncMode: 'lite',
        requireStrictSync: true,
        signal,
        onStatus,
        onSyncProgress,
        onSyncDetail,
        log,
      },
    );
    const registration: DustRegistration = { alreadyAvailable: result.alreadyAvailable, dustBalance };
    if (result.txHash) registration.txHash = result.txHash;
    return registration;
  } finally {
    stopListening();
  }
}
