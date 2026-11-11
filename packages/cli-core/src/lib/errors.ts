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

import { toDust } from '../ui/format.ts';

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

/**
 * The node refused a fee as too low even after the wallet priced it again with
 * its largest margin. Fee prices climbed faster than the margin covers (blocks
 * full one after another), so a retry a little later is priced at the new prices.
 */
export class FeeTooLowError extends Error {
  readonly code = 'FEE_TOO_LOW';
  /** The fee in Specks, as the wallet priced it with the last margin tried. */
  readonly fee: bigint;
  /** The last margin tried, in blocks. */
  readonly marginBlocks: number;

  constructor(fee: bigint, marginBlocks: number, options?: { cause?: unknown }) {
    super(
      `The node refused the fee as too low (${toDust(fee)} DUST, priced with ${marginBlocks} blocks of margin, the most mn tries). `
      + 'Fee prices are rising faster than that margin covers, which happens when blocks are full one after another: wait a minute and run it again.',
      options,
    );
    this.name = 'FeeTooLowError';
    this.fee = fee;
    this.marginBlocks = marginBlocks;
    Object.setPrototypeOf(this, FeeTooLowError.prototype);
  }
}

/**
 * mn serve submitted a transaction whose fee the node refused as too low, and
 * now prices fees with more margin. The transaction the dApp holds keeps its
 * fee, so it is balanced again and submitted again; mn's contract commands do
 * that themselves.
 */
export class FeeRepricedError extends Error {
  readonly code = 'FEE_REPRICED';
  /** The margin the refused fee was priced with, and the one the wallet prices with now, in blocks. */
  readonly fromBlocks: number;
  readonly toBlocks: number;

  constructor(fromBlocks: number, toBlocks: number, options?: { cause?: unknown }) {
    super(
      `The node refused the fee as too low (priced with ${fromBlocks} blocks of margin). `
      + `The wallet now prices fees with ${toBlocks} blocks: balance the transaction again and submit it.`,
      options,
    );
    this.name = 'FeeRepricedError';
    this.fromBlocks = fromBlocks;
    this.toBlocks = toBlocks;
    Object.setPrototypeOf(this, FeeRepricedError.prototype);
  }
}

/**
 * A contract's state on chain that this mn's ledger can't decode: the bytes
 * the chain holds for the contract are at fault, not the user's setup, and
 * no command can read the contract or call it until they are.
 */
export class ContractStateUnreadableError extends Error {
  readonly code = 'CONTRACT_STATE_UNREADABLE';
  readonly address: string;
  /** What the ledger said as it failed to decode the state. */
  readonly reason: string;

  constructor(address: string, reason: string, options?: { cause?: unknown }) {
    super(
      `Contract ${address}'s state on chain can't be decoded by this mn's ledger (ledger 9): ${reason}. `
      + "That is the state the chain holds for the contract, not something in your setup: neither a read of its state nor a call of it can work until it is fixed on chain.",
      options,
    );
    this.name = 'ContractStateUnreadableError';
    this.address = address;
    this.reason = reason;
    Object.setPrototypeOf(this, ContractStateUnreadableError.prototype);
  }
}

/**
 * The node refused a transaction because another transaction from the same
 * wallet spent the Dust coin it pays with first ("Custom error: 196",
 * DustDoubleSpend): two mn processes paying from one wallet at once picked the
 * same coin. Nothing of the refused one was spent; balanced again, it picks
 * another coin. `rebuilt` is how many times mn built it again already.
 */
export class DustDoubleSpentError extends Error {
  readonly code = 'DUST_DOUBLE_SPENT';
  readonly rebuilt: number;

  constructor(rebuilt: number, options?: { cause?: unknown }) {
    super(
      'Another transaction from this wallet spent the same Dust first, so the node refused this one (error 196, DustDoubleSpend); nothing of it was spent. '
      + (rebuilt === 0
        ? 'Balance it again and submit it: the wallet then pays with Dust that is still free.'
        : `mn built it again ${rebuilt === 1 ? 'once' : `${rebuilt} times`} and another transaction of this wallet's took its Dust each time: run it again once the wallet's other transactions have landed.`),
      options,
    );
    this.name = 'DustDoubleSpentError';
    this.rebuilt = rebuilt;
    Object.setPrototypeOf(this, DustDoubleSpentError.prototype);
  }
}

/**
 * The node took a transaction into its pool, then dropped it as invalid while
 * building a block (the SDK's TransactionInvalidError, "Transaction is invalid
 * and was rejected by the node", with no error code). On Midnight that is a
 * transaction that was valid when it arrived and conflicts with one the block
 * took first: another transaction from the same wallet, in the pool at the
 * same time, spent the same Dust or coin (the node logs "Rejecting
 * transaction ... at pre-dispatch: ... double spend"). Nothing of the dropped
 * one was spent. `rebuilt` is how many times mn built it again already.
 */
export class TransactionInvalidatedError extends Error {
  readonly code = 'TX_INVALIDATED';
  readonly rebuilt: number;

  constructor(rebuilt: number, options?: { cause?: unknown }) {
    super(
      'The node accepted this transaction, then dropped it as invalid when it built the next block: almost always because another transaction from this wallet, '
      + 'sent at the same time from another process or machine with the same seed, spent the same Dust or coin and went in first. Nothing of this one was spent. '
      + (rebuilt === 0
        ? 'Balance it again and submit it once the other transaction has landed.'
        : `mn built it again ${rebuilt === 1 ? 'once' : `${rebuilt} times`} and another transaction of this wallet's took its Dust or coin each time: run it again once the wallet's other transactions have landed, and don't pay from one wallet in parallel.`),
      options,
    );
    this.name = 'TransactionInvalidatedError';
    this.rebuilt = rebuilt;
    Object.setPrototypeOf(this, TransactionInvalidatedError.prototype);
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

/** One of a wallet's three wallets, which the facade builds a transaction with. */
export type WalletPart = 'shielded' | 'unshielded' | 'dust';

const WALLET_PART_NAME: Record<WalletPart, string> = { shielded: 'shielded', unshielded: 'unshielded', dust: 'Dust' };

const RUN_AGAIN =
  'Run the command again: mn first reads the shielded and Dust history past the fork from the indexer, and starts those wallets there.';

/**
 * A wallet can't build or take a transaction because its three wallets
 * (shielded, unshielded, Dust) are not all past the chain's fork to ledger 9:
 * the facade acts at the lowest of their protocol versions, and a ledger-9
 * transaction can't be used below the fork. Its message is one of
 * walletsBehindForkMessage's (mn saw which wallets are behind) or
 * transactionAcrossForkMessage's (the SDK refused a transaction).
 */
export class WalletBehindForkError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('WALLET_BEHIND_FORK', message, options);
    this.name = 'WalletBehindForkError';
    Object.setPrototypeOf(this, WalletBehindForkError.prototype);
  }
}

/** What WalletBehindForkError says when the wallets in `behind`, each at the protocol version it has reached, are below the fork at `forkVersion`. */
export function walletsBehindForkMessage(behind: readonly { wallet: WalletPart; protocolVersion: bigint }[], forkVersion: bigint): string {
  const which = behind.map(({ wallet, protocolVersion }) => `the ${WALLET_PART_NAME[wallet]} wallet is at protocol version ${protocolVersion}`).join(', ');
  return `This wallet can't build a transaction yet: ${which}, below the chain's fork to ledger 9 (${forkVersion}), ` +
    `and a transaction needs all three of its wallets (shielded, unshielded, Dust) past it. ${RUN_AGAIN}`;
}

/**
 * What WalletBehindForkError says when the SDK refused a transaction built at
 * protocol version `authoredFor`, acting at versions `accepted` (from, up to
 * but not including to), on a chain that forks to ledger 9 at `forkVersion`.
 */
export function transactionAcrossForkMessage(authoredFor: bigint, accepted: readonly [bigint, bigint], forkVersion: bigint): string {
  const [, to] = accepted;
  return to <= forkVersion
    ? `A transaction was built on ledger 9 (protocol version ${authoredFor}), and this wallet still acts on ledger 8 (below ${to}): ` +
      `one of its three wallets (shielded, unshielded, Dust) hasn't synced past the chain's fork to ledger 9 (${forkVersion}). ${RUN_AGAIN}`
    : `A transaction was built on ledger 8 (protocol version ${authoredFor}), and this wallet now acts on ledger 9: ` +
      `it crossed the chain's fork (${forkVersion}) while the transaction was being made. Run the command again to build it on ledger 9.`;
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
