// The payer mn's own CLI and MCP server pass to the commands that pay: the
// wallet behind mn serve. A contract's scripts reach it as a server; a command
// that pays in this process calls the same DApp connector's handlers directly.
//
// The server is loaded when first needed, so a command that pays nothing
// doesn't load it.

import { DEFAULT_SERVE_PORT } from './constants.ts';
import { OWN_COMMAND_DUST_WAIT_MS } from './dust-wait.ts';
import type { Payer, PayingMethod, PayingTarget, ServedWallet, WalletConnection } from './payer.ts';
import type { Spinner } from '../ui/spinner.ts';

/** The connection name the command's own calls are made under, for the connector's pending transactions. */
const OWN_CONNECTION = 'mn-own-command';

/**
 * An mn serve on `port` for the command's network and wallet: one already
 * running there is reused (its stop does nothing); one on another network
 * refuses, saying what to do.
 */
async function serveWallet(port: number, { network, endpoints }: PayingTarget, wallet: string | undefined, progress: Spinner): Promise<ServedWallet> {
  const { startServeOrReuse } = await import('./serve-manager.ts');
  const handle = await startServeOrReuse({
    port,
    network,
    endpoints,
    wallet,
    onMessage: (msg) => progress.update(msg),
    dustWaitMs: OWN_COMMAND_DUST_WAIT_MS,
  });
  progress.stop('mn serve ready (port ' + handle.port + ')');
  return { port: handle.port, stop: () => handle.stop() };
}

/**
 * The command's wallet in this process: the same DApp connector mn serve
 * runs, its handlers called directly, so no port is taken and no server that
 * is running already is reused. Stopping it reverts what it balanced but
 * never submitted.
 */
async function connectWallet({ network, endpoints }: PayingTarget, wallet: string | undefined, progress: Spinner): Promise<WalletConnection> {
  const { openConnector } = await import('./serve-manager.ts');
  const opened = await openConnector({ network, endpoints, wallet, onMessage: (msg) => progress.update(msg), dustWaitMs: OWN_COMMAND_DUST_WAIT_MS });
  let requestId = 0;
  const call = (method: PayingMethod, params: Record<string, unknown>): Promise<unknown> => {
    const handler = opened.connector.handlers[method];
    if (handler === undefined) throw new Error(`The wallet's connector has no ${method}`);
    return handler(params, { notify: () => {}, connectionId: OWN_CONNECTION, requestId: ++requestId, metadata: {} });
  };
  const stop = async (): Promise<void> => {
    await opened.connector.revertPendingTxs(OWN_CONNECTION).catch(() => { /* best-effort: the connector is stopping */ });
    await opened.stop();
  };
  return { call, stop };
}

/** The payer whose served wallet is the mn serve on `port`. */
export function servePayerAt(port: number): Payer {
  return { serve: (target, wallet, progress) => serveWallet(port, target, wallet, progress), connect: connectWallet };
}

export const servePayer: Payer = servePayerAt(DEFAULT_SERVE_PORT);
