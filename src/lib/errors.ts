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
 * instead of red "Error".
 */
export class UsageError extends Error {
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

/** What a cancelled operation fails with; exit-codes' classifyError reads it as CANCELLED. */
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

  constructor(reason: string, options?: { cause?: unknown }) {
    super(`The node refused the transaction: ${reason}`, options);
    this.name = 'TransactionRefusedError';
    this.reason = reason;
    Object.setPrototypeOf(this, TransactionRefusedError.prototype);
  }
}

/**
 * A command that ended with a non-zero exit code without throwing (a test run
 * whose tests failed): the code, and the JSON result it wrote. A runner with no
 * process exit code to set, such as the MCP server, reports it as a failure.
 */
export class CommandFailedError extends Error {
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
