// The beta engine's wallet, as the rest of mn uses it: each operation runs the
// SDK's wallet (the facade) or mn's readers and hands back mn's own types.
// The flows are the ones the commands, the test preparation and mn serve ran
// themselves before the SDK moved behind the engine.

import { deriveUnshieldedAddress } from './derive-address.ts';
import { assertSpendsNoOfferCoin, readOpenOffers } from '@kuiralabs/midnight-cli-core/lib/open-offers';
import { spentNullifiers } from './offer-reader.ts';
import * as ledger from '@midnightntwrk/ledger-v9';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import type {
  DAppConnector,
  EngineWallet,
  OpenedConnector,
  PrepWallet,
  ServedWalletSession,
  ShieldedTransferParams,
} from '@kuiralabs/midnight-cli-core/lib/engine';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import { getNetworkId } from '@kuiralabs/midnight-cli-core/lib/network-id';
import { bindCachesToIndexer, describeIndexerChange } from '@kuiralabs/midnight-cli-core/lib/cache-indexer';
import { loadWalletCache, saveWalletCache } from '@kuiralabs/midnight-cli-core/lib/wallet-cache';
import { DUST_SHORT_WAIT_MS, payWhenDustCovers } from '@kuiralabs/midnight-cli-core/lib/dust-wait';
import { assertLedgerSupported } from '@kuiralabs/midnight-chain/lib/ledger-guard';
import { trackElapsed } from '@kuiralabs/midnight-cli-core/ui/spinner';
import { decodeShieldedAddress } from './addresses.ts';
import { buildFacade, hasDustAvailable, isFacadeSynced, startAndSyncFacade, stopFacade, waitForDustAvailable } from './facade.ts';
import { ensureDust, executeTransfer } from './transfer.ts';
import { airdropNight } from './airdrop.ts';
import { registerDust } from './dust-register.ts';
import { exportDustSnapshot } from './dust-export.ts';
import { defaultRepository } from './wallet-data-repository.ts';
import { createDAppConnector } from './dapp-connector.ts';

const HOUR_MS = 60 * 60 * 1000;

async function shieldedTransfer(params: ShieldedTransferParams): Promise<string> {
  const { seed, network, networkConfig, amount, progress, signal } = params;
  const networkId = getNetworkId(networkConfig.networkId);
  const nightToken = ledger.unshieldedToken().raw;
  const receiverAddress = decodeShieldedAddress(params.recipient, network);

  return defaultRepository().withFacade(
    seed,
    networkConfig,
    async ({ bundle, state }) => {
      params.onSenderShieldedAddress?.(MidnightBech32m.encode(networkId, state.shielded.address).asString());

      const shieldedBalance = state.shielded.balances[nightToken] ?? 0n;
      if (shieldedBalance < amount) {
        throw new Error(params.insufficient((Number(shieldedBalance) / 1_000_000).toFixed(6)));
      }

      progress.update('Checking dust...');
      await ensureDust(bundle, (status: string) => progress.update(status));

      throwIfCancelled(signal);

      progress.update('Building shielded transaction...');
      const build = () => bundle.facade.transferTransaction(
        [{
          type: 'shielded' as const,
          outputs: [{ type: nightToken, amount, receiverAddress }],
        }],
        bundle.secretKeys,
        { ttl: new Date(Date.now() + HOUR_MS) },
      );
      const recipe = params.waitForDustToCover
        ? await payWhenDustCovers(build, state.dust, { maxWaitMs: DUST_SHORT_WAIT_MS, onStatus: (status) => progress.update(status), signal })
        : await build();

      progress.update('Signing...');
      const signed = await bundle.facade.signRecipe(recipe, bundle.keystore.signDataAsync);

      progress.update('Generating ZK proof (this may take a few minutes)...');
      const finalized = await bundle.facade.finalizeRecipe(signed);

      // Spending an open swap offer's coins would cancel it: refused.
      const open = readOpenOffers(network, deriveUnshieldedAddress(seed, network));
      if (open.length > 0) {
        try {
          assertSpendsNoOfferCoin(open, spentNullifiers(Buffer.from(finalized.serialize()).toString('hex')));
        } catch (err) {
          try { await bundle.facade.revert(finalized); } catch { /* best-effort */ }
          throw err;
        }
      }

      // facade.submitTransaction blocks until the chain finalizes the block
      // (typically 12 to 30s on hosted networks, ~6 to 12s on localnet).
      // trackElapsed updates the spinner once a second so users see the wait
      // is alive, not stuck.
      const txId = await trackElapsed(
        progress,
        'Submitting and waiting for finalization (typically 12 to 30s)...',
        bundle.facade.submitTransaction(finalized),
      );
      return String(txId);
    },
    {
      syncMode: 'full',
      log: params.log,
      requireStrictSync: true,
      signal,
      onStatus: params.onStatus,
      onSyncProgress: params.onSyncProgress,
      onSyncDetail: params.onSyncDetail,
    },
  );
}

/** The wallet a test's preparation checks, built from its saved state and synced quickly (no shielded sync). */
async function syncedPrepWallet(wallet: PrepWallet, reportSync: boolean, beforeSync?: () => void) {
  bindCachesToIndexer(wallet.network, wallet.networkConfig.indexerWS);
  const bundle = await buildFacade(wallet.seed, wallet.networkConfig, loadWalletCache(wallet.address, wallet.network));
  try {
    beforeSync?.();
    const state = await startAndSyncFacade(bundle, {
      syncMode: 'lite',
      signal: wallet.signal,
      ...(reportSync
        ? {
          onProgress: (applied: number, highest: number) => {
            if (highest > 0) {
              const pct = Math.min(Math.round((applied / highest) * 100), 100);
              wallet.onMessage(`Syncing wallet... ${pct}%`);
            }
          },
          onSyncDetail: (detail: string) => wallet.onMessage(`Syncing wallet... (${detail})`),
        }
        : {}),
    });
    return { bundle, state };
  } catch (err) {
    try { await stopFacade(bundle); } catch { /* best-effort */ }
    throw err;
  }
}

async function prepNightBalance(wallet: PrepWallet): Promise<bigint> {
  const { bundle, state } = await syncedPrepWallet(wallet, true);
  try {
    const balance = state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
    if (balance > 0n) {
      try { await saveWalletCache(wallet.address, wallet.network, bundle.facade); } catch { /* best-effort */ }
    }
    return balance;
  } finally {
    try { await stopFacade(bundle); } catch { /* best-effort */ }
  }
}

async function prepDust(wallet: PrepWallet, waitMs: number): Promise<{ alreadyAvailable: boolean; dustAvailable: boolean }> {
  const { bundle } = await syncedPrepWallet(wallet, false, () => wallet.onMessage('Syncing wallet...'));
  try {
    // Register dust (auto-registers UTXOs if needed, no-op if already available)
    wallet.onMessage('Ensuring dust...');
    const result = await ensureDust(bundle, (status) => wallet.onMessage(`Dust: ${status}`));
    if (result.alreadyAvailable) {
      wallet.onMessage('Dust already available');
      try { await saveWalletCache(wallet.address, wallet.network, bundle.facade); } catch { /* best-effort */ }
      return { alreadyAvailable: true, dustAvailable: true };
    }

    // Dust was just registered: wait for coins to actually appear on chain.
    // This must use the same facade to get real-time state updates.
    wallet.onMessage('Dust registered. Waiting for coins to become available...');
    const dustAvailable = hasDustAvailable(await waitForDustAvailable(bundle, waitMs, wallet.signal));
    if (dustAvailable) {
      wallet.onMessage('Dust is available');
      try { await saveWalletCache(wallet.address, wallet.network, bundle.facade); } catch { /* best-effort */ }
    }
    return { alreadyAvailable: false, dustAvailable };
  } finally {
    try { await stopFacade(bundle); } catch { /* best-effort */ }
  }
}

const openConnector: EngineWallet['openConnector'] = async (options): Promise<OpenedConnector> => {
  const { seed, network, networkConfig, address, syncMode, signal, onMessage } = options;
  // On a ledger-8 chain the SDK's sync would retry forever.
  await assertLedgerSupported(network, networkConfig, undefined, signal);
  // A failure before the connector is handed back stops what was started, so
  // the facade doesn't keep syncing.
  let bundle: Awaited<ReturnType<typeof buildFacade>> | undefined;
  let connector: DAppConnector;
  try {
    // Build & sync facade
    onMessage('Building wallet facade...');
    const indexerChange = bindCachesToIndexer(network, networkConfig.indexerWS);
    if (indexerChange) onMessage(describeIndexerChange(network, indexerChange));
    // As the repository's own borrowers do: warm the Dust checkpoint, then
    // restore from it when there is no saved wallet, instead of the SDK
    // replaying the chain's whole Dust history (minutes on a hosted network).
    const repo = defaultRepository();
    // Best-effort, as there: a failed warm-up leaves the sync below to do it.
    try {
      await repo.dust(seed, networkConfig, { signal, onStatus: onMessage });
    } catch {
      throwIfCancelled(signal); // a cancel is not a failed warm-up
    }
    const cache = await repo.walletStateToRestore(seed, networkConfig, network);
    const built = await buildFacade(seed, networkConfig, cache);
    bundle = built;

    onMessage('Syncing wallet...');
    await startAndSyncFacade(built, {
      syncMode,
      signal,
      onProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          onMessage(`Syncing wallet... ${pct}%`);
        }
      },
    });
    onMessage('Wallet synced');

    // Wait for dust
    onMessage('Waiting for dust...');
    const syncedState = await waitForDustAvailable(built, undefined, signal);
    onMessage('Dust ready');

    // Save cache after sync
    try { await saveWalletCache(address, network, built.facade); } catch { /* best-effort */ }

    // Create DApp Connector — approve-all mode for tests
    connector = createDAppConnector({
      bundle: built,
      networkConfig,
      approvalOptions: { approveAll: true, autoApproveReads: true },
      // Reads answer from the state this sync ended on, and from every later
      // one that is synced by the rule the sync used.
      initialState: syncedState,
      isCurrent: (state) => isFacadeSynced(state, syncMode, built.emptyStreams),
      dustWaitMs: options.dustWaitMs,
      openOffers: () => readOpenOffers(network, address),
      callbacks: {
        onPhaseStart: (_connId, _method, phase) => {
          onMessage(`${phase}...`);
        },
        onPhaseComplete: (_connId, _method, phase, durationMs) => {
          onMessage(`${phase} ${Math.round(durationMs)}ms`);
        },
      },
    });
  } catch (err) {
    if (bundle !== undefined) { try { await stopFacade(bundle); } catch { /* best-effort */ } }
    throw err;
  }
  const started = bundle;
  return {
    connector,
    async stop() {
      connector.dispose();
      try { await stopFacade(started); } catch { /* best-effort */ }
    },
  };
};

const serveWallet: EngineWallet['serveWallet'] = (options, serve) => {
  const { seed, networkConfig, network, address, syncMode } = options;
  // The repository owns validating the caches, priming Dust, building the
  // facade, syncing (with retries) and stopping it. Its save is skipped: mn
  // serve saves only when no transaction is pending, since the SDK drops
  // pending Dust on serialization and would persist dust=0.
  return defaultRepository().withFacade(seed, networkConfig, async ({ bundle }) => {
    let lastState: Awaited<ReturnType<typeof waitForDustAvailable>> | undefined;
    const session: ServedWalletSession = {
      async waitForDust() {
        lastState = await waitForDustAvailable(bundle);
        return hasDustAvailable(lastState);
      },
      async saveState() {
        try { await saveWalletCache(address, network, bundle.facade); } catch { /* best-effort */ }
      },
      connect: ({ approvalOptions, feeLimits, callbacks }) => createDAppConnector({
        bundle,
        networkConfig,
        approvalOptions,
        feeLimits,
        callbacks,
        // Reads answer from the state this sync ended on, and from every later
        // one that is synced by the rule the sync used.
        initialState: lastState,
        isCurrent: (state) => isFacadeSynced(state, syncMode, bundle.emptyStreams),
        openOffers: () => readOpenOffers(network, address),
      }),
    };
    return serve(session);
  }, {
    syncMode,
    // serve accepts write requests from dApps — must be strictly synced.
    requireStrictSync: true,
    skipAutoSave: true,
    signal: options.signal,
    log: options.log,
    onStatus: options.onStatus,
    onSyncProgress: options.onSyncProgress,
    onSyncDetail: options.onSyncDetail,
  });
};

export const betaWallet: EngineWallet = {
  unshieldedBalance: (address, networkConfig, options) => defaultRepository().unshielded(address, networkConfig, options),
  async dustBalance(seed, networkConfig, options) {
    const { state: _state, ...balance } = await defaultRepository().dust(seed, networkConfig, options);
    return balance;
  },
  transfer: executeTransfer,
  airdrop: airdropNight,
  shieldedTransfer,
  registerDust,
  exportDust: (seed, network, networkConfig, options) => exportDustSnapshot(seed, network, networkConfig, options),
  prepNightBalance,
  prepDust,
  openConnector,
  serveWallet,
};
