// The engine contract's reading of the SDK's and the node's errors: the one
// place mn recognises their shapes and words (a connection that could not be
// made it reads through transport-failure.ts, which a contract script's
// process shares). An engine reports each failure
// it can name as a typed error carrying its code (toEngineError), and its DApp
// connector marks the errors it answers with by their code, keeping their
// messages (withEngineCode). Only the engines, and in core the wallet session and the Dust wait, import
// this module (scripts/check-layering.mjs holds it). Pure functions, no I/O.

import {
  DustRequiredError,
  EngineError,
  FeeRepricedError,
  FeeTooLowError,
  InsufficientBalanceError,
  InvalidDustProofError,
  NetworkError,
  ProofFailureError,
  ProofTimeoutError,
  StaleUtxoError,
  StaleWalletStateError,
  SyncTimeoutError,
  TransactionRefusedError,
  type RefusalCode,
} from './errors.ts';
import { OfferCoinsInUseError } from './open-offers.ts';
import { carriesOwnCode, isTransportFailure } from './transport-failure.ts';

/**
 * The chain rejected the transaction outright. Most commonly: balance check
 * failed because the dust capacity wasn't sufficient at submission time
 * (BalanceCheckOverspend) — the estimated dust capacity hasn't grown
 * large enough to cover the tx fee yet.
 *
 * The SDK throws a generic "Transaction submission error" without the
 * actual error code (138). The code is only printed to console by
 * polkadot-js. So we match on the submission error message pattern
 * plus any "138" in the cause chain as a fallback.
 */
export function isTransactionRejectedError(err: any): boolean {
  let current = err;
  while (current) {
    const msg = String(current?.message ?? '').toLowerCase();
    if (msg.includes('submission error')) return true;
    if (msg.includes('transaction') && msg.includes('invalid')) return true;
    if (msg.includes('138')) return true;
    const tag = current?._tag;
    if (tag === 'TransactionInvalidError' || tag === 'SubmissionError') return true;
    current = current.cause;
  }
  return false;
}

/** Where an Effect `FiberFailure` (what an SDK promise rejects with) keeps the failure it ran into. */
const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');

/**
 * The wallet ran out of dust to pay a fee, which waiting for dust can fix.
 * wallet-sdk 2.0 raises a tagged `Wallet.InsufficientFunds` with
 * `tokenType: 'dust'`. Its promises reject with an Effect `FiberFailure` that
 * carries the tagged error only inside its cause, possibly also wrapped as a
 * `cause` by the facade. A shortage of any other token is not this. The
 * ledger-8 SDK said "No dust tokens" or "dust ... unavailable".
 */
export function isDustShortage(err: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as Record<PropertyKey, unknown>;
    if (e._tag === 'Wallet.InsufficientFunds' && e.tokenType === 'dust') return true;
    if (typeof e.message === 'string' && /no dust tokens|dust.*unavailable/i.test(e.message)) return true;
    // Error causes, an Effect Cause's failure or defect, and the halves of a combined Cause.
    pending.push(e.cause, e[FIBER_FAILURE_CAUSE], e.error, e.defect, e.left, e.right);
  }
  return false;
}

/**
 * mn's coin picker refused inside the SDK's balancing: the only coins left
 * that could pay are held by open swap offers. The SDK wraps what its picker
 * throws (an `OtherWalletError` with it as the cause, inside a FiberFailure),
 * so the refusal is found among the causes; undefined when there is none.
 */
export function heldCoinRefusalOf(err: unknown): OfferCoinsInUseError | undefined {
  const seen = new Set<unknown>();
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof OfferCoinsInUseError) return current;
    const e = current as Record<PropertyKey, unknown>;
    pending.push(e.cause, e[FIBER_FAILURE_CAUSE], e.error, e.defect, e.left, e.right);
  }
  return undefined;
}

/** What a Dust shortage carries when the wallet worked out what the fee would take. */
export interface DustShortfall {
  /** Dust (Specks) the wallet has to hold before the fee can be paid. */
  needed: bigint;
  /** Dust its coins held when that was worked out, at the time the wallet spends by. */
  available: bigint;
}

const DUST_SHORTFALL = 'dustShortfall';

/** Mark a Dust shortage with what the fee takes and what the wallet's coins held. */
export function withDustShortfall<E extends object>(error: E, shortfall: DustShortfall): E {
  return Object.assign(error, { [DUST_SHORTFALL]: shortfall });
}

/** The shortfall a Dust shortage carries, wherever in the error's causes it is; undefined when it carries none. */
export function dustShortfallOf(err: unknown): DustShortfall | undefined {
  const seen = new Set<unknown>();
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as Record<PropertyKey, unknown>;
    const found = e[DUST_SHORTFALL] as Partial<DustShortfall> | undefined;
    if (found && typeof found.needed === 'bigint' && typeof found.available === 'bigint') return found as DustShortfall;
    pending.push(e.cause, e[FIBER_FAILURE_CAUSE], e.error, e.defect, e.left, e.right);
  }
  return undefined;
}

/**
 * Dust-related — the SDK throws various messages when dust capacity is too
 * low to pay fees. All of these are retryable by waiting for dust generation
 * capacity to grow.
 */
export function isDustRelatedError(err: any): boolean {
  const msg = err?.message?.toLowerCase() ?? '';
  return msg.includes('not enough dust') ||
    msg.includes('dust generated') ||
    msg.includes('insufficient generated dust') ||
    msg.includes('insufficient funds') ||
    msg.includes('no dust tokens') ||
    isTransactionRejectedError(err);
}

/**
 * The SDK's `Wallet.InsufficientFunds` error surfaced from
 * `transferTransaction`. Distinct from our own pre-flight "Insufficient
 * balance" (which starts with "Insufficient balance:"). The SDK raises
 * this from `#balanceSegment` when its internal coin index is empty —
 * which on a freshly-started localnet can happen even though the state
 * snapshot the facade just emitted shows UTXOs. Recovery is a full
 * facade restart, not an in-place quick-sync.
 */
export function isSdkInsufficientFundsError(err: any): boolean {
  const msg = err?.message?.toLowerCase() ?? '';
  const tag = err?._tag;
  if (tag === 'Wallet.InsufficientFunds') return true;
  return msg === 'insufficient funds' || msg.startsWith('insufficient funds');
}

/**
 * The SDK's cold-start race: it refused for lack of NIGHT although the wallet
 * has it, because its coin index wasn't built yet; restarting the facade
 * fixes it. A Dust shortage reads alike ("Insufficient Funds: could not
 * balance dust") but is real: only waiting for Dust fixes it, and repeated
 * facade restarts for it crashed the ledger WASM ("unreachable").
 */
export function isColdStartRace(err: unknown): boolean {
  return isSdkInsufficientFundsError(err) && !isDustShortage(err) && heldCoinRefusalOf(err) === undefined;
}

/** The wallet SDK's message on the error it wraps a node's refusal in, at each level. */
const SUBMISSION_WRAPPERS: readonly string[] = ['Transaction submission error', 'Transaction submission failed'];

/**
 * What the node said when it refused a transaction, from the wallet SDK's
 * SubmissionError wherever it is among the error's causes (a FiberFailure's
 * included): the messages under the SDK's own wrappers, outermost first.
 * Undefined for any other error, and for a submission error that carries
 * nothing more than the wrapper.
 */
export function nodeRefusalOf(err: unknown): string | undefined {
  const next = (current: Record<PropertyKey, unknown>): unknown => {
    const failure = current[FIBER_FAILURE_CAUSE] as { _tag?: string; error?: unknown; defect?: unknown } | undefined;
    if (failure?._tag === 'Fail') return failure.error;
    if (failure?._tag === 'Die') return failure.defect;
    return current.cause;
  };
  const seen = new Set<unknown>();
  let current: unknown = err;
  let found = false;
  const said: string[] = [];
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'string') {
      if (found) said.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const e = current as Record<PropertyKey, unknown>;
    if (e._tag === 'SubmissionError') found = true;
    const message = typeof e.message === 'string' ? e.message.trim() : '';
    if (found && message !== '' && !SUBMISSION_WRAPPERS.includes(message) && said.at(-1) !== message) said.push(message);
    current = next(e);
  }
  return found && said.length > 0 ? said.join(': ') : undefined;
}

/** The error as it is reported: a node's refusal as a TransactionRefusedError carrying the node's words; any other error as it is. */
export function withNodeReason(err: Error): Error {
  if (err instanceof TransactionRefusedError) return err;
  const reason = nodeRefusalOf(err);
  return reason === undefined ? err : new TransactionRefusedError(reason, { cause: err, code: refusalCodeOf(reason) });
}

// The node's words for a coin another transaction spent (substrate "Custom error: 115"), and for a malformed Dust spend proof (170).
const STALE_UTXO_WORDS: readonly string[] = ['stale utxo', 'error code 115', 'custom error: 115', 'errorcode: 115'];
const INVALID_DUST_PROOF_WORDS: readonly string[] = ['error 170', 'error: 170', 'errorcode: 170', 'invaliddustspendproof'];
// The SDK refusing to resume a wallet's state on a chain it doesn't fit; "inserted non-linearly": an indexer that numbers its events differently.
const STALE_STATE_WORDS: readonly string[] = ['stale cache', 'chain reset', 'chainid mismatch', 'applied > highest', 'inserted non-linearly'];
const SYNC_TIMEOUT_WORDS: readonly string[] = ['sync timed out', 'timed out waiting for dust'];

const saysAny = (text: string, words: readonly string[]): boolean => words.some((word) => text.includes(word));

/** The code a node's refusal is reported with, from its reason. */
export function refusalCodeOf(reason: string): RefusalCode {
  const said = reason.toLowerCase();
  if (saysAny(said, STALE_UTXO_WORDS)) return 'STALE_UTXO';
  if (saysAny(said, INVALID_DUST_PROOF_WORDS)) return 'INVALID_DUST_PROOF';
  return 'TX_REJECTED';
}

/**
 * The engine contract's code for an SDK or node failure, from its shape and
 * then its words, in the order mn has always told them apart (a proof that
 * timed out before a refusal's number; a Dust shortage before a shortage of
 * anything else); undefined for a failure it doesn't name.
 */
function engineCodeOf(err: unknown): string | undefined {
  const reason = nodeRefusalOf(err);
  if (reason !== undefined) return refusalCodeOf(reason);
  if (!(err instanceof Error)) return undefined;
  const said = err.message.toLowerCase();
  if (said.includes('proof') && said.includes('timeout')) return 'PROOF_TIMEOUT';
  if (saysAny(said, STALE_UTXO_WORDS)) return 'STALE_UTXO';
  if (saysAny(said, INVALID_DUST_PROOF_WORDS)) return 'INVALID_DUST_PROOF';
  if (saysAny(said, STALE_STATE_WORDS)) return 'STALE_CACHE';
  // The proof server's refusal: the SDK's ClientError "Failed to prove transaction".
  if (said.includes('failed to prove')) return 'PROOF_FAILURE';
  if (saysAny(said, SYNC_TIMEOUT_WORDS)) return 'SYNC_TIMEOUT';
  if (isDustShortage(err) || said.includes('no dust') || (said.includes('dust') && (said.includes('required') || said.includes('available') || said.includes('insufficient')))) return 'DUST_REQUIRED';
  if (isSdkInsufficientFundsError(err) || said.includes('insufficient') || said.includes('not enough')) return 'INSUFFICIENT_BALANCE';
  if (said.includes('rejected') || said.includes('transaction failed')) return 'TX_REJECTED';
  // The node, the indexer or the proof server out of reach: last, as a refusal's or a proof's words come first.
  if (isTransportFailure(err)) return 'NETWORK_ERROR';
  return undefined;
}

/** The typed error for an engine code, with the failure's message and the failure as its cause. */
function typedEngineError(code: string, message: string, cause: unknown): Error {
  const options = { cause };
  switch (code) {
    case 'PROOF_TIMEOUT': return new ProofTimeoutError(message, options);
    case 'PROOF_FAILURE': return new ProofFailureError(message, options);
    case 'STALE_UTXO': return new StaleUtxoError(message, options);
    case 'INVALID_DUST_PROOF': return new InvalidDustProofError(message, options);
    case 'STALE_CACHE': return new StaleWalletStateError(message, options);
    case 'SYNC_TIMEOUT': return new SyncTimeoutError(message, options);
    case 'DUST_REQUIRED': return new DustRequiredError(message, options);
    case 'INSUFFICIENT_BALANCE': return new InsufficientBalanceError(message, options);
    case 'NETWORK_ERROR': return new NetworkError(message, options);
    default: return new EngineError(code, message, options);
  }
}

/** Where a DApp connector's error carries mn's code beside its own: an API error's `code` is the connector API's. */
const MN_CODE = 'mnCode';

/** The mn code a connector error was marked with (withEngineCode, or an API error made with one); undefined when it has none. */
export function mnCodeOf(err: unknown): string | undefined {
  const code = err !== null && typeof err === 'object' ? (err as Record<string, unknown>)[MN_CODE] : undefined;
  return typeof code === 'string' ? code : undefined;
}

const isConnectorApiError = (err: unknown): boolean =>
  err !== null && typeof err === 'object' && (err as { type?: unknown }).type === 'DAppConnectorAPIError';

/** Whether the error already carries a code of its own (mn's typed errors do); a connector API error's code is the API's, and a socket's ECONNREFUSED the transport's, not mn's. */
const carriesCode = (err: unknown): boolean => !isConnectorApiError(err) && carriesOwnCode(err);

/**
 * The failure as an engine reports it to mn: a node's refusal as a
 * TransactionRefusedError (in the node's words, coded by its reason); an SDK
 * failure mn names as the typed error for its code, with the SDK's message and
 * the SDK's error as its cause; a connector error marked with mn's code as the
 * typed error for that code. Anything else (an error that carries its own
 * code, a failure mn doesn't name) as it is. A fee the wallet re-priced, or
 * refused past its largest margin, stays that, though the node's refusal is
 * among its causes: what it says to do differs from a refusal's.
 */
export function toEngineError(err: unknown): unknown {
  if (err instanceof TransactionRefusedError || err instanceof FeeRepricedError || err instanceof FeeTooLowError) return err;
  const held = heldCoinRefusalOf(err);
  if (held !== undefined) return held;
  const reason = nodeRefusalOf(err);
  if (reason !== undefined) return new TransactionRefusedError(reason, { cause: err, code: refusalCodeOf(reason) });
  const marked = mnCodeOf(err);
  if (marked !== undefined && err instanceof Error) return typedEngineError(marked, err.message, err);
  if (isConnectorApiError(err) || carriesCode(err)) return err;
  const code = engineCodeOf(err);
  return code === undefined || !(err instanceof Error) ? err : typedEngineError(code, err.message, err);
}

/**
 * The failure as a DApp connector answers with it: the same error, its message
 * and causes as they were (a dApp reads them), marked with mn's code when the
 * engine contract names it, so the code crosses the wire beside the API's own.
 */
export function withEngineCode(err: unknown): unknown {
  if (err === null || typeof err !== 'object' || isConnectorApiError(err) || carriesCode(err) || mnCodeOf(err) !== undefined) return err;
  const code = heldCoinRefusalOf(err)?.code ?? engineCodeOf(err);
  if (code !== undefined) Object.defineProperty(err, MN_CODE, { value: code, enumerable: false, configurable: true, writable: true });
  return err;
}

/**
 * An engine's operations, each reporting its failures as toEngineError does:
 * what the engine hands the rest of mn. Every operation is asynchronous.
 */
export function reportingEngineErrors<T extends object>(operations: T): T {
  const reporting: Record<string, unknown> = {};
  for (const [name, operation] of Object.entries(operations)) {
    reporting[name] = typeof operation !== 'function'
      ? operation
      : async (...args: unknown[]) => {
        try {
          return await (operation as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
          throw toEngineError(err);
        }
      };
  }
  return reporting as T;
}

/** A DApp connector's handlers, each answering with its failures marked by mn's code (withEngineCode). */
export function markingEngineCodes<T extends Record<string, (...args: never[]) => Promise<unknown>>>(handlers: T): T {
  const marking: Record<string, unknown> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    marking[name] = async (...args: never[]) => {
      try {
        return await handler(...args);
      } catch (err) {
        throw withEngineCode(err);
      }
    };
  }
  return marking as T;
}
