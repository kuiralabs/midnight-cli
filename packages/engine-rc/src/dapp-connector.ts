// DApp Connector — implements all 18 ConnectedAPI methods as RPC handlers,
// and mn's own pricing of a transaction before it is proven
// Factory function returns a handler map for ws-rpc.ts to dispatch

import * as rx from 'rxjs';
import { type ApprovalOptions, promptApproval, createPhaseTracker, type PhaseTracker, toHex, fromHex, getNetworkId, isDustShortage, isSdkInsufficientFundsError, markingEngineCodes, ProofTimeoutError, DEFAULT_FEE_LIMITS, feeLimitRefusal, pendingLimitRefusal, type FeeLimits, assertSpendsNoOfferCoin, NotAnOfferError, describeLeg, decodeSignPayload, signedMessageBytes, DUST_SHORT_WAIT_MS, planDustWait, sleep, type DustWaitPlan, waitForDustGrowth, TX_TTL_MINUTES, PROOF_TIMEOUT_MS, DUST_RETRY_ATTEMPTS, DUST_RETRY_DELAY_MS, ABANDONED_TX_TIMEOUT_MS, submitWithin, type DAppConnector, type DAppConnectorCallbacks, dustGenerationCap, isDroppedFromPool, isDustDoubleSpendRefusal, isFeeShortRefusal, repriceAfterFeeRefusal, priceTransaction, transactionPriceToWire } from '@kuiralabs/midnight-cli-core/engine';
import { type NoticeSink, type WaitSink, DustDoubleSpentError, FeeRepricedError, TransactionInvalidatedError, LEDGER_9_FORK_VERSION, type WalletDustLock, type NetworkConfig, createApiError, type RpcHandler, type RpcHandlerContext, type OpenOffer, formatWait, OPERATOR_REJECTED_MESSAGE, APPROVAL_UNAVAILABLE_MESSAGE, PRICE_TRANSACTION_METHOD } from '@kuiralabs/midnight-cli-core';
import { dim, roughDust, toDust } from '@kuiralabs/midnight-cli-core/ui';
import { MidnightBech32m, UnshieldedAddress, ShieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import type { TransactionStage, WalletTransaction } from '@midnightntwrk/wallet-sdk';
import type { FacadeState, WalletEntry } from '@midnightntwrk/wallet-sdk/facade';
import type { FinalizedTx } from '@midnightntwrk/wallet-sdk';

import { type FacadeBundle, hasDustAvailable } from './facade.ts';
import { refusedFeeCheck } from './fee-refusal.ts';
import { estimateFeeAsBalanced } from './fee-as-balanced.ts';
import { awaitDustSpendSeen, pendingDustNonces } from './dust-spend-seen.ts';
import { inspectTxHex } from './tx-inspect.ts';
import { readOffer, spentNullifiers } from './offer-reader.ts';
import { expiredIntents, feeOnlyRefusals, readDAppTransaction, type DAppTxStage, type FeeCheckTransaction } from './fee-only-check.ts';
import { PartlySignedTransactionError, assertSignable, signRecipe } from './sign-recipe.ts';
import { fetchPartialSuccessSegments, type SegmentResult, walletsBelowLedger9 } from '@kuiralabs/midnight-chain';
export type { DAppConnector, DAppConnectorCallbacks } from '@kuiralabs/midnight-cli-core/engine';

// ── Types ──


export interface DAppConnectorOptions {
  bundle: FacadeBundle;
  networkConfig: NetworkConfig;
  approvalOptions: ApprovalOptions;
  /** Where the connector's lines for the person go (the host's notices): reverted transactions, fee estimates. */
  notice: NoticeSink;
  /** Where the lines of a wait for Dust go, shown in every mode (the host's `waiting`); `notice` when not given. */
  waiting?: WaitSink;
  /** Under --approve-fees: the most a transaction may cost, and how many may wait unsubmitted. */
  feeLimits?: FeeLimits;
  /**
   * The swap offers this wallet has open. A transaction this connector builds
   * that would spend one's coins (cancelling it) is refused, unless it is the
   * cancel itself. None when absent.
   */
  openOffers?: () => readonly OpenOffer[];
  /** The wallet's Dust lock across mn processes: held from a balancing until no transaction of this connector holds coins, so another mn paying from the wallet doesn't pick the same Dust. */
  dustLock?: WalletDustLock;
  callbacks?: DAppConnectorCallbacks;
  /**
   * The state the caller's own sync ended on. Reads answer from it at once;
   * without it they are refused ("Wallet not synced yet") until the wallet's
   * next state that counts as current, which on a hosted indexer can be the
   * better part of a minute after the server says it is ready.
   */
  initialState?: FacadeState;
  /**
   * Which wallet states count as current and replace the one reads answer
   * from. Default: the SDK's own `isSynced`, which also waits for wallets the
   * caller chose not to sync and for a flag the SDK's Dust wallet doesn't set
   * on a quiet stream. A caller that synced by another rule passes that rule.
   */
  isCurrent?: (state: FacadeState) => boolean;
  /**
   * The longest a request waits for the wallet's Dust to grow to a fee it
   * doesn't cover yet. A fee that takes longer is refused at once, with the
   * time it takes. Default: DUST_SHORT_WAIT_MS.
   */
  dustWaitMs?: number;
}

/** Which token kinds the facade balances a dApp's transaction in. */
export type TokenKindsToBalance = 'all' | Array<'dust' | 'shielded' | 'unshielded'>;


// ── Factory ──

/** Where a FiberFailure keeps the Cause its Effect failed with. The wallet
 *  SDK runs its Effects with Effect.runPromise, which rejects with one: the
 *  error the Effect failed with, and what that wraps, are under this symbol,
 *  not `cause`. */
const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');

/** The error a FiberFailure's Effect failed or died with; undefined for anything else. */
function fiberFailureOf(err: object): unknown {
  const cause = (err as Record<symbol, { _tag?: string; error?: unknown; defect?: unknown } | undefined>)[FIBER_FAILURE_CAUSE];
  if (cause?._tag === 'Fail') return cause.error;
  if (cause?._tag === 'Die') return cause.defect;
  return undefined;
}

/** Extract a human-readable detail string from an SDK/chain error.
 *  Walks nested cause chains including Effect Data.TaggedError objects, and
 *  into the error a FiberFailure holds. */
function extractErrorDetail(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    // A FiberFailure says only its failure's message: read the failure itself.
    const failure = typeof current === 'object' ? fiberFailureOf(current) : undefined;
    if (failure !== undefined) {
      current = failure;
      continue;
    }
    const anyErr = current as any;
    // Effect Data.TaggedError or standard Error
    if (current instanceof Error || (typeof current === 'object' && anyErr._tag)) {
      const tag = anyErr._tag;
      const msg = anyErr.message ?? '';
      if (tag && msg) {
        parts.push(`[${tag}] ${msg}`);
      } else if (msg) {
        parts.push(msg);
      } else if (tag) {
        parts.push(`[${tag}]`);
      }
      // Effect errors may have structured data
      if (anyErr.data && typeof anyErr.data === 'object') {
        try { parts.push(`data=${JSON.stringify(anyErr.data)}`); } catch { /* skip */ }
      }
      // Walk the cause chain (works for both Error.cause and Effect's cause field)
      current = anyErr.cause;
    } else if (typeof current === 'string') {
      parts.push(current);
      break;
    } else {
      try {
        const str = JSON.stringify(current);
        if (str && str !== '{}') parts.push(str);
        else parts.push(String(current));
      } catch { parts.push(String(current)); }
      break;
    }
  }
  // Deduplicate identical consecutive messages (SDK wraps same message at multiple levels)
  const deduped: string[] = [];
  for (const p of parts) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== p) {
      deduped.push(p);
    }
  }
  return deduped.join(' → ') || 'Unknown error';
}

export { OPERATOR_REJECTED_MESSAGE } from '@kuiralabs/midnight-cli-core';

/** The connector API's history entry for one wallet history entry. */
export type HistoryEntry = {
  txHash: string;
  txStatus:
    | { status: 'finalized'; executionStatus: Record<number, 'Success' | 'Failure'> }
    | { status: 'pending' }
    | { status: 'discarded' };
};

/**
 * Map a wallet history entry onto the connector API's shape. The wallet keeps
 * one outcome per transaction; segment 0 is the guaranteed section, which
 * every transaction has.
 * - SUCCESS: every segment succeeded, so segment 0 did.
 * - FAILURE: the ledger reports any fallible failure as a partial success,
 *   so a failure is the guaranteed section's.
 * - PARTIAL_SUCCESS: the per-segment results, which only the indexer has, are
 *   required as `segments`.
 * An entry with no recorded outcome reports none.
 */
export function toHistoryEntry(entry: WalletEntry, segments?: readonly SegmentResult[]): HistoryEntry {
  switch (entry.lifecycle.status) {
    case 'finalized':
      return { txHash: entry.hash, txStatus: { status: 'finalized', executionStatus: executionStatusOf(entry, segments) } };
    case 'rejected':
      return { txHash: entry.hash, txStatus: { status: 'discarded' } };
    case 'pending':
      return { txHash: entry.hash, txStatus: { status: 'pending' } };
  }
}

function executionStatusOf(entry: WalletEntry, segments?: readonly SegmentResult[]): Record<number, 'Success' | 'Failure'> {
  switch (entry.status) {
    case 'SUCCESS':
      return { 0: 'Success' };
    case 'FAILURE':
      return { 0: 'Failure' };
    case 'PARTIAL_SUCCESS':
      if (!segments || segments.length === 0) {
        throw new Error(`Transaction ${entry.hash} partly succeeded, but its segment results are missing`);
      }
      return Object.fromEntries(segments.map((s) => [s.id, s.success ? 'Success' : 'Failure']));
    case undefined:
      return {};
  }
}

/**
 * The connector API's name for a signature scheme. mn's unshielded key is a
 * BIP-340 Schnorr key; it never signs ECDSA, so any other tag is a bug.
 */
export function signatureScheme(tag: string): 'schnorr_bip340' {
  if (tag !== 'schnorr') {
    throw new Error(`Unexpected signature scheme "${tag}": mn signs with BIP-340 Schnorr only`);
  }
  return 'schnorr_bip340';
}

export function createDAppConnector(options: DAppConnectorOptions): DAppConnector {
  const { bundle, networkConfig, approvalOptions, callbacks, notice } = options;
  const feeLimits = options.feeLimits ?? DEFAULT_FEE_LIMITS;
  const { facade, keystore } = bundle;
  const networkId = getNetworkId(networkConfig.networkId);

  // ── State subscription — cache latest synced state ──

  const isCurrent = options.isCurrent ?? ((state: FacadeState) => state.isSynced);
  const dustWaitMs = options.dustWaitMs ?? DUST_SHORT_WAIT_MS;
  const waiting: WaitSink = options.waiting ?? ((line) => notice(line));
  let latestState: FacadeState | undefined = options.initialState;
  // From every state, synced or not: the wallets' protocol versions decide
  // which ledger the facade reads a dApp's transaction as.
  let protocolVersions: FacadeState['protocolVersion'] | undefined = options.initialState?.protocolVersion;
  const subscription = facade.state().subscribe((state) => {
    protocolVersions = state.protocolVersion;
    if (isCurrent(state)) latestState = state;
  });

  function getState(): FacadeState {
    if (!latestState) {
      throw createApiError('Disconnected', 'Wallet not synced yet');
    }
    return latestState;
  }

  /** Refuse transaction work until all three wallets are past the ledger-9 fork. */
  function assertWalletsOnLedger9(): void {
    if (!protocolVersions) {
      throw createApiError('Disconnected', 'Wallet not synced yet');
    }
    const behind = walletsBelowLedger9(protocolVersions);
    if (behind.length > 0) {
      const detail = behind.map((w) => `${w} at ${protocolVersions![w]}`).join(', ');
      throw createApiError('Disconnected',
        `This wallet can't take transactions until all three of its wallets are on ledger 9 (fork at ${LEDGER_9_FORK_VERSION}); `
        + `still behind: ${detail}. Wait for them to sync past the fork and retry.`);
    }
  }

  // ── Shared helpers ──

  // Track pending transactions per connection that haven't been submitted yet.
  // Keyed by serialized tx hex so untracking works after deserialization.
  // On rejection/disconnect/abandon we revert the FINALIZED transaction: that
  // releases the coins it spent in all three wallets and clears the pending
  // entry `finalizeRecipe` registered for it. Reverting the recipe would leave
  // that entry pending until its TTL. `feeOnly` marks a transaction this
  // connection had balanced Dust-only under --approve-fees: only its submit
  // counts as fee-only.
  const pendingTxsByConnection = new Map<string, Map<string, { finalized: FinalizedTx; timer: ReturnType<typeof setTimeout>; feeOnly: boolean }>>();

  function trackPendingTx(connectionId: string, txHex: string, finalized: FinalizedTx, feeOnly = false): void {
    let txMap = pendingTxsByConnection.get(connectionId);
    if (!txMap) {
      txMap = new Map();
      pendingTxsByConnection.set(connectionId, txMap);
    }
    // Start abandon timer — auto-revert if DApp never submits.
    const timer = setTimeout(async () => {
      txMap!.delete(txHex);
      if (txMap!.size === 0) pendingTxsByConnection.delete(connectionId);
      try { await facade.revert(finalized); } catch { /* best-effort */ }
      notice(dim(`  abandoned tx reverted (${connectionId})`));
      releaseDustIfIdle();
    }, ABANDONED_TX_TIMEOUT_MS);
    txMap.set(txHex, { finalized, timer, feeOnly });
  }

  function untrackPendingTx(connectionId: string, txHex: string): void {
    const txMap = pendingTxsByConnection.get(connectionId);
    if (!txMap) return;
    const entry = txMap.get(txHex);
    if (entry) {
      clearTimeout(entry.timer);
      txMap.delete(txHex);
    }
    if (txMap.size === 0) pendingTxsByConnection.delete(connectionId);
  }

  /**
   * Hands a built transaction on: it is no longer this connection's to revert,
   * on disconnect or by the abandon timer. A swap offer is one: its maker never
   * submits it, a taker does. False when the connection holds no such transaction.
   */
  function handOffPendingTx(connectionId: string, txHex: string): boolean {
    const held = pendingTxsByConnection.get(connectionId)?.has(txHex) ?? false;
    untrackPendingTx(connectionId, txHex);
    releaseDustIfIdle();
    return held;
  }

  /**
   * Transactions being submitted, by hex: no connection holds them any more,
   * so a disconnect or the abandon timer never reverts them (their coins are
   * spent once the node takes them); the submit reverts one the node refuses.
   */
  const submittingTxs = new Map<string, { finalized: FinalizedTx }>();

  /**
   * Takes a transaction out of whichever connection holds it, for its submit:
   * the one that built it may close, or another connection may submit it.
   * Undefined when none holds it (built elsewhere, or already being submitted).
   */
  function claimPendingTx(txHex: string): { owner: string; finalized: FinalizedTx; feeOnly: boolean } | undefined {
    for (const [owner, txMap] of pendingTxsByConnection) {
      const entry = txMap.get(txHex);
      if (entry === undefined) continue;
      untrackPendingTx(owner, txHex);
      return { owner, finalized: entry.finalized, feeOnly: entry.feeOnly };
    }
    return undefined;
  }

  /** Revert and clean up all pending transactions for a connection (disconnect). */
  async function revertPendingTxs(connectionId: string): Promise<void> {
    const txMap = pendingTxsByConnection.get(connectionId);
    if (!txMap || txMap.size === 0) return;
    pendingTxsByConnection.delete(connectionId);
    for (const [, entry] of txMap) {
      clearTimeout(entry.timer);
      try { await facade.revert(entry.finalized); } catch { /* best-effort */ }
    }
    notice(dim(`  reverted ${txMap.size} pending tx(s) on disconnect`));
    releaseDustIfIdle();
  }

  /** Lets the wallet's Dust lock go once no transaction of this connector is being built, waits to be submitted, or is being submitted. */
  function releaseDustIfIdle(): void {
    if (pendingCount() + submittingTxs.size + buildsInFlight === 0) options.dustLock?.release();
  }

  function createTtl(): Date {
    return new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);
  }

  /** Sign, prove (with timeout), and serialize a transaction recipe.
   *  Returns both the serialized hex and the finalized tx object (for tracking/revert). */
  async function processRecipe(recipe: any, tracker?: PhaseTracker, cancelling: readonly string[] = []): Promise<{ hex: string; finalized: FinalizedTx }> {
    tracker?.start('signing');
    let signed: any;
    try {
      signed = await signRecipe(facade, recipe, keystore.signDataAsync);
    } catch (err) {
      // Release what balancing booked; nothing will be tracked for this recipe.
      try { await facade.revert(recipe); } catch { /* best-effort */ }
      // The transaction's own shape, not the wallet, is what can't be signed.
      if (err instanceof PartlySignedTransactionError) throw createApiError('InvalidRequest', err.message);
      throw err;
    }
    tracker?.start('proving');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finalized: FinalizedTx;
    const finalizing = facade.finalizeRecipe(signed);
    try {
      finalized = await Promise.race([
        finalizing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProofTimeoutError()), PROOF_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // No finalized transaction to track: release what balancing booked now,
      // rather than leaving the coins held until the TTL.
      try { await facade.revert(recipe); } catch { /* best-effort */ }
      // A timed-out proof keeps running, and the SDK registers its finalized tx
      // as pending when it lands; nobody will submit it, so revert that too.
      finalizing.then((late) => facade.revert(late)).catch(() => { /* best-effort */ });
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const hex = toHex(finalized.serialize());
    // Spending an open swap offer's coins would cancel it: refused, unless this transaction is that cancel.
    const open = options.openOffers?.() ?? [];
    if (open.length > 0) {
      try {
        assertSpendsNoOfferCoin(open, spentNullifiers(hex), cancelling);
      } catch (err) {
        try { await facade.revert(finalized); } catch { /* best-effort */ }
        throw err;
      }
    }
    tracker?.complete();
    return { hex, finalized };
  }

  /**
   * Read a dApp's hex transaction at the given stage, as this wallet's current
   * ledger version. Bytes from another ledger version, or another stage, are
   * the caller's mistake, so they come back as InvalidRequest.
   */
  function adopt<TStage extends TransactionStage>(txHex: string, stage: TStage): WalletTransaction<TStage> {
    try {
      return facade.adoptTransaction(fromHex(txHex), stage);
    } catch (err) {
      throw createApiError(
        'InvalidRequest',
        `The transaction could not be read at stage ${stage} as this wallet's ledger version: ${extractErrorDetail(err)}`,
      );
    }
  }

  /** Prompt terminal approval for a write method. Throws Rejected on denial. */
  async function requireApproval(
    method: string,
    details: Array<{ label: string; value: string }> = [],
    context?: RpcHandlerContext,
    feeOnly = false,
  ): Promise<void> {
    context?.notify('approval:pending', { method });
    const result = await promptApproval(
      { method, network: networkConfig.networkId, details, dappName: context?.connectionId, feeOnly },
      approvalOptions,
    );
    const outcome = result === 'approve' ? 'approved' : result === 'reject' ? 'rejected' : 'unavailable';
    context?.notify('approval:resolved', { method, result: outcome });
    if (result === 'unavailable') {
      // Nobody was asked, so nobody rejected it: say what would let it through.
      throw createApiError('PermissionRejected', `${APPROVAL_UNAVAILABLE_MESSAGE}: ${method} needs approval, and mn serve has no terminal to ask at. `
        + (approvalOptions.approveFees
          ? 'This fee wallet (--approve-fees) approves without asking only paying the Dust fee for an agent\'s own transaction and submitting a transaction it balanced that way on the same connection.'
          : 'Start mn serve with --approve-all to approve requests without asking (or --approve-fees for a wallet that only pays an agent\'s Dust fee), or run it at a terminal.'),
        'APPROVAL_UNAVAILABLE');
    }
    if (result === 'reject') {
      throw createApiError('Rejected', approvalOptions.approveFees
        ? `${OPERATOR_REJECTED_MESSAGE}: this fee wallet (--approve-fees) approves without the operator only paying the `
          + 'Dust fee for an agent\'s own transaction and submitting a transaction it balanced that way on the same connection'
        : OPERATOR_REJECTED_MESSAGE, 'TX_REJECTED');
    }
  }

  /**
   * Fee-wallet mode (--approve-fees): refuse a dApp transaction unless paying
   * its Dust fee is all this wallet would do to it. Signing an unbound recipe
   * signs the dApp's own transaction, so Dust-only balancing alone does not
   * keep the wallet to the fee (see fee-only-check.ts).
   */
  function assertFeeOnly(txHex: string, stage: DAppTxStage, payFees: unknown): void {
    if (payFees === false) {
      throw createApiError('InvalidRequest',
        'This wallet is a fee wallet (--approve-fees): it only pays the Dust fee, so payFees: false leaves it nothing to do');
    }
    let tx: FeeCheckTransaction;
    try {
      tx = readDAppTransaction(fromHex(txHex), stage);
    } catch (err) {
      throw createApiError('InvalidRequest',
        `The transaction could not be read as a proven ledger-9 ${stage} transaction: ${extractErrorDetail(err)}`);
    }
    const reasons = feeOnlyRefusals(tx, keystore.getPublicKey());
    if (reasons.length > 0) {
      throw createApiError('Rejected',
        `This wallet is a fee wallet (--approve-fees) and pays only the Dust fee; it refuses this transaction because ${reasons.join('; ')}`);
    }
  }

  /** Refuse a dApp transaction the chain would refuse for its TTL, before anything is reserved for it. */
  function assertNotExpired(txHex: string, stage: DAppTxStage): void {
    let expired: Array<{ segment: number; ttl: Date }>;
    try {
      expired = expiredIntents(readDAppTransaction(fromHex(txHex), stage), new Date());
    } catch (err) {
      throw createApiError('InvalidRequest', extractErrorDetail(err));
    }
    if (expired.length > 0) {
      const which = expired.map(({ segment, ttl }) => `intent ${segment}'s TTL (${ttl.toISOString()})`).join(', ');
      throw createApiError('InvalidRequest', `The transaction has expired: ${which} has passed. Build it again with a later TTL.`);
    }
  }

  /** Refuse an unsealed dApp transaction the wallet can't sign without breaking it. */
  function assertDAppTxSignable(txHex: string, balancesUnshielded: boolean): void {
    try {
      assertSignable(readDAppTransaction(fromHex(txHex), 'unsealed'), balancesUnshielded);
    } catch (err) {
      throw createApiError('InvalidRequest', extractErrorDetail(err));
    }
  }

  /**
   * Fee-wallet limits, checked before anything is booked: no more than
   * `maxPending` balanced transactions may wait unsubmitted, and the total fee
   * (the dApp's tx plus the wallet's balancing tx) may not exceed `maxFee`.
   */
  function pendingCount(): number {
    let pending = 0;
    for (const [, txMap] of pendingTxsByConnection) pending += txMap.size;
    return pending;
  }

  function feeLimitError(reason: string) {
    return createApiError('Rejected', `This wallet is a fee wallet (--approve-fees) and refuses this transaction: ${reason}`);
  }

  // Fee-only balances between their limit check and being tracked as pending.
  // Counted with the pending ones, so simultaneous requests can't all pass
  // --max-pending while none of them is tracked yet.
  let feeOnlyInFlight = 0;

  /** Take one of the --max-pending slots, synchronously. Returns the release; throws when none is left. */
  function reserveFeeOnlySlot(): () => void {
    const reason = pendingLimitRefusal(pendingCount() + feeOnlyInFlight, feeLimits);
    if (reason) throw feeLimitError(reason);
    feeOnlyInFlight++;
    let released = false;
    return () => {
      if (!released) { released = true; feeOnlyInFlight--; }
    };
  }

  async function assertFeeWithinLimit(dappTx: WalletTransaction<'Unbound'> | WalletTransaction<'Finalized'>, ttl: Date): Promise<void> {
    const fee = await withDustRetry(() => facade.estimateTransactionFee(dappTx, { ttl }));
    notice(dim(`  fee-only: estimated fee ${toDust(fee)} DUST (limit ${toDust(feeLimits.maxFeeSpecks)})`));
    const reason = feeLimitRefusal(fee, feeLimits);
    if (reason) throw feeLimitError(reason);
  }

  /**
   * Balance a dApp's transaction. Under --approve-fees: Dust only, and only once
   * `assertFeeOnly` passes, never falling back to a wider balance. Otherwise
   * every token kind, or all but Dust when the dApp says `payFees: false`.
   */
  async function balanceDAppTransaction(
    method: 'balanceUnsealedTransaction' | 'balanceSealedTransaction',
    stage: DAppTxStage,
    params: Record<string, unknown>,
    context: RpcHandlerContext,
  ): Promise<{ tx: string }> {
    const txHex = String(params.tx ?? '');
    if (!txHex) {
      throw createApiError('InvalidRequest', 'tx is required');
    }
    assertWalletsOnLedger9();
    const payFees = (params.options as { payFees?: unknown } | undefined)?.payFees;
    const feeOnly = approvalOptions.approveFees === true;
    if (feeOnly) assertFeeOnly(txHex, stage, payFees);
    const tokenKindsToBalance: TokenKindsToBalance = feeOnly
      ? ['dust']
      : payFees === false ? ['shielded', 'unshielded'] : 'all';

    const ttl = createTtl();
    const dappTx = stage === 'unsealed' ? adopt(txHex, 'Unbound') : adopt(txHex, 'Finalized');
    assertNotExpired(txHex, stage);
    // Signing an unsealed transaction signs the dApp's part too; refuse one that can't be signed before booking anything.
    if (stage === 'unsealed') {
      assertDAppTxSignable(txHex, tokenKindsToBalance === 'all' || tokenKindsToBalance.includes('unshielded'));
    }
    const releaseSlot = feeOnly ? reserveFeeOnlySlot() : undefined;
    try {
      if (feeOnly) await assertFeeWithinLimit(dappTx, ttl);

      const tracker = makeTracker(method, context);

      tracker.start('approve');
      await requireApproval(method, inspectTxHex(txHex, stage), context, feeOnly);

      tracker.start('building');
      const balanceOptions = { ttl, tokenKindsToBalance };
      const hex = await building(async () => {
        let recipe: any;
        if (stage === 'unsealed') {
          const unsealedTx = dappTx as WalletTransaction<'Unbound'>;
          recipe = await withDustRetry(() => facade.balanceUnboundTransaction(unsealedTx, balanceOptions));
        } else {
          const sealedTx = dappTx as WalletTransaction<'Finalized'>;
          recipe = await withDustRetry(() => facade.balanceFinalizedTransaction(sealedTx, balanceOptions));
        }
        const { hex, finalized } = await processRecipe(recipe, tracker);
        trackPendingTx(context.connectionId, hex, finalized, feeOnly);
        return hex;
      });
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    } finally {
      releaseSlot?.();
    }
  }

  /**
   * Takes a swap offer (a sealed transaction, hex): checks the offer's own
   * signatures and proofs before building anything (a forged or tampered one
   * fails here, not after this wallet's proof), adds this wallet's half and
   * the whole swap's fee, checks the result in full, and holds it pending for
   * the connection until it is submitted. Whether these are the agreed terms,
   * and whether the offer is still live, are the caller's checks, made first.
   */
  async function takeOffer(connectionId: string, txHex: string): Promise<string> {
    assertWalletsOnLedger9();
    const { terms } = readOffer(txHex);
    const offer = adopt(txHex, 'Finalized');
    const context: RpcHandlerContext = { notify: () => {}, connectionId, requestId: 0, metadata: {} };
    const tracker = makeTracker('takeOffer', context);

    tracker.start('approve');
    await requireApproval('takeOffer', [
      { label: 'You give', value: describeLeg(terms.want) },
      { label: 'You get', value: describeLeg(terms.give) },
      ...inspectTxHex(txHex, 'sealed'),
    ], context);

    tracker.start('checking');
    try {
      await facade.validateTransaction(offer, { flags: { enforceBalancing: false, verifySignatures: true, enforceLimits: false } });
    } catch (cause) {
      throw new NotAnOfferError(`its signatures or proofs don't check (${extractErrorDetail(cause)})`, { cause });
    }

    tracker.start('building');
    const ttl = createTtl();
    const recipe: any = await withDustRetry(() => facade.balanceFinalizedTransaction(offer, { ttl, tokenKindsToBalance: 'all' }));
    const { hex, finalized } = await processRecipe(recipe, tracker);
    try {
      await facade.validateTransaction(finalized, { flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true }, blockData: recipe.blockData });
    } catch (cause) {
      try { await facade.revert(finalized); } catch { /* best-effort */ }
      throw new Error(`The swap this wallet built doesn't check, so it was not kept: ${extractErrorDetail(cause)}`, { cause });
    }
    trackPendingTx(connectionId, hex, finalized);
    return hex;
  }

  /**
   * Cancels open swap offers of this wallet's: sends the value of the offers'
   * coins back to its own shielded address, spending exactly those coins (the
   * coin picker allows no other while the cancel is built), for a fee in Dust.
   * Its other open offers stay live. Refused, and nothing kept, when the
   * wallet no longer holds every coin of every offer (one already taken), or
   * the transaction doesn't spend them all. Held pending for the connection
   * until it is submitted.
   */
  async function cancelOffers(connectionId: string, offers: readonly OpenOffer[]): Promise<string> {
    assertWalletsOnLedger9();
    const state = getState();
    const held = new Map(state.shielded.availableCoins.map((available) => [available.nullifier.toLowerCase(), available.coin]));
    const amounts = new Map<string, bigint>();
    for (const nullifier of offers.flatMap((offer) => offer.nullifiers)) {
      const coin = held.get(nullifier.toLowerCase());
      if (coin === undefined) throw createApiError('InvalidRequest', "This wallet no longer holds the offer's coins: it was taken");
      amounts.set(coin.type, (amounts.get(coin.type) ?? 0n) + coin.value);
    }
    const outputs = [...amounts].map(([type, amount]) => ({ type, amount, receiverAddress: state.shielded.address }));
    const context: RpcHandlerContext = { notify: () => {}, connectionId, requestId: 0, metadata: {} };
    const tracker = makeTracker('cancelOffers', context);
    tracker.start('approve');
    await requireApproval('cancelOffers', offers.map((offer) => ({ label: 'Cancel', value: `${offer.id.slice(0, 16)}… (${describeLeg(offer.terms.give)})` })), context);
    tracker.start('building');
    const recipe = await bundle.coinPicking.cancelling(offers, () => withDustRetry(() => facade.transferTransaction([{ type: 'shielded' as const, outputs }], { ttl: createTtl() })));
    const { hex, finalized } = await processRecipe(recipe, tracker, offers.map((offer) => offer.id));
    const spent = new Set(spentNullifiers(hex).map((n) => n.toLowerCase()));
    if (!offers.every((offer) => offer.nullifiers.every((n) => spent.has(n.toLowerCase())))) {
      try { await facade.revert(finalized); } catch { /* best-effort */ }
      throw createApiError('InvalidRequest', 'The cancel would not spend every coin of the offers: one was taken, or its coins are gone');
    }
    trackPendingTx(connectionId, hex, finalized);
    return hex;
  }

  /** Whether the wallet holds a shielded coin of `token` worth exactly `amount`, unspent and in none of its open swap offers. */
  function holdsFreeCoin(token: string, amount: bigint): boolean {
    const held = new Set((options.openOffers?.() ?? []).flatMap((offer) => offer.nullifiers.map((n) => n.toLowerCase())));
    return getState().shielded.availableCoins.some((available) => available.coin.type === token && available.coin.value === amount && !held.has(available.nullifier.toLowerCase()));
  }

  /** Encode an SDK address object to bech32m string. */
  function encodeAddress(address: any): string {
    return MidnightBech32m.encode(networkId, address).asString();
  }

  /** A token amount the dApp gives: a whole number of the smallest unit, above 0. */
  function parsePositiveAmount(value: unknown, field: string): bigint {
    let amount: bigint;
    try {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') throw new TypeError();
      amount = BigInt(value);
    } catch {
      throw createApiError('InvalidRequest', `Invalid ${field}: "${String(value)}" — must be a whole number of the token's smallest unit`);
    }
    if (amount <= 0n) throw createApiError('InvalidRequest', `Invalid ${field}: ${amount} — must be greater than 0`);
    return amount;
  }

  function parseKind(kind: unknown, of: 'input' | 'output'): 'shielded' | 'unshielded' {
    if (kind !== 'shielded' && kind !== 'unshielded') {
      throw createApiError('InvalidRequest', `Invalid ${of} kind: "${kind}" — must be "shielded" or "unshielded"`);
    }
    return kind;
  }

  function parseTokenType(type: unknown): string {
    if (typeof type !== 'string' || !/^[0-9a-fA-F]{64}$/.test(type)) {
      throw createApiError('InvalidRequest', `Invalid token type: "${type}" — must be 64 hex characters`);
    }
    return type;
  }

  /** DesiredInput[] → CombinedSwapInputs { shielded?: Record, unshielded?: Record }. */
  function parseDesiredInputs(inputs: any[]): Record<string, Record<string, bigint>> {
    if (!Array.isArray(inputs)) throw createApiError('InvalidRequest', 'desiredInputs must be an array');
    const swapInputs: Record<string, Record<string, bigint>> = {};
    for (const input of inputs) {
      const kind = parseKind(input?.kind, 'input');
      swapInputs[kind] ??= {};
      swapInputs[kind][parseTokenType(input.type)] = parsePositiveAmount(input.value, 'value');
    }
    return swapInputs;
  }

  /**
   * Convert DApp Connector DesiredOutput[] to SDK CombinedTokenTransfer[].
   *
   * Field mapping:
   *   DesiredOutput.kind  ('shielded'|'unshielded') → CombinedTokenTransfer.type
   *   DesiredOutput.type  (hex TokenType)           → TokenTransfer.type (RawTokenType)
   *   DesiredOutput.value (bigint or string)         → TokenTransfer.amount (bigint)
   *   DesiredOutput.recipient (bech32m string)       → TokenTransfer.receiverAddress (Address object)
   */
  function parseDesiredOutputs(outputs: any[]): any[] {
    if (!Array.isArray(outputs)) throw createApiError('InvalidRequest', 'desiredOutputs must be an array');
    const grouped: Record<string, any[]> = {};

    for (const output of outputs) {
      const kind = parseKind(output?.kind, 'output');
      grouped[kind] ??= [];
      const type = parseTokenType(output.type);
      const amount = parsePositiveAmount(output.value, 'value');

      let receiverAddress: any;
      try {
        receiverAddress = MidnightBech32m.parse(String(output.recipient))
          .decode(kind === 'unshielded' ? UnshieldedAddress : ShieldedAddress, networkId);
      } catch (err) {
        throw createApiError('InvalidRequest',
          `Invalid recipient: "${output.recipient}" is not ${kind === 'unshielded' ? 'an' : 'a'} ${kind} address on ${networkConfig.networkId} (${extractErrorDetail(err)})`);
      }

      grouped[kind].push({
        type,
        receiverAddress,
        amount,
      });
    }

    return Object.entries(grouped).map(([kind, transfers]) => ({
      type: kind,
      outputs: transfers,
    }));
  }

  /** Create a phase tracker wired to callbacks and context notifications. */
  function makeTracker(method: string, context?: RpcHandlerContext): PhaseTracker {
    return createPhaseTracker({
      onStart: (phase) => {
        const connId = context?.connectionId ?? 'unknown';
        callbacks?.onPhaseStart?.(connId, method, phase);
        context?.notify('progress', { method, phase, status: 'started' });
      },
      onComplete: (phase, durationMs) => {
        const connId = context?.connectionId ?? 'unknown';
        callbacks?.onPhaseComplete?.(connId, method, phase, durationMs);
        context?.notify('progress', { method, phase, status: 'completed', durationMs });
      },
    });
  }

  /** Check if dust coins are currently available via the cached state. */
  function isDustAvailable(): boolean {
    return latestState !== undefined && hasDustAvailable(latestState);
  }

  /**
   * Waits for a Dust coin to show in the wallet state: `already` there,
   * `appeared` during the wait, or `timeout`.
   */
  async function waitForDust(timeoutMs: number): Promise<'already' | 'appeared' | 'timeout'> {
    return new Promise((resolve) => {
      if (isDustAvailable()) { resolve('already'); return; }
      const sub = facade.state().pipe(
        rx.filter(() => isDustAvailable()),
        rx.take(1),
        rx.timeout(timeoutMs),
      ).subscribe({
        next: () => { sub.unsubscribe(); resolve('appeared'); },
        error: () => { sub.unsubscribe(); resolve('timeout'); },
      });
    });
  }

  /** A Dust shortage that waiting didn't fix, with what is holding the Dust (if anything is) and what to do. */
  function dustExhaustedError(err: unknown) {
    const pending = pendingCount();
    if (pending === 0) {
      // Nothing is reserved, so nothing will come free: the wallet's Dust is simply less than the fee.
      return createApiError('InternalError',
        `The wallet has no Dust available that covers this transaction's fee (${extractErrorDetail(err)}), and no balanced `
        + 'transaction is holding any back on this server. Dust builds up with time from the NIGHT registered for it: '
        + 'retry later, or register more NIGHT for Dust generation.', 'DUST_REQUIRED');
    }
    return createApiError('InternalError',
      `No Dust is free to pay the fee (${extractErrorDetail(err)}). Each balanced transaction reserves a whole Dust coin `
      + `until it is submitted and on chain, or released when its connection closes or it expires; ${pending} `
      + 'balanced transaction(s) are waiting to be submitted on this server. Retry once they settle. To pay for more '
      + 'transactions at once, the wallet needs more Dust coins: one per NIGHT UTXO registered for Dust generation.', 'DUST_REQUIRED');
  }

  /** The fee takes more Dust than the wallet's NIGHT generates in the time a request waits (`waitMs` null: within a day). */
  function dustTooFarError(have: bigint, needed: bigint, waitMs: number | null) {
    const when = waitMs === null
      ? "Its registered NIGHT won't generate that within a day: register more NIGHT for Dust generation."
      : `Its registered NIGHT generates the rest in ${formatWait(waitMs)}: retry then, or register more NIGHT to get there sooner.`;
    return createApiError('InternalError',
      `Not enough Dust available for this transaction's fee: the wallet has ${roughDust(have)} DUST and the fee takes ${roughDust(needed, true)}. ${when}`, 'DUST_REQUIRED');
  }

  /**
   * The wait for a fee the wallet's Dust doesn't cover yet, when that is all
   * there is to wait for: the shortage says what the wallet is short by, and
   * nothing balanced here is holding Dust back. Undefined otherwise.
   */
  function dustGrowthWait(err: unknown): DustWaitPlan | undefined {
    if (latestState === undefined || pendingCount() > 0) return undefined;
    return planDustWait(err, latestState.dust, new Date());
  }

  /**
   * Retries a facade call that fails for lack of Dust. When the shortage says
   * what the fee takes and the wallet simply has less, the wait is the time
   * its NIGHT takes to generate the rest: waited out when it fits in
   * `dustWaitMs`, refused at once with that time when it doesn't. Otherwise a
   * coin may come free or grow, and a few short waits find out.
   */
  /** Builds of this wallet's coins into a transaction running now: from the SDK picking its coins until it is tracked as pending, those coins are held. */
  let buildsInFlight = 0;

  /**
   * Runs a build of a transaction from this wallet's coins (pick, sign,
   * prove, track as pending), counted while it runs. The SDK's shortage of
   * free coins (not of Dust) while other transactions this server built or is
   * building hold coins until they land is said so, since another request,
   * not the wallet's balance, is the likely cause.
   */
  async function building<T>(build: () => Promise<T>): Promise<T> {
    buildsInFlight++;
    try {
      // Another mn paying from this wallet balances once its spend is on chain, not at the same time.
      await options.dustLock?.hold({ notice: (line) => notice(dim(`  ${line}`)), progress: () => {} });
      return await build();
    } catch (err) {
      throw heldByOthersOr(err);
    } finally {
      buildsInFlight--;
      releaseDustIfIdle();
    }
  }

  /** The SDK's shortage of free coins, while other transactions of this server's hold coins, as an error saying so; any other failure as it is. Called from within a build, which isn't counted. */
  function heldByOthersOr(err: unknown): unknown {
    const holding = pendingCount() + submittingTxs.size + buildsInFlight - 1;
    if (holding <= 0 || !isSdkInsufficientFundsError(err)) return err;
    const them = holding === 1 ? '1 other transaction of this wallet\'s, made here, holds coins until it is on chain or released' : `${holding} other transactions of this wallet's, made here, hold coins until they are on chain or released`;
    return createApiError('InsufficientFunds',
      `The wallet's free coins don't cover this: ${them} (being built, built and not yet submitted, or being submitted). `
      + `Retry once ${holding === 1 ? 'it has' : 'they have'} landed or been released; if it still fails, the wallet holds too little.`,
      'INSUFFICIENT_BALANCE');
  }

  async function withDustRetry<T>(fn: () => Promise<T>): Promise<T> {
    let waitedForGrowthMs = 0;
    let attempt = 1;
    for (;;) {
      try {
        return await fn();
      } catch (err: any) {
        const msg = String(err?.message ?? err ?? '');
        if (!isDustShortage(err)) throw err;
        const growth = dustGrowthWait(err);
        if (growth) {
          const { have, needed, waitMs } = growth;
          if (waitMs === null || waitedForGrowthMs + waitMs > dustWaitMs) throw dustTooFarError(have, needed, waitMs);
          // Said as it goes, the time waited and the Dust there is by then: a wait of minutes must not look like a hang.
          await waitForDustGrowth({ have, needed, waitMs }, { balance: (at) => latestState?.dust.balance(at) ?? 0n }, (line, opening) => waiting(dim(`  ${line}`), opening));
          waitedForGrowthMs += waitMs;
          continue;
        }
        if (attempt >= DUST_RETRY_ATTEMPTS) throw dustExhaustedError(err);
        notice(dim(`  dust unavailable, waiting for recovery (${attempt}/${DUST_RETRY_ATTEMPTS})... [${msg.slice(0, 60)}]`));
        // A coin that comes free during the wait (its transaction landed) is
        // tried at once. A coin that was there all along was too small for
        // the fee, and a wait that ran out found none: either way it needs
        // time, so the delay passes before the next attempt.
        if (await waitForDust(DUST_RETRY_DELAY_MS) !== 'appeared') await sleep(DUST_RETRY_DELAY_MS);
        attempt++;
      }
    }
  }

  // ── Handler map — all 18 ConnectedAPI methods ──

  const handlers: Record<string, RpcHandler> = {

    // ── Handshake (1) ──

    connect: async (params) => {
      const requestedNetwork = String(params.networkId ?? '');
      if (requestedNetwork.toLowerCase() !== networkConfig.networkId.toLowerCase()) {
        throw createApiError('InvalidRequest',
          `Network mismatch: wallet is on ${networkConfig.networkId}, requested ${requestedNetwork}`);
      }
      return { networkId: networkConfig.networkId };
    },

    // ── Read-Only Methods (9) — auto-approved ──

    getUnshieldedBalances: async () => {
      return getState().unshielded.balances;
    },

    getShieldedBalances: async () => {
      return getState().shielded.balances;
    },

    getDustBalance: async () => {
      const state = getState();
      // The cap is what the wallet's unspent NIGHT generates at most (dustGenerationCap).
      return { cap: dustGenerationCap(state.dust.totalCoins), balance: state.dust.balance(new Date()) };
    },

    getUnshieldedAddress: async () => {
      const state = getState();
      return { unshieldedAddress: encodeAddress(state.unshielded.address) };
    },

    getShieldedAddresses: async () => {
      const state = getState();
      const addr = state.shielded.address;
      return {
        shieldedAddress: encodeAddress(addr),
        shieldedCoinPublicKey: addr.coinPublicKeyString(),
        shieldedEncryptionPublicKey: addr.encryptionPublicKeyString(),
      };
    },

    getDustAddress: async () => {
      const state = getState();
      return { dustAddress: encodeAddress(state.dust.address) };
    },

    getTxHistory: async (params) => {
      getState();
      const pageNumber = (params.pageNumber ?? 0) as number;
      const pageSize = (params.pageSize ?? 20) as number;
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 0) {
        throw createApiError('InvalidRequest', `Invalid pageNumber: ${JSON.stringify(pageNumber)} — must be a whole number, 0 or more`);
      }
      if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
        throw createApiError('InvalidRequest', `Invalid pageSize: ${JSON.stringify(pageSize)} — must be a whole number, 1 or more`);
      }
      const start = pageNumber * pageSize;
      const entries = await facade.getAllFromTxHistory();
      const page: HistoryEntry[] = [];
      // One at a time: a page can be large, and each partial success is an indexer query.
      for (const entry of entries.slice(start, start + pageSize)) {
        if (entry.lifecycle.status !== 'finalized' || entry.status !== 'PARTIAL_SUCCESS') {
          page.push(toHistoryEntry(entry));
          continue;
        }
        try {
          page.push(toHistoryEntry(entry, await fetchPartialSuccessSegments(networkConfig.indexer, entry.hash)));
        } catch (err) {
          throw createApiError('InternalError', extractErrorDetail(err));
        }
      }
      return page;
    },

    getConfiguration: async () => {
      return {
        indexerUri: networkConfig.indexer,
        indexerWsUri: networkConfig.indexerWS,
        proverServerUri: networkConfig.proofServer,
        substrateNodeUri: networkConfig.node,
        networkId: networkConfig.networkId,
      };
    },

    getConnectionStatus: async () => {
      // Return the lowercase abstractions form (e.g. 'undeployed'), matching
      // what addresses are encoded with. dApps that round-trip this back into
      // setNetworkId() and then decode an address would otherwise hit a
      // case-sensitivity mismatch — bech32m HRPs are lowercase, so encoder
      // and getConnectionStatus must agree on the lowercase form.
      return { status: 'connected', networkId };
    },

    // ── Write Methods (7) — require terminal approval ──

    makeTransfer: async (params, context) => {
      const outputs = params.desiredOutputs as any[];
      if (!Array.isArray(outputs) || outputs.length === 0) {
        throw createApiError('InvalidRequest', 'desiredOutputs must be a non-empty array');
      }
      assertWalletsOnLedger9();
      const combinedTransfers = parseDesiredOutputs(outputs);

      const tracker = makeTracker('makeTransfer', context);

      const details = outputs.map((o, i) => ({
        label: `Output ${i + 1}`,
        value: `${o.value} → ${String(o.recipient).slice(0, 20)}... (${o.kind})`,
      }));
      tracker.start('approve');
      await requireApproval('makeTransfer', details, context);

      tracker.start('building');
      const payFees = (params.options as any)?.payFees ?? true;
      const hex = await building(async () => {
        const recipe = await withDustRetry(() => facade.transferTransaction(combinedTransfers, {
          ttl: createTtl(),
          payFees,
        }));
        const { hex, finalized } = await processRecipe(recipe, tracker);
        trackPendingTx(context.connectionId, hex, finalized);
        return hex;
      });
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    },

    submitTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }
      assertWalletsOnLedger9();

      const tracker = makeTracker('submitTransaction', context);

      // This submit takes the transaction over from the connection that built
      // it (this one or another): closing that one no longer reverts it.
      const claimed = claimPendingTx(txHex);
      if (claimed !== undefined) submittingTxs.set(txHex, claimed);
      // Releases the coins of a transaction this submit took over and won't send.
      const release = async (): Promise<void> => {
        if (claimed === undefined) return;
        submittingTxs.delete(txHex);
        try { await facade.revert(claimed.finalized); } catch { /* best-effort */ }
      };

      // Submit is the irreversible action: prompt, unless under --approve-fees
      // it is a transaction this connection had balanced fee-only.
      const feeOnly = approvalOptions.approveFees === true
        && claimed?.owner === context.connectionId && claimed.feeOnly;
      tracker.start('approve');
      try {
        await requireApproval('submitTransaction', inspectTxHex(txHex, 'sealed'), context, feeOnly);
      } catch (err) {
        // Refused: a transaction this connection built is reverted, to release
        // its coins; one another connection built goes back to it unsent.
        if (claimed !== undefined && claimed.owner !== context.connectionId) {
          submittingTxs.delete(txHex);
          trackPendingTx(claimed.owner, txHex, claimed.finalized, claimed.feeOnly);
        } else {
          await release();
        }
        throw err;
      }

      // Adopt for submission (the chain doesn't need object identity)
      const sealedTx = adopt(txHex, 'Finalized');
      // The Dust coins it pays with, by nonce (with any other pending transaction's): refused for Dust spent first, the
      // answer waits until the wallet saw them spent, so the dApp's next balance doesn't pick them again.
      const paidWith = pendingDustNonces(getState());
      tracker.start('submitting');
      try {
        // Bounded: against a node that went away the SDK's submit never returns.
        const txHash = await submitWithin(facade.submitTransaction(sealedTx), { node: networkConfig.node });
        tracker.complete();
        // Submitted: its coins are spent, not pending.
        submittingTxs.delete(txHex);
        releaseDustIfIdle();
        context.metadata.phases = tracker.getTimings();
        // Return txHash for server logging (onResponse can read it from result)
        return { txHash };
      } catch (submitErr: unknown) {
        tracker.complete();
        // Revert pending tx to release locked dust coins
        await release();
        releaseDustIfIdle();
        // Another transaction from this wallet spent the same Dust first, refused as it arrived (196) or dropped from the
        // node's pool as invalid when the other went into a block first: nothing of this one was spent, and balanced
        // again once the wallet has seen that spend, it pays with free Dust.
        const doubleSpent = isDustDoubleSpendRefusal(submitErr);
        if (doubleSpent || isDroppedFromPool(submitErr)) {
          await awaitDustSpendSeen(facade.state().pipe(rx.filter(isCurrent)), paidWith);
          throw doubleSpent ? new DustDoubleSpentError(0, { cause: submitErr }) : new TransactionInvalidatedError(0, { cause: submitErr });
        }
        // The fee refused as too low while the Dust covers it: the next balance
        // is priced with a larger margin, and the dApp balances this one again.
        // Not rebuilt here: the dApp holds this transaction and follows it by
        // its identifiers (the connector's submit returns nothing), and its fee
        // is the one that was approved. Past the largest margin, FeeTooLowError.
        if (isFeeShortRefusal(submitErr)) {
          const step = await repriceAfterFeeRefusal(bundle.feePricing, () => refusedFeeCheck(facade, sealedTx, getState()), submitErr);
          if (step.kind === 'repriced') {
            notice(dim(`  fee refused as too low with ${step.fromBlocks} blocks of margin; fees are now priced with ${step.toBlocks}`));
            throw new FeeRepricedError(step.fromBlocks, step.toBlocks, { cause: submitErr });
          }
        }
        // Re-throw with full detail so the RPC layer can forward it
        const detail = extractErrorDetail(submitErr);
        const enriched = new Error(`Transaction submission failed: ${detail}`);
        enriched.cause = submitErr;
        throw enriched;
      }
    },

    balanceUnsealedTransaction: (params, context) =>
      balanceDAppTransaction('balanceUnsealedTransaction', 'unsealed', params, context),

    balanceSealedTransaction: (params, context) =>
      balanceDAppTransaction('balanceSealedTransaction', 'sealed', params, context),

    makeIntent: async (params, context) => {
      const desiredInputs = params.desiredInputs as any[];
      const desiredOutputs = params.desiredOutputs as any[];
      const intentOptions = params.options as any;

      if (!intentOptions) {
        throw createApiError('InvalidRequest', 'options is required for makeIntent');
      }
      assertWalletsOnLedger9();
      const swapInputs = parseDesiredInputs(desiredInputs ?? []);
      const combinedOutputs = parseDesiredOutputs(desiredOutputs ?? []);

      const tracker = makeTracker('makeIntent', context);

      tracker.start('approve');
      await requireApproval('makeIntent', [], context);

      tracker.start('building');

      const hex = await building(async () => {
        const recipe = await withDustRetry(() => facade.initSwap(swapInputs, combinedOutputs, {
          ttl: createTtl(),
          payFees: intentOptions.payFees ?? true,
        }));
        const { hex, finalized } = await processRecipe(recipe, tracker);
        trackPendingTx(context.connectionId, hex, finalized);
        return hex;
      });
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    },

    signData: async (params, context) => {
      const data = String(params.data ?? '');
      const signOptions = params.options as any;

      if (!data || !signOptions?.encoding) {
        throw createApiError('InvalidRequest', 'data and options.encoding are required');
      }
      if (signOptions.keyType && signOptions.keyType !== 'unshielded') {
        throw createApiError('InvalidRequest', `Unsupported keyType: "${signOptions.keyType}" — only "unshielded" is supported`);
      }

      // Decode before asking the operator: a payload that can't be read is the dApp's mistake.
      let payload: Uint8Array;
      try {
        payload = decodeSignPayload(data, signOptions.encoding);
      } catch (err) {
        throw createApiError('InvalidRequest', (err as Error).message);
      }

      await requireApproval('signData', [
        { label: 'Encoding', value: signOptions.encoding },
        { label: 'Data', value: data.length > 64 ? data.slice(0, 64) + '...' : data },
      ], context);

      // Both come back as { tag, value }: the hex is in `value`, and the
      // tag names the scheme the connector API reports.
      const signature = await keystore.signDataAsync(signedMessageBytes(payload));
      const verifyingKey = keystore.getPublicKey();

      return {
        data,
        signature: signature.value,
        verifyingKey: verifyingKey.value,
        scheme: signatureScheme(signature.tag),
      };
    },

    // ── Proving Provider (1) ──

    getProvingProvider: async () => {
      // For v1, we use the proof server from network config.
      // The DApp's keyMaterialProvider is not used over JSON-RPC — the proof
      // server handles proving directly. WASM proving with DApp-provided key
      // material would require bidirectional RPC (future enhancement).
      return { provingProvider: 'ready', proverServerUri: networkConfig.proofServer };
    },

    // ── Permission (1) ──

    hintUsage: async (params) => {
      const methods = params.methodNames ?? [];
      // Names only: they are printed to the operator's terminal as they come.
      if (!Array.isArray(methods) || !methods.every((m) => typeof m === 'string' && /^[A-Za-z]\w*$/.test(m))) {
        throw createApiError('InvalidRequest', 'methodNames must be an array of connector method names');
      }
      notice(dim(`  DApp hints usage: ${methods.join(', ')}`));
    },

    // ── mn's own (1): not in the DApp connector API ──

    /**
     * The price of a transaction a dApp is about to prove (unproven, hex): the
     * fee this wallet would commit to it when it balances it, with the
     * shielded coins and the Dust spend it adds and the margin it prices with
     * now, against the Dust it has.
     * Nothing is booked, signed or sent, so the operator isn't asked.
     */
    [PRICE_TRANSACTION_METHOD]: async (params) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }
      assertWalletsOnLedger9();
      const unproven = adopt(txHex, 'Unproven');
      const state = getState();
      const price = await priceTransaction(
        () => estimateFeeAsBalanced(facade, unproven, createTtl()),
        state.dust,
        bundle.feePricing.feeBlocksMargin,
      );
      return transactionPriceToWire(price);
    },
  };

  function dispose(): void {
    subscription.unsubscribe();
    // Clear all abandon timers
    for (const [, txMap] of pendingTxsByConnection) {
      for (const [, entry] of txMap) {
        clearTimeout(entry.timer);
      }
    }
    pendingTxsByConnection.clear();
    options.dustLock?.release();
  }

  function hasPendingTxs(): boolean {
    if (submittingTxs.size > 0) return true;
    for (const [, txMap] of pendingTxsByConnection) {
      if (txMap.size > 0) return true;
    }
    return false;
  }

  // Each handler answers with its failure marked by mn's code, its message and causes as they were.
  return { handlers: markingEngineCodes(handlers), revertPendingTxs, handOffPendingTx, takeOffer, cancelOffers, holdsFreeCoin, hasPendingTxs, dispose };
}
