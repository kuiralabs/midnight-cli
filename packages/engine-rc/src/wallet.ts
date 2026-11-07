// The rc engine's wallet, as the rest of mn uses it: each operation runs the
// SDK's wallet (the facade) or mn's readers and hands back mn's own types.
// The flows are the ones the commands, the test preparation and mn serve ran
// themselves before the SDK moved behind the engine.

import { deriveUnshieldedAddress } from './derive-address.ts';
import { assertSpendsNoOfferCoin, type DAppConnector, type EngineWallet, type OpenedConnector, type PrepWallet, type ServedWalletSession, type ShieldedTransferParams, reportingEngineErrors, getNetworkId, bindCachesToIndexer, describeIndexerChange, loadWalletCache, saveWalletCache, DUST_SHORT_WAIT_MS, payWhenDustCovers, proveWithin, submitWithin, PROOF_TIMEOUT_MS } from '@kuiralabs/midnight-cli-core/engine';
import { readOpenOffers, InsufficientBalanceError, throwIfCancelled } from '@kuiralabs/midnight-cli-core';
import { trackElapsed } from '@kuiralabs/midnight-cli-core/ui';
import { spentNullifiers } from './offer-reader.ts';
import * as ledger from '@midnightntwrk/ledger-v9';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format';
import { assertLedgerSupported } from '@kuiralabs/midnight-chain';
import { decodeShieldedAddress } from './addresses.ts';
import { buildFacade, hasDustAvailable, isFacadeSynced, startAndSyncFacade, stopFacade, waitForDustAvailable } from './facade.ts';
import { ensureDust, executeTransfer, transactionIdOf } from './transfer.ts';
import { airdropNight } from './airdrop.ts';
import { registerDust } from './dust-register.ts';
import { exportDustSnapshot } from './dust-export.ts';
import type { WalletDataRepository } from './wallet-data-repository.ts';
import { createDAppConnector } from './dapp-connector.ts';

const HOUR_MS = 60 * 60 * 1000;

async function shieldedTransfer(repo: WalletDataRepository, params: ShieldedTransferParams): Promise<string> {
  const { seed, root, notice, network, networkConfig, amount, progress, signal } = params;
  const networkId = getNetworkId(networkConfig.networkId);
  const nightToken = ledger.unshieldedToken().raw;
  const receiverAddress = decodeShieldedAddress(params.recipient, network);

  return repo.withFacade(
    seed,
    networkConfig,
    async ({ bundle, state }) => {
      params.onSenderShieldedAddress?.(MidnightBech32m.encode(networkId, state.shielded.address).asString());

      const shieldedBalance = state.shielded.balances[nightToken] ?? 0n;
      if (shieldedBalance < amount) {
        throw new InsufficientBalanceError(params.insufficient((Number(shieldedBalance) / 1_000_000).toFixed(6)));
      }

      progress.update('Checking dust...');
      await ensureDust(bundle, (status: string) => progress.update(status), undefined, signal, { networkId: networkConfig.networkId, retry: 'the transfer' });

      throwIfCancelled(signal);

      progress.update('Building shielded transaction...');
      const build = () => bundle.facade.transferTransaction(
        [{
          type: 'shielded' as const,
          outputs: [{ type: nightToken, amount, receiverAddress }],
        }],
        { ttl: new Date(Date.now() + HOUR_MS) },
      );
      const recipe = params.waitForDustToCover
        ? await payWhenDustCovers(build, state.dust, { maxWaitMs: DUST_SHORT_WAIT_MS, onStatus: (status) => progress.update(status), signal })
        : await build();

      progress.update('Signing...');
      const signed = await bundle.facade.signRecipe(recipe, bundle.keystore.signDataAsync);

      progress.update('Generating ZK proof (this may take a few minutes)...');
      // Cancelled while proving, the call stops at once: nothing was sent.
      const finalized = await proveWithin(bundle.facade.finalizeRecipe(signed), PROOF_TIMEOUT_MS, signal);
      throwIfCancelled(signal);

      // Spending an open swap offer's coins would cancel it: refused.
      const open = readOpenOffers(root, network, deriveUnshieldedAddress(seed, network));
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
        // Bounded: against a node that went away the SDK's submit never returns.
        submitWithin(bundle.facade.submitTransaction(finalized), { txId: transactionIdOf(finalized), node: bundle.nodeUrl, signal }),
      );
      return String(txId);
    },
    {
      root,
      notice,
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
  bindCachesToIndexer(wallet.network, wallet.networkConfig.indexerWS, wallet.root);
  const bundle = await buildFacade(wallet.seed, wallet.networkConfig, wallet.root, wallet.notice, loadWalletCache(wallet.address, wallet.network, wallet.root));
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
      try { await saveWalletCache(wallet.address, wallet.network, bundle.facade, wallet.root); } catch { /* best-effort */ }
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
      try { await saveWalletCache(wallet.address, wallet.network, bundle.facade, wallet.root); } catch { /* best-effort */ }
      return { alreadyAvailable: true, dustAvailable: true };
    }

    // Dust was just registered: wait for coins to actually appear on chain.
    // This must use the same facade to get real-time state updates.
    wallet.onMessage('Dust registered. Waiting for coins to become available...');
    const dustAvailable = hasDustAvailable(await waitForDustAvailable(bundle, waitMs, wallet.signal));
    if (dustAvailable) {
      wallet.onMessage('Dust is available');
      try { await saveWalletCache(wallet.address, wallet.network, bundle.facade, wallet.root); } catch { /* best-effort */ }
    }
    return { alreadyAvailable: false, dustAvailable };
  } finally {
    try { await stopFacade(bundle); } catch { /* best-effort */ }
  }
}

async function openConnector(repo: WalletDataRepository, options: Parameters<EngineWallet['openConnector']>[0]): Promise<OpenedConnector> {
  const { seed, root, notice, network, networkConfig, address, syncMode, signal, onMessage } = options;
  // On a ledger-8 chain the SDK's sync would retry forever.
  await assertLedgerSupported(network, networkConfig, undefined, signal);
  // A failure before the connector is handed back stops what was started, so
  // the facade doesn't keep syncing.
  let bundle: Awaited<ReturnType<typeof buildFacade>> | undefined;
  let connector: DAppConnector;
  try {
    // Build & sync facade
    onMessage('Building wallet facade...');
    const indexerChange = bindCachesToIndexer(network, networkConfig.indexerWS, root);
    if (indexerChange) onMessage(describeIndexerChange(network, indexerChange));
    // As the repository's own borrowers do: warm the Dust checkpoint, then
    // restore from it when there is no saved wallet, instead of the SDK
    // replaying the chain's whole Dust history (minutes on a hosted network).
    // Best-effort, as there: a failed warm-up leaves the sync below to do it.
    try {
      await repo.dust(seed, networkConfig, { root, notice, signal, onStatus: onMessage });
    } catch {
      throwIfCancelled(signal); // a cancel is not a failed warm-up
    }
    const cache = await repo.walletStateToRestore(seed, networkConfig, network, root, notice);
    const built = await buildFacade(seed, networkConfig, root, notice, cache);
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
    try { await saveWalletCache(address, network, built.facade, root); } catch { /* best-effort */ }

    // Create DApp Connector — approve-all mode for tests
    connector = createDAppConnector({
      bundle: built,
      networkConfig,
      // Approves every request: nobody is asked.
      approvalOptions: { approveAll: true, autoApproveReads: true, prompter: null, notice },
      notice,
      // Reads answer from the state this sync ended on, and from every later
      // one that is synced by the rule the sync used.
      initialState: syncedState,
      isCurrent: (state) => isFacadeSynced(state, syncMode, built.emptyStreams),
      dustWaitMs: options.dustWaitMs,
      openOffers: () => readOpenOffers(root, network, address),
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
}

function serveWallet<T>(repo: WalletDataRepository, options: Parameters<EngineWallet['serveWallet']>[0], serve: (session: ServedWalletSession) => Promise<T>): Promise<T> {
  const { seed, root, notice, networkConfig, network, address, syncMode } = options;
  // The repository owns validating the caches, priming Dust, building the
  // facade, syncing (with retries) and stopping it. Its save is skipped: mn
  // serve saves only when no transaction is pending, since the SDK drops
  // pending Dust on serialization and would persist dust=0.
  return repo.withFacade(seed, networkConfig, async ({ bundle }) => {
    let lastState: Awaited<ReturnType<typeof waitForDustAvailable>> | undefined;
    const session: ServedWalletSession = {
      async waitForDust() {
        lastState = await waitForDustAvailable(bundle);
        return hasDustAvailable(lastState);
      },
      async saveState() {
        try { await saveWalletCache(address, network, bundle.facade, root); } catch { /* best-effort */ }
      },
      connect: ({ approvalOptions, feeLimits, callbacks }) => createDAppConnector({
        bundle,
        networkConfig,
        approvalOptions,
        notice,
        feeLimits,
        callbacks,
        // Reads answer from the state this sync ended on, and from every later
        // one that is synced by the rule the sync used.
        initialState: lastState,
        isCurrent: (state) => isFacadeSynced(state, syncMode, bundle.emptyStreams),
        openOffers: () => readOpenOffers(root, network, address),
      }),
    };
    return serve(session);
  }, {
    root,
    notice,
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
}

/**
 * The wallet of an engine whose repository (its caches) is `repo`. Its
 * operations report the SDK's and the node's failures as the engine
 * contract's typed errors, each carrying its code.
 */
export function createRcWallet(repo: WalletDataRepository): EngineWallet {
  return reportingEngineErrors<EngineWallet>({
    unshieldedBalance: (address, networkConfig, options) => repo.unshielded(address, networkConfig, options),
    async dustBalance(seed, networkConfig, options) {
      const { state: _state, ...balance } = await repo.dust(seed, networkConfig, options);
      return balance;
    },
    transfer: (params) => executeTransfer(repo, params),
    airdrop: (params) => airdropNight(repo, params),
    shieldedTransfer: (params) => shieldedTransfer(repo, params),
    registerDust: (seed, networkConfig, options) => registerDust(repo, seed, networkConfig, options),
    exportDust: (seed, network, networkConfig, options) => exportDustSnapshot(seed, network, networkConfig, { ...options, repository: repo }),
    prepNightBalance,
    prepDust,
    openConnector: (options) => openConnector(repo, options),
    serveWallet: (options, serve) => serveWallet(repo, options, serve),
  });
}
