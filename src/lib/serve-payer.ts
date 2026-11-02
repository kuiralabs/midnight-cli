// The payer mn's own CLI and MCP server pass to the commands that pay: the
// wallet behind mn serve. A contract's scripts reach it as a server; a command
// that pays in this process calls the same DApp connector's handlers directly.
//
// The server is loaded when first needed, so a command that pays nothing
// doesn't load it.

import { DEFAULT_SERVE_PORT } from '@kuiralabs/midnight-cli-core/lib/constants';
import { OWN_COMMAND_DUST_WAIT_MS } from '@kuiralabs/midnight-cli-core/lib/dust-wait';
import type { Payer, PayingTarget, ServedWallet } from '@kuiralabs/midnight-cli-core/lib/payer';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { sessionOver, type WalletSession } from '@kuiralabs/midnight-cli-core/lib/wallet-session';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui/spinner';
import type { CallSdkWarnings } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import { assertWalletCanPay } from './wallet-can-pay.ts';

/**
 * An mn serve on `port` for the command's network and wallet: one already
 * running there is reused (its stop does nothing); one on another network
 * refuses, saying what to do.
 */
async function serveWallet(port: number, { network, endpoints }: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined): Promise<ServedWallet> {
  const { startServeOrReuse } = await import('./serve-manager.ts');
  const handle = await startServeOrReuse({
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
async function connectWallet({ network, endpoints }: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined): Promise<WalletSession> {
  const { openConnector } = await import('./serve-manager.ts');
  const engine = await engineFor(network);
  const open = () => openConnector({ network, endpoints, wallet, onMessage: (msg) => progress.update(msg), dustWaitMs: OWN_COMMAND_DUST_WAIT_MS, sdkWarnings, signal });
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
