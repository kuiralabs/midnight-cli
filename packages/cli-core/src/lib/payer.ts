// How a command that submits a transaction is paid for. The command never
// chooses how a wallet is opened: its caller passes a payer in (the CLI and
// the MCP server pass mn serve's), so a program that imports the command can
// pay with a wallet of its own.

import type { ParsedArgs } from './argv.ts';
import type { EndpointOverrides, NetworkConfig, NetworkName } from './network.ts';
import { networkChoiceFromArgs, networkTargetUnder } from './network-target.ts';
import type { Spinner } from '../ui/spinner.ts';
import type { CallSdkWarnings } from './sdk-warnings.ts';
import type { WalletSession } from './wallet-session.ts';
import type { Host } from './host.ts';
import type { ContractKeys } from './contract-keys.ts';

/** The network a command acts on, with its endpoints resolved, and the host it runs in. */
export interface PayingTarget {
  network: NetworkName;
  /** The state root the command's config, wallets and caches live under. */
  root: string;
  /** The host the command runs in: who unlocks the paying wallet, and where its notices go. */
  host: Host;
  networkConfig: NetworkConfig;
  /** The endpoints given as flags, which a server started for the command must use too. */
  endpoints: EndpointOverrides;
}

/**
 * The target a command's --network and endpoint flags choose
 * (network-target.ts), from the config under the state root `root`; the
 * command runs in `host`.
 */
export function resolvePayingTarget(args: ParsedArgs, command: string, subcommand: string, root: string, host: Host): PayingTarget {
  return networkTargetUnder(root, host, networkChoiceFromArgs(args));
}

/** A wallet served over the DApp connector's WebSocket, for a script in another process to pay through. */
export interface ServedWallet {
  port: number;
  /** The served wallet's keys for a contract's private state (derived from its seed): a script keeps that wallet's private state with them. */
  contractKeys: ContractKeys;
  /** Stops what was started for the command; a server that was running already is left running. */
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
   * its own wallet. `paying` names what the payment is for ("deploying
   * escrow", "calling withdraw on escrow"), for the refusal to say.
   */
  assertCanPay: (target: PayingTarget, wallet: string | undefined, progress: Spinner, signal: AbortSignal | undefined, paying?: string) => Promise<PayingFunds>;
  /** Serves the wallet; one that runs in this process keeps the SDK's warnings to the paying call's `sdkWarnings`. */
  serve: (target: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined) => Promise<ServedWallet>;
  /** Opens the wallet in this process as a session, keeping the SDK's warnings to the paying call's `sdkWarnings`. */
  connect: (target: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined, options?: ConnectOptions) => Promise<WalletSession>;
}

/** What a session opened by a payer needs beyond paying. */
export interface ConnectOptions {
  /** Sync the shielded wallet even where the network has no shielded faucet: the call spends shielded coins. */
  shielded?: boolean;
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
