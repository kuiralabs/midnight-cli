// Registering a wallet's NIGHT for Dust generation and waiting until it has
// Dust to spend. `mn dust register` and `mn dev` both register through here.

import { waitForLiteSyncedState } from './facade.ts';
import { CANCELLED_MESSAGE } from './errors.ts';
import { ensureDust } from './transfer.ts';
import { defaultRepository } from './wallet-data-repository.ts';
import type { NetworkConfig } from './network.ts';
import type { CallSdkWarnings } from './sdk-warnings.ts';
import type { VerboseLog } from './verbose.ts';

export interface DustRegisterOptions {
  signal?: AbortSignal;
  /** What the registration is doing now, for a progress line. */
  onStatus?: (status: string) => void;
  /** Wallet sync progress, as blocks applied of the highest seen. */
  onSyncProgress?: (applied: number, highest: number) => void;
  /** Which wallets the sync still waits on. */
  onSyncDetail?: (detail: string) => void;
  /** A transient SDK error the sync is retrying past. */
  onSyncWarning?: (tag: string, message: string) => void;
  /** The call's SDK warnings, listened to for the whole registration. */
  sdkWarnings: CallSdkWarnings;
  /** The call's verbose lines. */
  log?: VerboseLog;
}

export interface DustRegistration {
  /** The wallet had Dust already; nothing was registered. */
  alreadyAvailable: boolean;
  txHash?: string;
  /** The Dust balance once synced, in its smallest unit. */
  dustBalance: bigint;
}

export async function registerDust(seed: Buffer, networkConfig: NetworkConfig, options: DustRegisterOptions): Promise<DustRegistration> {
  const { signal, onStatus, onSyncProgress, onSyncDetail, onSyncWarning, sdkWarnings, log } = options;
  const stopListening = sdkWarnings.listen(onSyncWarning);
  try {
    const { result, dustBalance } = await defaultRepository().withFacade(
      seed,
      networkConfig,
      async ({ bundle, state }) => {
        if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
        onStatus?.('Checking dust status...');

        // ensureDust handles: early return if dust exists, registration
        // of unregistered UTXOs, waiting for dust coins.
        const result = await ensureDust(bundle, (status: string) => onStatus?.(status), state);

        if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);

        // Wait for dust data to be fully populated before reading balance.
        const finalState = await waitForLiteSyncedState(bundle);
        return { result, dustBalance: finalState.dust.balance(new Date()) };
      },
      {
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
