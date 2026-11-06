// Error class hierarchy for the CLI.
//
// Discriminates between "real errors" (red, alarming) and "usage hints"
// (yellow, informational). The catch block in wallet.ts inspects the
// instance type and routes to the appropriate formatter.
//
// Throw `UsageError` for: missing/unknown subcommands, missing required
// flags, invalid argument shapes that the user should fix and retry.
// Throw plain `Error` (or any subclass) for: real failures (network,
// insufficient balance, file not found, SDK errors, etc.).

/**
 * Thrown when the user invoked the CLI with missing or invalid arguments
 * that they should fix and retry. Renders in yellow with a "Usage" header
 * instead of red "Error". Its code is INVALID_ARGS; a subclass names its own
 * (NoPassphraseError: PASSPHRASE_REQUIRED).
 */
export class UsageError extends Error {
  readonly code: string = 'INVALID_ARGS';

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
    // Maintain prototype chain for instanceof to work across module boundaries.
    Object.setPrototypeOf(this, UsageError.prototype);
  }
}

/** True iff `err` was thrown to signal a user-fixable usage problem. */
export function isUsageError(err: unknown): err is UsageError {
  return err instanceof UsageError;
}

/** The message a cancelled operation fails with (a CancelledError's, unless it says more). */
export const CANCELLED_MESSAGE = 'Operation cancelled';

/** A cancelled call: the cancellation error, typed with its code. */
export class CancelledError extends Error {
  readonly code = 'CANCELLED';

  constructor(message: string = CANCELLED_MESSAGE) {
    super(message);
    this.name = 'CancelledError';
    Object.setPrototypeOf(this, CancelledError.prototype);
  }
}

/**
 * The node refused a transaction, with what it said. The wallet SDK reports a
 * refusal as "Transaction submission error" and keeps the node's words (the
 * reason: an invalid Dust proof, a stale coin, …) only among its causes.
 */
export class TransactionRefusedError extends Error {
  readonly reason: string;
  /** What the node's reason makes it: a stale coin (STALE_UTXO), an invalid Dust proof (INVALID_DUST_PROOF), or any other refusal (TX_REJECTED). */
  readonly code: RefusalCode;

  constructor(reason: string, options?: { cause?: unknown; code?: RefusalCode }) {
    super(`The node refused the transaction: ${reason}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransactionRefusedError';
    this.reason = reason;
    this.code = options?.code ?? 'TX_REJECTED';
    Object.setPrototypeOf(this, TransactionRefusedError.prototype);
  }
}

/** The codes a node's refusal is reported with. */
export type RefusalCode = 'TX_REJECTED' | 'STALE_UTXO' | 'INVALID_DUST_PROOF';

/**
 * The error as it is reported: the node's refusal when one is among its
 * causes (a command that wrapped a failed submission reports what the node
 * said), any other error as it is.
 */
export function asReported(err: Error): Error {
  const seen = new Set<unknown>();
  for (let current: unknown = err; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof TransactionRefusedError) return current;
    seen.add(current);
  }
  return err;
}

/**
 * A failure of the engine contract, named by its code: what an engine reports
 * an SDK or node failure as, with the SDK's own message and its error as the
 * cause. Its subclasses name the codes mn tells apart.
 */
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = 'EngineError';
    Object.setPrototypeOf(this, EngineError.prototype);
  }
}

/** A ZK proof took longer than mn waits for one. */
export class ProofTimeoutError extends EngineError {
  constructor(message: string = 'ZK proof generation timed out', options?: { cause?: unknown }) {
    super('PROOF_TIMEOUT', message, options);
    this.name = 'ProofTimeoutError';
    Object.setPrototypeOf(this, ProofTimeoutError.prototype);
  }
}

/** The proof server failed to prove a transaction (the SDK's "Failed to prove transaction"). */
export class ProofFailureError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('PROOF_FAILURE', message, options);
    this.name = 'ProofFailureError';
    Object.setPrototypeOf(this, ProofFailureError.prototype);
  }
}

/** A transaction spent coins another transaction already spent (the node's error 115). */
export class StaleUtxoError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('STALE_UTXO', message, options);
    this.name = 'StaleUtxoError';
    Object.setPrototypeOf(this, StaleUtxoError.prototype);
  }
}

/** The chain refused a Dust spend proof as malformed (the node's error 170, InvalidDustSpendProof). */
export class InvalidDustProofError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INVALID_DUST_PROOF', message, options);
    this.name = 'InvalidDustProofError';
    Object.setPrototypeOf(this, InvalidDustProofError.prototype);
  }
}

/** The wallet's saved state doesn't fit the chain (a reset chain, a re-indexed indexer): the SDK refused to resume from it. */
export class StaleWalletStateError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('STALE_CACHE', message, options);
    this.name = 'StaleWalletStateError';
    Object.setPrototypeOf(this, StaleWalletStateError.prototype);
  }
}

/** Not enough Dust to pay a transaction's fee: raised by mn's checks and by the engines, so its code is the engine contract's. */
export class DustRequiredError extends Error {
  readonly code = 'DUST_REQUIRED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DustRequiredError';
    Object.setPrototypeOf(this, DustRequiredError.prototype);
  }
}

/** Not enough NIGHT for the amount asked for: raised by the engines with the message the command gives them. */
export class InsufficientBalanceError extends Error {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InsufficientBalanceError';
    Object.setPrototypeOf(this, InsufficientBalanceError.prototype);
  }
}

/** A wait for the chain, the indexer or the proof server passed its deadline. */
export class SyncTimeoutError extends Error {
  readonly code = 'SYNC_TIMEOUT';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SyncTimeoutError';
    Object.setPrototypeOf(this, SyncTimeoutError.prototype);
  }
}

/** A connection to the node, the indexer or the proof server failed; `cause` is the transport's own error. */
export class NetworkError extends Error {
  readonly code = 'NETWORK_ERROR';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * A command that ended with a non-zero exit code without throwing (a test run
 * whose tests failed): the code, and the JSON result it wrote. A runner with no
 * process exit code to set, such as the MCP server, reports it as a failure,
 * with the code COMMAND_FAILED.
 */
export class CommandFailedError extends Error {
  readonly code = 'COMMAND_FAILED';
  readonly exitCode: number;
  readonly result: Readonly<Record<string, unknown>>;

  constructor(command: string, exitCode: number, result: Readonly<Record<string, unknown>>) {
    super(`${command} ended with exit code ${exitCode}: ${JSON.stringify(result)}`);
    this.exitCode = exitCode;
    this.result = result;
    this.name = 'CommandFailedError';
    Object.setPrototypeOf(this, CommandFailedError.prototype);
  }
}

/** Throws CancelledError when the call's signal has aborted, so the call stops before its next step. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CancelledError();
}
