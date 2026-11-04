// The payer mn's own CLI and MCP server pass to the commands that pay: the
// wallet behind mn serve. A contract's scripts reach it as a server; a command
// that pays in this process calls the same DApp connector's handlers directly.
//
// The server is loaded when first needed, so a command that pays nothing
// doesn't load it.

import { DEFAULT_SERVE_PORT, OWN_COMMAND_DUST_WAIT_MS, type ConnectOptions, type Payer, type PayingTarget, type ServedWallet, sdkSetOf, sessionOver, type WalletSession, type CallSdkWarnings } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';
import { assertWalletCanPay } from './wallet-can-pay.ts';

/**
 * An mn serve on `port` for the command's network and wallet: one already
 * running there is reused (its stop does nothing); one on another network
 * refuses, saying what to do.
 */
async function serveWallet(port: number, { network, root, host, endpoints }: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined): Promise<ServedWallet> {
  const { startServeOrReuse } = await import('./serve-manager.ts');
  const handle = await startServeOrReuse({
    root,
    host,
    port,
    network,
    endpoints,
    wallet,
    onMessage: (msg) => progress.update(msg),
    dustWaitMs: OWN_COMMAND_DUST_WAIT_MS,
    sdkWarnings,
    signal,
  });
  progress.stop('mn serve ready (port ' + handle.port + ')');
  return { port: handle.port, stop: () => handle.stop() };
}

/**
 * The command's wallet in this process, as a session: the same DApp connector
 * mn serve runs, its handlers called directly, so no port is taken and no
 * server that is running already is reused. Closing it reverts what it
 * balanced but never submitted.
 */
async function connectWallet({ network, root, host, endpoints }: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined, options: ConnectOptions = {}): Promise<WalletSession> {
  const { openConnector } = await import('./serve-manager.ts');
  const engine = await host.engines.load(sdkSetOf(network, root));
  const open = () => openConnector({ root, host, network, endpoints, wallet, onMessage: (msg) => progress.update(msg), dustWaitMs: OWN_COMMAND_DUST_WAIT_MS, sdkWarnings, forceShielded: options.shielded, signal });
  return sessionOver(network, await open(), (tx, stage) => engine.ledger.readTransaction(tx, stage), { reopen: open, onMessage: (msg) => progress.update(msg) });
}

/** The payer whose served wallet is the mn serve on `port`. */
export function servePayerAt(port: number): Payer {
  return {
    // The wallet mn serve pays from is mn's own: its balance is checked as mn keeps it.
    assertCanPay: assertWalletCanPay,
    serve: (target, wallet, progress, sdkWarnings, signal) => serveWallet(port, target, wallet, progress, sdkWarnings, signal),
    connect: connectWallet,
  };
}

export const servePayer: Payer = servePayerAt(DEFAULT_SERVE_PORT);
