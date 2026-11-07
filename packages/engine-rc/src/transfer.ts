// Shared transfer execution — used by both airdrop and transfer commands
// Handles: facade lifecycle, sync, balance check, dust, tx build/sign/prove/submit, retries

import * as ledger from '@midnightntwrk/ledger-v9';
import { getNetworkId, proveWithin, submitWithin, TOKEN_MULTIPLIER, TX_TTL_MINUTES, PROOF_TIMEOUT_MS, DUST_TIMEOUT_MS, MAX_RETRY_ATTEMPTS, STALE_UTXO_ERROR_CODE, DUST_REGISTRATION_TIMEOUT_MS, DUST_REGISTRATION_RETRY_DELAY_MS, SYNC_ATTEMPT_TIMEOUT_MS, DUST_COST_OVERHEAD, MIN_DUST_FOR_TRANSFER, isColdStartRace, isDustRelatedError, DustFeeNotGeneratedError, planRegistration, type RegistrationContext, awaitDustForFee, sleep, type EnsureDustResult, type TransferParams, type TransferResult } from '@kuiralabs/midnight-cli-core/engine';
import { CancelledError, DustRequiredError, InsufficientBalanceError, SyncTimeoutError, throwIfCancelled, type NetworkConfig, type VerboseLog, nightAmountText, NATIVE_TOKEN_TYPE, formatWait, type CallSdkWarnings } from '@kuiralabs/midnight-cli-core';
import { toDust } from '@kuiralabs/midnight-cli-core/ui';
import { MidnightBech32m, UnshieldedAddress, type DustAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { type FacadeState, type UtxoWithMeta } from '@midnightntwrk/wallet-sdk/facade';
import * as rx from 'rxjs';

import { type FacadeBundle, hasDustAvailable, quickSync } from './facade.ts';
import type { WalletDataRepository } from './wallet-data-repository.ts';




/**
 * Validate recipient address format (bech32m, matching network).
 * Returns the decoded UnshieldedAddress for use with the facade.
 */
export function validateRecipientAddress(address: string, networkConfig: NetworkConfig): UnshieldedAddress {
  const networkId = getNetworkId(networkConfig.networkId);

  try {
    return MidnightBech32m.parse(address).decode(UnshieldedAddress, networkId);
  } catch (err: any) {
    throw new Error(
      `Invalid recipient address: ${err.message}\n` +
      `Expected a bech32m address for network "${networkConfig.networkId}"`
    );
  }
}

// ── Error detection ──────────────────────────────────────────────────

// SDK error classifiers moved to ./sdk-errors.ts so wallet-data-repository
// can import them without a circular dependency. Re-exported for callers
// that still import from this module.
export { isDustRelatedError, isSdkInsufficientFundsError } from '@kuiralabs/midnight-cli-core/engine';
import { assertChainClockCurrent, fetchChainTime } from '@kuiralabs/midnight-chain';

/** The finalized transaction's identifier (what the submit returns, and `midnight tx status` takes); undefined when it has none. */
export function transactionIdOf(tx: { serialize(): Uint8Array }): string | undefined {
  try { return ledger.Transaction.deserialize('signature', 'proof', 'binding', tx.serialize()).identifiers()[0]; } catch { return undefined; }
}

/** How long the transfer retry waits for Dust to grow when the fee is above the pre-flight threshold. */
const DUST_GROW_WAIT_MS = 10_000;
export type { EnsureDustResult, TransferParams, TransferResult } from '@kuiralabs/midnight-cli-core/engine';


/** Format milliseconds as "Xs" or "Xm Ys" for human-friendly elapsed display. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

// ── Dust registration ────────────────────────────────────────────────

/**
 * Build, prove and submit a dust registration transaction. Separated so the
 * retry wrapper can call it on each attempt with a fresh timestamp.
 */
async function submitDustRegistration(
  bundle: FacadeBundle,
  nightUtxos: readonly UtxoWithMeta[],
  dustReceiverAddress: DustAddress,
  waitTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  // Timeout-protected: waitForSyncedState() can hang if the dust wallet's
  // shareReplay buffer cleared or the indexer is slow. Throw a retryable error
  // so registerNightUtxos' retry loop catches it.
  await Promise.race([
    bundle.facade.dust.waitForSyncedState(),
    new Promise<never>((_, reject) => setTimeout(() =>
      reject(new SyncTimeoutError('Insufficient funds: dust wallet sync timed out')), SYNC_ATTEMPT_TIMEOUT_MS)),
  ]);

  // The registration pays its own fee from the dust these coins generate, so
  // wait until they've generated enough. Estimated per attempt: the fee drifts.
  const { fee } = await bundle.facade.estimateRegistration(nightUtxos);
  await bundle.facade.waitForGeneratedDust(nightUtxos, fee, { timeoutMs: waitTimeoutMs });

  const recipe = await bundle.facade.registerNightUtxosForDustGeneration(
    nightUtxos,
    bundle.keystore.getPublicKey(),
    bundle.keystore.signDataAsync,
    dustReceiverAddress,
  );
  let finalized;
  try {
    // Cancelled before or while proving, nothing is sent.
    throwIfCancelled(signal);
    finalized = await proveWithin(bundle.facade.finalizeRecipe(recipe), PROOF_TIMEOUT_MS, signal);
    throwIfCancelled(signal);
  } catch (err) {
    // Registering books the NIGHT UTXOs; release them so a retry can book them again.
    try { await bundle.facade.revert(recipe); } catch { /* best-effort */ }
    throw err;
  }
  // Bounded: against a node that went away the SDK's submit never returns.
  return await submitWithin(bundle.facade.submitTransaction(finalized), { txId: transactionIdOf(finalized), node: bundle.nodeUrl, signal });
}

/**
 * Register NIGHT UTXOs for dust generation with retry on error 138.
 *
 * On a fresh localnet, the estimated dust capacity (allow_fee_payment) may
 * be less than the registration fee for several minutes after UTXO creation.
 * Each retry rebuilds the transaction with a newer timestamp, giving a
 * larger time delta and thus a larger allow_fee_payment.
 *
 * The host's process guard keeps the RPC noise off the terminal (core's "./process", its console option).
 */
export async function registerNightUtxos(
  bundle: FacadeBundle,
  nightUtxos: readonly UtxoWithMeta[],
  dustReceiverAddress: DustAddress,
  onStatus?: (status: string) => void,
  signal?: AbortSignal,
  /** The network and the command, for what a registration that can't pay its fee yet says to do. */
  context?: RegistrationContext,
): Promise<string> {
  const startTime = Date.now();
  const deadline = startTime + DUST_REGISTRATION_TIMEOUT_MS;
  let lastError: Error | undefined;
  let retrying = false;

  // Dust is generated in chain time, the SDK's estimates use this computer's
  // clock: refuse while the chain's clock lags (unknown when the indexer can't say).
  const chainTime = bundle.indexerHttpUrl ? await fetchChainTime(bundle.indexerHttpUrl) : null;
  if (chainTime) assertChainClockCurrent(chainTime, new Date());

  // The registration pays its fee from the Dust these UTXOs generate: say up
  // front how long that takes, and don't wait when it outlasts the deadline.
  const { fee, dustGenerationEstimations } = await bundle.facade.estimateRegistration(nightUtxos);
  const plan = planRegistration(fee, dustGenerationEstimations);
  if (plan.waitMs === null || plan.waitMs > deadline - Date.now()) {
    throw new DustFeeNotGeneratedError(plan, new Date(), context);
  }
  const waitNote = plan.waitMs > 0 ? `, fee covered in ${formatWait(plan.waitMs)}` : '';
  if (plan.waitMs > 0) {
    onStatus?.(`Waiting for the NIGHT to generate the ${toDust(plan.fee)} DUST registration fee (${formatWait(plan.waitMs)})...`);
  }

  // Once in retry mode, tick the elapsed timer every second so the spinner
  // updates continuously — during the sleep AND during submission attempts.
  const elapsedInterval = setInterval(() => {
    if (retrying && onStatus) {
      const elapsed = formatElapsed(Date.now() - startTime);
      onStatus(`Waiting for dust generation capacity (${elapsed} elapsed${waitNote})...`);
    }
  }, 1_000);

  try {
    while (Date.now() < deadline) {
      try {
        return await submitDustRegistration(bundle, nightUtxos, dustReceiverAddress, deadline - Date.now(), signal);
      } catch (err: any) {
        if (err instanceof CancelledError) throw err;
        lastError = err;
        if (isDustRelatedError(err) && Date.now() + DUST_REGISTRATION_RETRY_DELAY_MS < deadline) {
          retrying = true;
          const elapsed = formatElapsed(Date.now() - startTime);
          onStatus?.(`Waiting for dust generation capacity (${elapsed} elapsed${waitNote})...`);
          await sleep(DUST_REGISTRATION_RETRY_DELAY_MS, signal);
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error('Dust registration timed out');
  } finally {
    clearInterval(elapsedInterval);
  }
}

// ── Ensure dust (shared by transfer, airdrop, and dust register) ─────

/**
 * Ensure dust tokens are available for paying transaction fees.
 *
 * 1. If dust coins already exist → return immediately (skip registration)
 * 2. If unregistered NIGHT UTXOs exist → register them (retries up to 10 min)
 * 3. Wait for balance to become positive
 *
 * Registration is skipped when dust is already available to avoid burning
 * dust on unnecessary registration transactions. New UTXOs (e.g. change
 * outputs) can be registered later via `midnight dust register`.
 *
 * Used by: executeTransfer (transfer/airdrop commands), dustRegister command.
 * The host's process guard keeps the RPC noise off the terminal (core's "./process", its console option).
 */
export async function ensureDust(
  bundle: FacadeBundle,
  onStatus?: (status: string) => void,
  /** Pre-fetched synced state from the caller. Avoids re-fetching through
   *  facade.state() / waitForSyncedState() which are unreliable due to
   *  shareReplay({ refCount: true }) clearing its buffer between subscriptions. */
  syncedState?: FacadeState,
  /** Cancels a registration before it is sent, and the waits. */
  signal?: AbortSignal,
  /** The network and the command, for what a registration that can't pay its fee yet says to do. */
  context?: RegistrationContext,
): Promise<EnsureDustResult> {
  // Prefer caller-provided state; fall back to waitForSyncedState (best-effort).
  const state = syncedState ?? await bundle.facade.waitForSyncedState();

  // If dust coins are already available, proceed immediately.
  // Skip registration even if unregistered UTXOs exist — registration costs
  // dust, and we don't want to burn fees when dust is already sufficient.
  if (hasDustAvailable(state)) {
    onStatus?.('Dust available');
    return { alreadyAvailable: true };
  }

  // No NIGHT at all, not even in flight: there is nothing to register and no Dust will be generated.
  if (state.unshielded.availableCoins.length === 0 && (state.unshielded.pendingCoins?.length ?? 0) === 0) {
    const fund = context?.networkId === undefined ? '' : context.networkId.toLowerCase() === 'undeployed' ? ' (midnight airdrop <amount>)' : ' (transfer NIGHT to it from another wallet)';
    throw new DustRequiredError(
      `This wallet has no NIGHT, so it generates no Dust to pay fees. Fund it first${fund}, then run: midnight dust register`,
    );
  }

  // No dust — check for unregistered NIGHT UTXOs and register them.
  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin) => !coin.meta.registeredForDustGeneration,
  );

  let txHash: string | undefined;

  if (nightUtxos.length > 0) {
    onStatus?.(`Registering ${nightUtxos.length} UTXO(s) for dust generation...`);

    txHash = await registerNightUtxos(bundle, nightUtxos, state.dust.address, onStatus, signal, context);
  } else {
    onStatus?.('UTXOs already registered, waiting for dust generation...');
  }

  // Poll for balance using waitForSyncedState() to avoid shareReplay
  // buffer clearing between subscriptions (same issue as the initial check).
  // Each call is timeout-protected so a hung waitForSyncedState() can't block
  // the deadline check indefinitely.
  onStatus?.('Waiting for dust tokens...');
  const pollStart = Date.now();
  while (Date.now() - pollStart < DUST_TIMEOUT_MS) {
    try {
      const pollState = await Promise.race([
        bundle.facade.waitForSyncedState(),
        new Promise<never>((_, reject) => setTimeout(() =>
          reject(new SyncTimeoutError('Poll sync timed out')), SYNC_ATTEMPT_TIMEOUT_MS)),
      ]);
      if (pollState.dust.balance(new Date()) > 0n) {
        onStatus?.('Dust available');
        return { alreadyAvailable: false, txHash };
      }
    } catch {
      // Timeout or sync error — continue polling until deadline
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new SyncTimeoutError(
    'Timed out waiting for dust tokens. ' +
    'Try running: midnight dust register'
  );
}

// ── Transfer build/submit ────────────────────────────────────────────

/**
 * Build, sign, prove, and submit a transfer transaction.
 *
 * Retries on:
 * - Stale UTXO (error 115): quick-sync and retry immediately (up to 3 attempts)
 * - Dust-related errors: re-ensure dust is available, then retry (up to 10 min)
 */
async function buildAndSubmitTransfer(
  bundle: FacadeBundle,
  recipientAddress: UnshieldedAddress,
  amount: bigint,
  onProving?: () => void,
  onSubmitting?: () => void,
  onDust?: (status: string) => void,
  onSubmittingTick?: (elapsedMs: number) => void,
  signal?: AbortSignal,
  log?: VerboseLog,
  /** The network and the command, for a registration on the way. */
  registration?: RegistrationContext,
): Promise<string> {
  const startTime = Date.now();
  // Use DUST_TIMEOUT_MS (2 min) not DUST_REGISTRATION_TIMEOUT_MS (10 min) —
  // ensureDust already ran before us, so this is only for edge cases where
  // dust became insufficient between ensureDust and transferTransaction.
  const dustDeadline = startTime + DUST_TIMEOUT_MS;
  let lastError: Error | undefined;
  let staleAttempts = 0;

  while (true) {
    try {
      // A call cancelled between attempts stops before building another.
      throwIfCancelled(signal);
      if (lastError) {
        await quickSync(bundle, 'lite');
      }

      const ttl = new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);

      log?.('transfer', 'Building transfer transaction...');
      const unprovenRecipe = await bundle.facade.transferTransaction(
        [
          {
            type: 'unshielded',
            outputs: [
              {
                amount,
                receiverAddress: recipientAddress,
                type: ledger.unshieldedToken().raw,
              },
            ],
          },
        ],
        { ttl, payFees: true },
      );

      log?.('transfer', 'Signing recipe...');
      const signedRecipe = await bundle.facade.signRecipe(unprovenRecipe, bundle.keystore.signDataAsync);

      throwIfCancelled(signal);
      log?.('transfer', 'Generating ZK proof...');
      onProving?.();
      // Cancelled while proving, the call stops at once: nothing was sent.
      const finalizedTx = await proveWithin(bundle.facade.finalizeRecipe(signedRecipe), PROOF_TIMEOUT_MS, signal);
      throwIfCancelled(signal);

      log?.('transfer', 'Submitting transaction to node...');
      onSubmitting?.();
      // SDK v4's facade.submitTransaction blocks until block finalization
      // (typically 12 to 30s on hosted networks). Tick a 1-second timer so
      // callers can render an elapsed counter and not look stuck.
      const submitStarted = Date.now();
      const tickInterval = onSubmittingTick
        ? setInterval(() => onSubmittingTick(Date.now() - submitStarted), 1000)
        : undefined;
      let txHash: string;
      try {
        // Bounded: against a node that went away the SDK's submit never returns.
        txHash = await submitWithin(bundle.facade.submitTransaction(finalizedTx), { txId: transactionIdOf(finalizedTx), node: bundle.nodeUrl, signal });
      } finally {
        if (tickInterval) clearInterval(tickInterval);
      }
      log?.('transfer', `Transaction submitted: ${txHash}`);
      return txHash;
    } catch (err: any) {
      // Cancelled: no retry.
      if (err instanceof CancelledError) throw err;
      lastError = err;

      // Stale UTXO: quick-sync and retry immediately (limited attempts)
      const isStaleUtxo = err?.code === STALE_UTXO_ERROR_CODE ||
        err?.message?.includes('115') ||
        err?.message?.toLowerCase().includes('stale');

      if (isStaleUtxo && ++staleAttempts < MAX_RETRY_ATTEMPTS) {
        continue;
      }

      // SDK "insufficient funds" (of NIGHT) means the internal coin index is
      // empty even though we pre-flight-checked the balance. Bubble up — the
      // outer retry will restart the facade. A Dust shortage is not that: it
      // goes to the Dust path below, which waits for the fee.
      if (isColdStartRace(err)) {
        throw err;
      }

      // Dust-related: check sufficiency, re-ensure dust, then retry
      if (isDustRelatedError(err) && Date.now() < dustDeadline) {
        const elapsed = formatElapsed(Date.now() - startTime);
        onDust?.(`Dust insufficient, re-ensuring (${elapsed} elapsed)...`);
        try {
          const freshState = await quickSync(bundle, 'lite');
          // Below the fee threshold: wait when the Dust is moments away, else fail fast.
          await awaitDustForFee(freshState.dust, MIN_DUST_FOR_TRANSFER, onDust, signal);
          // At or above it, this transaction's fee is higher than the threshold
          // (more inputs, other fee prices): give the Dust time to grow rather
          // than rebuilding back to back.
          if (freshState.dust.balance(new Date()) >= MIN_DUST_FOR_TRANSFER) {
            onDust?.(`Dust is short of this transaction's fee (another transaction from this wallet may be holding some); waiting ${DUST_GROW_WAIT_MS / 1000} s for more...`);
            await sleep(DUST_GROW_WAIT_MS, signal);
          }
          await ensureDust(bundle, onDust, freshState, signal, registration);
        } catch (retryErr: any) {
          // Re-throw "Insufficient dust" immediately — not retryable
          if (String(retryErr?.message).startsWith('Insufficient dust')) throw retryErr;
          if (retryErr instanceof CancelledError) throw retryErr;
          // quickSync or ensureDust may fail (shareReplay stale-read) — wait and retry anyway
          await sleep(5_000, signal);
        }
        continue;
      }

      throw err;
    }
  }
}

// ── Main transfer flow ───────────────────────────────────────────────

/**
 * Execute a full transfer flow on the engine's repository `repo`. The
 * lifecycle and recovery loops live in `repo.withFacade(...)`: pre-prime dust, sync-retry on stale-cache /
 * timeout, cold-start race retry on SDK InsufficientFunds, save+invalidate
 * on success, stopFacade in finally. This function only owns the
 * transfer-specific work: pre-flight checks (balance, dust threshold),
 * `ensureDust` orchestration, and the build/sign/prove/submit retry loop
 * (handled inside `buildAndSubmitTransfer` for stale-UTXO + dust errors).
 */
export async function executeTransfer(repo: WalletDataRepository, params: TransferParams): Promise<TransferResult> {
  const {
    seedBuffer,
    networkConfig,
    recipientAddress,
    amount,
    signal,
    onSync,
    onSyncDetail,
    onDust,
    onProving,
    onSubmitting,
    onSubmittingTick,
    onSyncWarning,
    sdkWarnings,
    log,
    root,
    notice,
  } = params;

  if (amount <= 0n) {
    throw new Error('Amount must be greater than 0');
  }
  const decodedAddress = validateRecipientAddress(recipientAddress, networkConfig);

  // Suppress SDK transient errors + polkadot-js RPC noise for the duration
  // of the transfer (covers dust registration AND tx submission).
  const stopListening = sdkWarnings.listen(onSyncWarning);

  try {
    return await repo.withFacade(
      seedBuffer,
      networkConfig,
      async ({ bundle, state }) => {
        throwIfCancelled(signal);

        log?.('transfer', 'Sync complete, checking balance...');
        const unshieldedBalance = state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
        const availableCoinCount = state.unshielded.availableCoins?.length ?? 0;
        log?.('transfer', `Balance: ${Number(unshieldedBalance) / TOKEN_MULTIPLIER} NIGHT, coins: ${availableCoinCount}`);
        if (unshieldedBalance < amount) {
          const haveNight = Number(unshieldedBalance) / TOKEN_MULTIPLIER;
          throw new InsufficientBalanceError(
            `Insufficient balance: ${haveNight.toFixed(6)} NIGHT available, ` +
            `${nightAmountText(amount)} NIGHT requested`
          );
        }

        // Pre-flight: below the fee threshold, wait when the Dust is moments
        // away (just after registering), else fail fast with how long it takes.
        await awaitDustForFee(state.dust, MIN_DUST_FOR_TRANSFER, onDust, signal);

        throwIfCancelled(signal);

        log?.('transfer', 'Ensuring dust availability...');
        const registration: RegistrationContext = { networkId: networkConfig.networkId, retry: 'the transfer' };
        const dustResult = await ensureDust(bundle, onDust, state, signal, registration);
        // When ensureDust had to wait, it returned once any Dust showed (right
        // after registering that can be less than the fee): wait for the fee on
        // current state. Time-boxed like every other sync wait; skipped on timeout.
        if (!dustResult.alreadyAvailable) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const current = await Promise.race([
            bundle.facade.waitForSyncedState(),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SYNC_ATTEMPT_TIMEOUT_MS); }),
          ]).finally(() => clearTimeout(timer));
          if (current) await awaitDustForFee(current.dust, MIN_DUST_FOR_TRANSFER, onDust, signal);
        }
        log?.('transfer', 'Dust available');

        throwIfCancelled(signal);

        log?.('transfer', 'Building and submitting transaction...');
        const txHash = await buildAndSubmitTransfer(
          bundle,
          decodedAddress,
          amount,
          onProving,
          onSubmitting,
          onDust,
          onSubmittingTick,
          signal,
          log,
          registration,
        );
        return { txHash, amountMicroNight: amount };
      },
      {
        root,
        notice,
        syncMode: 'lite',
        // Writes build ZK proofs — need strict sync or the commitment tree
        // is stale and chain rejects with MalformedError::InvalidDustSpendProof.
        requireStrictSync: true,
        signal,
        onStatus: onDust,
        onSyncProgress: onSync,
        onSyncDetail,
        onSyncWarning,
        log,
      },
    );
  } finally {
    stopListening();
  }
}
