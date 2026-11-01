// How a command that submits a transaction is paid for. The command never
// chooses how a wallet is opened: its caller passes a payer in (the CLI and
// the MCP server pass mn serve's), so a program that imports the command can
// pay with a wallet of its own.

import { type ParsedArgs, getFlag } from './argv.ts';
import { applyEndpointOverrides, endpointFlags, type EndpointOverrides, type NetworkConfig } from './network.ts';
import { resolveNetwork } from './resolve-network.ts';
import type { Spinner } from '../ui/spinner.ts';
import type { CallSdkWarnings } from './sdk-warnings.ts';

/** The network a command acts on, with its endpoints resolved. */
export interface PayingTarget {
  network: string;
  networkConfig: NetworkConfig;
  /** The endpoints given as flags, which a server started for the command must use too. */
  endpoints: EndpointOverrides;
}

/**
 * --network, else the network set with `midnight config set network`, else
 * undeployed (as every other command), then explicit endpoint flags over the
 * defaults. Without endpoint flags, `undeployed` resolves to whatever local
 * stack docker shows, which is ambiguous when more than one runs.
 */
export function resolvePayingTarget(args: ParsedArgs, command: string, subcommand: string): PayingTarget {
  const network = getFlag(args, 'network');
  const endpoints: EndpointOverrides = {
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
    proofServer: getFlag(args, 'proof-server'),
  };
  const { name, config: networkConfig } = resolveNetwork({
    args: { command, subcommand, positionals: [], flags: { ...(network ? { network } : {}), ...endpointFlags(endpoints) } },
  });
  applyEndpointOverrides(networkConfig, endpoints, name);
  return { network: name, networkConfig, endpoints };
}

/** A wallet served over the DApp connector's WebSocket, for a script in another process to pay through. */
export interface ServedWallet {
  port: number;
  /** Stops what was started for the command; a server that was running already is left running. */
  stop: () => Promise<void>;
}

/** The DApp connector methods a command calls on the wallet that pays. */
export type PayingMethod = 'getShieldedAddresses' | 'getShieldedBalances' | 'balanceUnsealedTransaction' | 'submitTransaction';

/** A wallet's DApp connector in this process, called by method name. */
export interface WalletConnection {
  call: (method: PayingMethod, params: Record<string, unknown>) => Promise<unknown>;
  /** Reverts what was balanced but never submitted, then stops the wallet. */
  stop: () => Promise<void>;
}

/**
 * Opens the wallet that pays, for the target network. `wallet` is the --wallet
 * flag; without it the active wallet pays. Progress goes to `progress`.
 */
/** What the paying wallet holds, once it is known to be able to pay. */
export interface PayingFunds {
  nightBalance: bigint;
  dustBalance: bigint;
}

/**
 * How a command pays. Each method takes the paying call's cancellation
 * signal: once it aborts, the method stops what it started and fails with
 * CancelledError.
 */
export interface Payer {
  /**
   * Refuses, before anything is served, unless the wallet this payer pays from
   * has NIGHT and Dust to pay with; what it holds otherwise. Each payer checks
   * its own wallet.
   */
  assertCanPay: (target: PayingTarget, wallet: string | undefined, progress: Spinner, signal: AbortSignal | undefined) => Promise<PayingFunds>;
  /** Serves the wallet; one that runs in this process keeps the SDK's warnings to the paying call's `sdkWarnings`. */
  serve: (target: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined) => Promise<ServedWallet>;
  /** Opens the wallet in this process, keeping the SDK's warnings to the paying call's `sdkWarnings`. */
  connect: (target: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined) => Promise<WalletConnection>;
}

/** What a command's caller gives it for one call. */
export interface CommandContext {
  payer?: Payer;
}

/** A command that pays was called without a payer. */
export class NoPayerError extends Error {
  readonly code = 'NO_PAYER';

  constructor(command: string) {
    super(`${command} submits a transaction, but its caller gave it no payer to pay with.`);
    this.name = 'NoPayerError';
    Object.setPrototypeOf(this, NoPayerError.prototype);
  }
}

/** The payer the caller gave `command`; throws NoPayerError when there is none. */
export function payerFor(command: string, context: CommandContext | undefined): Payer {
  if (context?.payer === undefined) throw new NoPayerError(command);
  return context.payer;
}
