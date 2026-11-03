import { CANCELLED_MESSAGE, isUsageError } from './errors.ts';
import type { CodeRegistry } from './error-codes.ts';
// Structured exit codes and error classification for CLI
// Used by both JSON mode and non-JSON error reporting

// ── Exit codes ──────────────────────────────────────────
export const EXIT_SUCCESS = 0;
export const EXIT_GENERAL_ERROR = 1;
export const EXIT_INVALID_ARGS = 2;
export const EXIT_WALLET_NOT_FOUND = 3;
export const EXIT_NETWORK_ERROR = 4;
export const EXIT_INSUFFICIENT_BALANCE = 5;
export const EXIT_TX_REJECTED = 6;
export const EXIT_CANCELLED = 7;

// ── Machine-readable error code strings ─────────────────
/**
 * @deprecated Each package defines its own codes (`<package>.codes.ts`, made
 * with defineCodes), and classifyError reads them from the installed
 * packages' registry. Kept, with every code those define, until callers move.
 */
export const ERROR_CODES = {
  INVALID_ARGS: 'INVALID_ARGS',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  TX_REJECTED: 'TX_REJECTED',
  STALE_UTXO: 'STALE_UTXO',
  /** Local wallet cache disagrees with chain state (e.g. localnet reset, remote testnet re-index). Recovery: `mn cache clear --wallet <name>` then retry. */
  STALE_CACHE: 'STALE_CACHE',
  PROOF_TIMEOUT: 'PROOF_TIMEOUT',
  /** Proof server rejected or failed to generate the ZK proof for a write transaction. Often a stale commitment tree or an unreachable proof server. Recovery: ensure proof server is running, then retry; if persistent, `mn cache clear` to force a fresh sync. */
  PROOF_FAILURE: 'PROOF_FAILURE',
  /** Chain rejected the dust spend proof as malformed (substrate "Custom error 170" / `InvalidDustSpendProof`). Almost always a stale commitment tree. Recovery: `mn cache clear --wallet <name>` then retry. */
  INVALID_DUST_PROOF: 'INVALID_DUST_PROOF',
  DUST_REQUIRED: 'DUST_REQUIRED',
  /** A Dust registration can't pay its fee yet: the wallet's NIGHT hasn't generated enough Dust. Recovery: run `mn dust register` again at the time the message gives, or add NIGHT. */
  DUST_GENERATING: 'DUST_GENERATING',
  /** The chain's clock is behind this computer's (a local chain after the machine slept), so Dust estimates don't hold. Recovery: wait for it to catch up, or restart the local chain. */
  CHAIN_CLOCK_BEHIND: 'CHAIN_CLOCK_BEHIND',
  /** Long-running wallet sync exceeded its deadline. On hosted networks this is most common during the first cold sync; retrying usually progresses since the cache resumes from the last applied event. */
  SYNC_TIMEOUT: 'SYNC_TIMEOUT',
  CANCELLED: 'CANCELLED',
  /** The chain is on ledger 8; this build supports ledger 9 only. Recovery: use midnight-wallet-cli 0.5.x for that network. */
  UNSUPPORTED_LEDGER: 'UNSUPPORTED_LEDGER',
  /** `mn localnet up` can't start a ledger-9 stack on this build. Recovery: run one yourself and point mn at it (endpoint flags or `midnight config set`). */
  LOCALNET_UNAVAILABLE: 'LOCALNET_UNAVAILABLE',
  /** No ledger-9 stack answers at the configured endpoints. Recovery: start one, or fix the endpoints. */
  LOCAL_STACK_UNREACHABLE: 'LOCAL_STACK_UNREACHABLE',
  /** Several local Midnight stacks run and no endpoints were given. Recovery: pass endpoint flags or `midnight config set` them. */
  AMBIGUOUS_LOCAL_STACKS: 'AMBIGUOUS_LOCAL_STACKS',
  /** This Node.js is older than mn supports (22). Recovery: install a current Node.js. */
  UNSUPPORTED_NODE: 'UNSUPPORTED_NODE',
  /** `mn grant`: the wallet has no account on this network yet. Recovery: `mn grant deploy`. */
  NO_ACCOUNT: 'NO_ACCOUNT',
  /** The network is served by Blockfrost and no project id is set. Recovery: `mn config set blockfrost-project-id <project id>`. */
  BLOCKFROST_PROJECT_ID_REQUIRED: 'BLOCKFROST_PROJECT_ID_REQUIRED',
  /** Blockfrost refused the project id. Recovery: check it at blockfrost.io and set it again. */
  BLOCKFROST_PROJECT_ID_REJECTED: 'BLOCKFROST_PROJECT_ID_REJECTED',
  /** Blockfrost is holding the project back (its plan's daily limit, or too many requests at once). Recovery: wait, or see the project's plan. */
  BLOCKFROST_LIMIT_REACHED: 'BLOCKFROST_LIMIT_REACHED',
  /** An endpoint set by flag or config was shut down by its operator. Recovery: unset it (`mn config unset indexer-ws`). */
  ENDPOINT_SHUT_DOWN: 'ENDPOINT_SHUT_DOWN',
  /** The process has loaded one SDK set's engine and the call's network runs on the other. Recovery: run the call in a process of its own (for MCP, a server for that network). */
  OTHER_SDK_SET: 'OTHER_SDK_SET',
  /** An engine's SDK packages reach more than one copy of its ledger: mn was installed without its shrinkwrap (bun's installer). Recovery: install mn with npm. */
  MIXED_SDK_LAYOUT: 'MIXED_SDK_LAYOUT',
  /** Bytes given as a swap offer are not one: not a sealed ledger-9 transaction, or not a shielded half swap. Recovery: ask the maker for the offer again. */
  NOT_AN_OFFER: 'NOT_AN_OFFER',
  /** A swap offer's own terms differ from the agreed ones. Recovery: don't take it; agree the terms again with the maker. */
  TERMS_MISMATCH: 'TERMS_MISMATCH',
  /** A swap offer is past the expiry its maker set. Recovery: ask the maker for a new one. */
  OFFER_EXPIRED: 'OFFER_EXPIRED',
  /** A spend would use coins an open swap offer of this wallet's holds, cancelling it. Recovery: cancel the offer first (mn swap cancel), or wait until it is taken. */
  OFFER_COINS_IN_USE: 'OFFER_COINS_IN_USE',
  /** mn's passphrase was wrong, or a sealed secret was changed. Recovery: run it again with the passphrase mn was protected with. */
  WRONG_PASSPHRASE: 'WRONG_PASSPHRASE',
  /** A secret was needed and no passphrase could be had. Recovery: set MN_PASSPHRASE, or run at a terminal. */
  PASSPHRASE_REQUIRED: 'PASSPHRASE_REQUIRED',
  /** The host gave mn no place to keep its state. Recovery: give the host its paths. */
  NO_STATE_ROOT: 'NO_STATE_ROOT',
  /** A command that submits a transaction was called without a payer. Recovery: give the call a payer. */
  NO_PAYER: 'NO_PAYER',
  /** Contract scripts run under Node.js, and none was found on PATH. Recovery: install Node.js 22 or later, or run mn under Node. */
  NO_NODE_RUNTIME: 'NO_NODE_RUNTIME',
  /** A command ended with a non-zero exit code without throwing (a test run whose tests failed), run where no process exit code can be set (MCP). */
  COMMAND_FAILED: 'COMMAND_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

/** Errors the caller fixes (mn's passphrase, an offer that isn't the agreed one), classified by their code before any usage error. */
const CALLER_ERROR_CODES: ReadonlySet<string> = new Set([ERROR_CODES.WRONG_PASSPHRASE, ERROR_CODES.PASSPHRASE_REQUIRED, ERROR_CODES.NOT_AN_OFFER, ERROR_CODES.TERMS_MISMATCH, ERROR_CODES.OFFER_EXPIRED, ERROR_CODES.OFFER_COINS_IN_USE]);

/** Typed setup errors that carry their own `code`; classified by it, not by message text. */
const SETUP_ERROR_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.UNSUPPORTED_LEDGER,
  ERROR_CODES.LOCALNET_UNAVAILABLE,
  ERROR_CODES.LOCAL_STACK_UNREACHABLE,
  ERROR_CODES.AMBIGUOUS_LOCAL_STACKS,
  ERROR_CODES.BLOCKFROST_PROJECT_ID_REQUIRED,
  ERROR_CODES.BLOCKFROST_PROJECT_ID_REJECTED,
  ERROR_CODES.BLOCKFROST_LIMIT_REACHED,
  ERROR_CODES.ENDPOINT_SHUT_DOWN,
]);

/** @deprecated A code is a string a package defines; see ERROR_CODES. */
export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

interface ClassifiedError {
  exitCode: number;
  /** A code one of the installed packages defines (a plugin's included), or one of ERROR_CODES. */
  errorCode: string;
}

/**
 * The error's code and the exit code it ends the CLI with. An error that
 * carries a code `codes` defines is classified by it; any other falls back to
 * the rules below, which read its message.
 */
export function classifyError(err: Error, codes?: CodeRegistry): ClassifiedError {
  return (codes === undefined ? undefined : byCode(err, codes)) ?? legacyByMessage(err);
}

/**
 * The classification by the error's code alone: UNKNOWN for an error that
 * carries no code `codes` defines, whatever its message says. Tests use it to
 * check that a typed error reports its code without the message rules.
 */
export function classifyByCode(err: Error, codes: CodeRegistry): ClassifiedError {
  return byCode(err, codes) ?? { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNKNOWN };
}

/** The definition of the code `err` carries, as an exit code and code; undefined when `codes` defines none. */
function byCode(err: Error, codes: CodeRegistry): ClassifiedError | undefined {
  const code = (err as { code?: unknown }).code;
  const defined = typeof code === 'string' ? codes.code(code) : undefined;
  return defined === undefined ? undefined : { exitCode: defined.exitCode, errorCode: defined.code };
}

/**
 * The classification before codes were owned per package, unchanged: the
 * typed codes it knew, then patterns over the message from the CLI and the
 * Midnight SDK. Order matters: more specific patterns are checked before
 * broader ones.
 */
function legacyByMessage(err: Error): ClassifiedError {
  // A usage error is the caller's to fix, whatever its text (the CLI and MCP agree on this).
  // (Tested through `unknown`: UsageError has Error's shape, so narrowing `err` itself would leave `never`.)
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && CALLER_ERROR_CODES.has(code)) {
    return { exitCode: EXIT_INVALID_ARGS, errorCode: code as ErrorCode };
  }
  if (isUsageError(err as unknown)) {
    return { exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.INVALID_ARGS };
  }
  if (typeof code === 'string' && SETUP_ERROR_CODES.has(code)) {
    return { exitCode: EXIT_NETWORK_ERROR, errorCode: code as ErrorCode };
  }
  if (code === ERROR_CODES.UNSUPPORTED_NODE) {
    return { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNSUPPORTED_NODE };
  }
  if (code === ERROR_CODES.MIXED_SDK_LAYOUT) {
    return { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.MIXED_SDK_LAYOUT };
  }
  if (code === ERROR_CODES.OTHER_SDK_SET) {
    return { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.OTHER_SDK_SET };
  }
  if (code === ERROR_CODES.NO_ACCOUNT) {
    return { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.NO_ACCOUNT };
  }
  if (code === ERROR_CODES.DUST_GENERATING) {
    return { exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.DUST_GENERATING };
  }
  if (code === ERROR_CODES.CANCELLED) {
    return { exitCode: EXIT_CANCELLED, errorCode: ERROR_CODES.CANCELLED };
  }
  if (code === ERROR_CODES.CHAIN_CLOCK_BEHIND) {
    return { exitCode: EXIT_NETWORK_ERROR, errorCode: ERROR_CODES.CHAIN_CLOCK_BEHIND };
  }

  const msg = (err.message ?? '').toLowerCase();

  // Cancelled by user (SIGINT / AbortController)
  if (msg.includes(CANCELLED_MESSAGE.toLowerCase()) || msg.includes('operation aborted') || msg === 'cancelled' || msg === 'aborted') {
    return { exitCode: EXIT_CANCELLED, errorCode: ERROR_CODES.CANCELLED };
  }

  // Wallet file not found
  if (msg.includes('wallet file not found') || (msg.includes('wallet') && msg.includes('not found'))) {
    return { exitCode: EXIT_WALLET_NOT_FOUND, errorCode: ERROR_CODES.WALLET_NOT_FOUND };
  }

  // Invalid arguments / usage errors
  if (
    msg.includes('missing required flag') ||
    msg.includes('missing amount') ||
    msg.includes('missing recipient') ||
    msg.includes('missing config key') ||
    msg.includes('missing or invalid subcommand') ||
    msg.includes('unknown command') ||
    msg.includes('cannot specify both') ||
    msg.includes('invalid bip-39') ||
    msg.includes('seed must be') ||
    msg.includes('key index must be') ||
    msg.includes('shielded balances are private') ||
    msg.includes('shielded is unavailable') ||
    msg.includes('belongs to') && msg.includes('--network is') ||
    msg.includes('usage:')
  ) {
    return { exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.INVALID_ARGS };
  }

  // Proof timeout (before general timeout/dust checks)
  if (msg.includes('proof') && msg.includes('timeout')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.PROOF_TIMEOUT };
  }

  // Stale UTXO — match the specific error code from the Midnight node
  if (msg.includes('stale utxo') || msg.includes('error code 115') || msg.includes('custom error: 115') || msg.includes('errorcode: 115')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.STALE_UTXO };
  }

  // Invalid dust spend proof — substrate "Custom error 170". Distinct from
  // PROOF_FAILURE because the recovery is "clear cache" not "retry".
  if (msg.includes('error 170') || msg.includes('error: 170') || msg.includes('errorcode: 170') || msg.includes('invaliddustspendproof')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.INVALID_DUST_PROOF };
  }

  // Stale local cache (e.g. `applied > highest`, `chainId mismatch`)
  // "inserted non-linearly": state resumed against an indexer that numbers its events differently.
  if (msg.includes('stale cache') || msg.includes('chain reset') || msg.includes('chainid mismatch') || msg.includes('applied > highest') || msg.includes('inserted non-linearly')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.STALE_CACHE };
  }

  // Proof server failure — SDK ClientError "Failed to prove transaction".
  if (msg.includes('failed to prove')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.PROOF_FAILURE };
  }

  // Sync timeouts — wallet sync, dust waits, indexer waits.
  if (
    msg.includes('wallet sync timed out') ||
    msg.includes('sync timed out') ||
    msg.includes('timed out waiting for dust') ||
    msg.includes('did not respond within') ||
    msg.includes('did not produce a block') ||
    msg.includes('did not report funds')
  ) {
    return { exitCode: EXIT_NETWORK_ERROR, errorCode: ERROR_CODES.SYNC_TIMEOUT };
  }

  // Dust required — match specific dust-related failures
  if (msg.includes('no dust') || msg.includes('dust') && (msg.includes('required') || msg.includes('available') || msg.includes('insufficient'))) {
    return { exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.DUST_REQUIRED };
  }

  // Insufficient balance
  if (msg.includes('insufficient') || msg.includes('not enough')) {
    return { exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.INSUFFICIENT_BALANCE };
  }

  // Transaction rejected: by the node (its words in the message, when no rule above knew them), or as the message says.
  if ((err as { name?: unknown }).name === 'TransactionRefusedError' || msg.includes('rejected') || msg.includes('transaction failed')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.TX_REJECTED };
  }

  // Network / connection errors
  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('websocket') ||
    msg.includes('connection refused') ||
    msg.includes('request to ') && msg.includes(' failed, reason:') ||
    (msg.includes('network') && msg.includes('error'))
  ) {
    return { exitCode: EXIT_NETWORK_ERROR, errorCode: ERROR_CODES.NETWORK_ERROR };
  }

  // Fallback
  return { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNKNOWN };
}

/**
 * Rewrite error messages that ship a useless tail when the underlying cause
 * is missing. node-fetch emits "request to <URL> failed, reason:" with an
 * empty body when the cause did not carry a `.message`. Surface the URL plus
 * a one-line cause hint so the message is actionable.
 *
 * Mirrors the WebSocket-side fix in src/lib/balance-subscription.ts.
 */
export function humanizeNetworkError(message: string): string {
  // Match "request to <URL> failed, reason:" optionally followed by whitespace
  // and an empty/whitespace-only tail.
  const m = message.match(/^request to (\S+) failed, reason:\s*$/i);
  if (m) {
    const url = m[1];
    return `request to ${url} failed: unable to reach ${url} (connection refused, DNS, or TLS error). Is the indexer running?`;
  }
  return message;
}
