// Serve manager — start mn serve programmatically (in-process), for test runs
// and for the commands mn serve pays for. Replicates the initialization from
// commands/serve.ts but returns a handle instead of blocking on a signal.
// Always runs in approve-all mode.

import { Socket, type AddressInfo } from 'node:net';
import { resolveWalletPath, unlockWallet, walletAddress, type UnlockHost } from '@kuiralabs/midnight-wallet';
import { resolveNetwork, applyEndpointOverrides, endpointFlags, type EndpointOverrides, type NetworkConfig, type NetworkName, sdkSetOf, type DAppConnectorCallbacks, type OpenedConnector, DEFAULT_SERVE_PORT, type CallSdkWarnings, shieldedSyncEnabled, CancelledError, throwIfCancelled, type ContractKeys, contractKeysFromSeed, type RpcHandler, type Host, mayHoldProjectId } from '@kuiralabs/midnight-cli-core';
import { createRpcServer, type RpcServer } from './ws-rpc.ts';

/** A running mn serve, and how to stop it. */
export interface ServeHandle {
  port: number;
  /** The served wallet's keys for a contract's private state. */
  contractKeys: ContractKeys;
  stop(): Promise<void>;
}

export interface ServeManagerOptions {
  /** The state root the wallets, config and caches live under. */
  root: string;
  /** The host: who unlocks the wallet, where the wallet's and the server's notices and waits go, and its connection ids. */
  host: UnlockHost & Pick<Host, 'waiting'>;
  port?: number;
  network?: string;
  /** Explicit endpoints; they win over the network defaults and docker auto-detection. */
  endpoints?: EndpointOverrides;
  wallet?: string;
  onMessage?: (msg: string) => void;
  /** The longest a request waits for the wallet's Dust to grow to a fee (the connector's default when unset). */
  dustWaitMs?: number;
  /** The SDK warnings of the call that serves, listened to while its wallet runs. */
  sdkWarnings: CallSdkWarnings;
  /** Sync the shielded wallet even where the network has no shielded faucet. */
  forceShielded?: boolean;
  /** Cancels the start: what was started is stopped, and the start fails with CancelledError. */
  signal?: AbortSignal;
  /**
   * Browser origins whose pages may connect to a serve this starts (a dApp
   * under test), as a browser sends them (`http://localhost:4173`). None by
   * default: the serve approves every request, so only mn's own scripts, which
   * send no Origin, connect. A running serve is reused only when it lets each
   * of these connect.
   */
  allowedOrigins?: readonly string[];
}

/** The network and endpoints a serve for these options must use. */
export function resolveServeTarget(options: ServeManagerOptions): { networkName: NetworkName; networkConfig: NetworkConfig } {
  const { name: networkName, config: networkConfig } = resolveNetwork({
    args: {
      command: 'serve',
      subcommand: undefined,
      positionals: [],
      flags: { ...(options.network ? { network: options.network } : {}), ...endpointFlags(options.endpoints ?? {}) },
    },
    configDir: options.root,
  }, options.host.settings());
  applyEndpointOverrides(networkConfig, options.endpoints ?? {}, networkName, options.root);
  return { networkName, networkConfig };
}

/**
 * Why a running serve can't be reused for `requested`, or undefined if it can.
 * Same network name isn't enough: two local stacks are both `undeployed`.
 */
export function serveEndpointMismatch(
  running: { substrateNodeUri?: string; indexerWsUri?: string },
  requested: Pick<NetworkConfig, 'node' | 'indexerWS'>,
): string | undefined {
  const same = (a: string | undefined, b: string) => a !== undefined && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  const diffs: string[] = [];
  if (!same(running.substrateNodeUri, requested.node)) diffs.push(`node ${running.substrateNodeUri} (need ${requested.node})`);
  if (!same(running.indexerWsUri, requested.indexerWS)) diffs.push(`indexer ${running.indexerWsUri} (need ${requested.indexerWS})`);
  return diffs.length > 0 ? diffs.join(', ') : undefined;
}

/**
 * Why a running serve can't be reused to pay for `wanted`, or undefined if it
 * can. A serve pays from the wallet it was started with, whatever wallet the
 * command asking was given; one that doesn't say whose it is (it asks its
 * operator before answering reads) can't be shown to pay from `wanted`, so it
 * isn't reused either.
 */
export function serveWalletMismatch(runningAddress: string | null, wanted: { address: string; name: string }): string | undefined {
  if (runningAddress === wanted.address) return undefined;
  if (runningAddress === null) return `it does not say which wallet it pays from (it asks its operator before answering), and this command pays from ${wanted.name} (${wanted.address})`;
  return `it serves the wallet at ${runningAddress}, and this command pays from ${wanted.name} (${wanted.address})`;
}

// ── Port + serve probe helpers ──────────────────────────────────

/**
 * Probe whether a TCP port on loopback is currently accepting connections.
 * 1s timeout — long enough to be reliable, short enough to feel instant.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** What a serve on a port says when connected to for a network. */
export type ServeProbe =
  /** Nothing there answers as mn serve does. */
  | { kind: 'not-serve' }
  /** An mn serve that refused the connection: it serves another network (its words). */
  | { kind: 'refused'; message: string }
  /** An mn serve on that network: its node and indexer, and its wallet's unshielded address when it says. */
  | { kind: 'serve'; networkId: string; endpoints: { substrateNodeUri?: string; indexerWsUri?: string } | null; unshieldedAddress: string | null };

/**
 * Connects to the serve on `port` for `networkId`, as a dApp does, and asks
 * it its network, endpoints and wallet. Any answer that isn't JSON-RPC, and
 * any wait over 2 s for one, is `not-serve`. With `askEndpoints` false its
 * endpoints aren't asked for (`endpoints` is null): on a network whose
 * endpoints carry a Blockfrost project id, the serve asks its operator before
 * it gives them.
 */
export async function probeServe(port: number, networkId: string, askEndpoints = true): Promise<ServeProbe> {
  const WebSocket = (await import('ws')).default;
  return new Promise<ServeProbe>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const finish = (probe: ServeProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Destroyed, not closed: a process that answered with something else may keep its side open.
      try { ws.terminate(); } catch { /* already closed */ }
      resolve(probe);
    };
    const timeout = setTimeout(() => finish({ kind: 'not-serve' }), 2000);
    const answers = new Map<number, { result?: unknown; error?: { message?: unknown } }>();
    const ask = (id: number, method: string, params: Record<string, unknown> = {}): void => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    };
    ws.on('open', () => ask(1, 'connect', { networkId }));
    ws.on('message', (data: Buffer) => {
      let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try { msg = JSON.parse(data.toString()); } catch { finish({ kind: 'not-serve' }); return; }
      if (typeof msg?.id !== 'number') return;
      answers.set(msg.id, msg);
      if (msg.id === 1) {
        if (msg.error !== undefined) {
          finish(typeof msg.error?.message === 'string' ? { kind: 'refused', message: msg.error.message } : { kind: 'not-serve' });
          return;
        }
        ask(2, 'getConnectionStatus');
        if (askEndpoints) ask(3, 'getConfiguration');
        ask(4, 'getUnshieldedAddress');
        return;
      }
      if (![2, ...(askEndpoints ? [3] : []), 4].every((id) => answers.has(id))) return;
      const status = answers.get(2)?.result as { networkId?: unknown } | undefined;
      if (typeof status?.networkId !== 'string') { finish({ kind: 'not-serve' }); return; }
      const configuration = answers.get(3)?.result;
      const address = (answers.get(4)?.result as { unshieldedAddress?: unknown } | undefined)?.unshieldedAddress;
      finish({
        kind: 'serve',
        networkId: status.networkId,
        endpoints: configuration && typeof configuration === 'object' ? configuration as { substrateNodeUri?: string; indexerWsUri?: string } : null,
        unshieldedAddress: typeof address === 'string' ? address : null,
      });
    });
    ws.on('error', () => finish({ kind: 'not-serve' }));
  });
}

/**
 * Whether the server on `port` accepts a WebSocket connection from a page at
 * `origin`, as a browser opens one (with that Origin header). False when it
 * refuses it, or doesn't answer within 2 s.
 */
export async function serveAcceptsOrigin(port: number, origin: string): Promise<boolean> {
  const WebSocket = (await import('ws')).default;
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.terminate(); } catch { /* already closed */ }
      resolve(accepted);
    };
    const timeout = setTimeout(() => finish(false), 2000);
    ws.on('open', () => finish(true));
    ws.on('unexpected-response', () => finish(false));
    ws.on('error', () => finish(false));
  });
}

/** The network a serve on `port` serves (connected to for `networkId`), or null when nothing there is an mn serve for it. */
export async function probeServeNetwork(port: number, networkId: string = 'undeployed'): Promise<string | null> {
  const probe = await probeServe(port, networkId);
  return probe.kind === 'serve' ? probe.networkId : null;
}

/**
 * Why the serve on `port` can't pay for these options, or undefined when it
 * can be reused: it must be an mn serve on the requested network and chain
 * (two local stacks are both `undeployed`, so its node and indexer must match
 * too), paying from the command's wallet (a serve that doesn't say whose it
 * is can't be shown to), and accepting connections from each of the options'
 * allowed origins.
 */
export async function serveReuseRefusal(port: number, options: ServeManagerOptions): Promise<string | undefined> {
  const requestedNetwork = (options.network ?? 'undeployed').toLowerCase();
  const target = resolveServeTarget(options).networkConfig;
  // Endpoints that carry a Blockfrost project id are a hosted network's, one
  // chain per network name: nothing to tell apart, and asking for them would
  // prompt the serve's operator.
  const compareEndpoints = !mayHoldProjectId(target.node) && !mayHoldProjectId(target.indexerWS);
  const probe = await probeServe(port, requestedNetwork, compareEndpoints);
  if (probe.kind === 'not-serve') return `Port ${port} is in use by a process that does not look like mn serve.`;
  if (probe.kind === 'refused') return `The mn serve on port ${port} can't serve ${requestedNetwork}: ${probe.message}.`;
  const actualNetwork = probe.networkId.toLowerCase();
  if (actualNetwork !== requestedNetwork) {
    return `The mn serve on port ${port} is for network ${actualNetwork}, and this run needs ${requestedNetwork}.`;
  }
  const mismatch = !compareEndpoints ? undefined
    : probe.endpoints ? serveEndpointMismatch(probe.endpoints, target) : 'its endpoints could not be read';
  if (mismatch) return `The mn serve on port ${port} is on a different ${actualNetwork} chain: ${mismatch}.`;
  const wanted = await walletAddress(resolveWalletPath(options.root, options.wallet), actualNetwork as NetworkName, options.root, options.host);
  const walletMismatch = serveWalletMismatch(probe.unshieldedAddress, { address: wanted, name: options.wallet ?? 'the active wallet' });
  if (walletMismatch) return `The mn serve on port ${port} can't pay for this command: ${walletMismatch}.`;
  for (const origin of options.allowedOrigins ?? []) {
    if (!(await serveAcceptsOrigin(port, origin))) {
      return `The mn serve on port ${port} refuses connections from ${origin}, where the dApp's page is served: restart it with --allow-origin ${origin}.`;
    }
  }
  return undefined;
}

/** The private-state keys of the options' wallet, derived from its seed (it is unlocked for them). */
export async function serveWalletContractKeys(options: Pick<ServeManagerOptions, 'root' | 'host' | 'wallet'>): Promise<ContractKeys> {
  const { seed } = await unlockWallet(resolveWalletPath(options.root, options.wallet), { root: options.root, host: options.host });
  return contractKeysFromSeed(Buffer.from(seed, 'hex'));
}

/** The serve on `port`, reused: its stop does nothing, since it isn't ours. */
export async function reusedServe(port: number, options: ServeManagerOptions): Promise<ServeHandle> {
  const contractKeys = await serveWalletContractKeys(options);
  (options.onMessage ?? (() => {}))(`Reusing existing mn serve on port ${port}`);
  return { port, contractKeys, async stop() { /* not ours to stop */ } };
}

/**
 * A serve for the options' network, chain and wallet: the one already on
 * `port` (the default port when unset) when it can pay for them, else a new
 * one in this process on a free port the system picks, so commands run at
 * once never race for a port and never touch a process they didn't start.
 */
export async function reuseServeOrStartAnother(options: ServeManagerOptions): Promise<ServeHandle> {
  const port = options.port ?? DEFAULT_SERVE_PORT;
  throwIfCancelled(options.signal);
  if (await isPortInUse(port)) {
    const refusal = await serveReuseRefusal(port, options);
    if (refusal === undefined) return reusedServe(port, options);
    (options.onMessage ?? (() => {}))(`Not reusing port ${port}: ${refusal}`);
  }
  return startServe({ ...options, port: 0 });
}

/** A wallet's DApp connector in this process, approving everything, and how to stop it. */
/** The connector over a synced wallet; stop() stops both. */
export type { OpenedConnector } from '@kuiralabs/midnight-cli-core';

/**
 * The wallet's DApp connector in this process, in --approve-all mode, with no
 * server in front of it: the wallet synced, its Dust ready. mn serve puts a
 * server in front of it; a command of mn's own calls its handlers directly.
 */
export async function openConnector(options: ServeManagerOptions): Promise<OpenedConnector & { contractKeys: ContractKeys }> {
  const onMessage = options.onMessage ?? (() => {});
  const { signal } = options;

  throwIfCancelled(signal);
  // Load wallet
  const config = await unlockWallet(resolveWalletPath(options.root, options.wallet), { root: options.root, host: options.host });
  const seedBuffer = Buffer.from(config.seed, 'hex');
  const contractKeys = contractKeysFromSeed(seedBuffer);

  const { networkName, networkConfig } = resolveServeTarget(options);
  const address = config.addresses[networkName];

  // The SDK's transient warnings, as progress, until the connector is stopped
  const stopListening = options.sdkWarnings.listen((_tag, msg) => {
    onMessage(`SDK: ${msg}`);
  });
  // A failure before the connector is handed back stops what was started, so
  // the listener doesn't outlive this call and the wallet doesn't keep syncing.
  let opened: OpenedConnector;
  try {
    opened = await (await options.host.engines.load(sdkSetOf(networkName, options.root))).wallet.openConnector({
      seed: seedBuffer,
      root: options.root,
      notice: options.host.notice,
      // A wait for Dust is said in every mode (--json too), as the host shows waits.
      waiting: options.host.waiting,
      network: networkName,
      networkConfig,
      address,
      // As `mn serve` does: don't wait for the slow shielded sync where it is off by default, unless forced (it still syncs in the background).
      syncMode: shieldedSyncEnabled(networkName, options.forceShielded) ? 'full' : 'lite',
      dustWaitMs: options.dustWaitMs,
      signal,
      onMessage,
    });
  } catch (err) {
    stopListening();
    throw err;
  }
  return {
    connector: opened.connector,
    contractKeys,
    async stop() {
      stopListening();
      await opened.stop();
    },
  };
}

/**
 * Start mn serve in-process with --approve-all mode, on `port` (0: a free
 * port the system picks). The port is bound before the wallet syncs, so a
 * port taken meanwhile fails at once, not after the sync; until the wallet is
 * ready, every request is refused as not ready.
 * Returns a handle with stop() for teardown.
 */
export async function startServe(options: ServeManagerOptions): Promise<ServeHandle> {
  const requestedPort = options.port ?? DEFAULT_SERVE_PORT;
  const onMessage = options.onMessage ?? (() => {});

  // Filled with the connector's handlers once the wallet is ready.
  const handlers: Record<string, RpcHandler> = {};
  const server = createRpcServer({
    host: options.host,
    port: requestedPort,
    handlers,
    // It approves every request: no web page may connect but the ones the caller allowed.
    allowedOrigins: options.allowedOrigins,
    onOriginRefused: (origin) => onMessage(`refused a connection from ${origin}: that origin is not allowed`),
    onConnect: (conn) => {
      onMessage(`connected ${conn.id}`);
    },
    onDisconnect: (conn) => {
      onMessage(`disconnected ${conn.id}`);
      opened?.connector.revertPendingTxs(conn.id).catch(() => {});
    },
    onRequest: (conn, req) => {
      onMessage(`${conn.id} → ${req.method}`);
    },
    onResponse: (conn, req, durationMs, _result, error) => {
      if (error) {
        onMessage(`${conn.id} ← ${req.method} FAILED: ${error.message}`);
      } else {
        onMessage(`${conn.id} ← ${req.method} (${Math.round(durationMs)}ms)`);
      }
    },
  });

  try {
    await server.ready;
  } catch (err) {
    // A server that never listened never reports closing: close it without waiting.
    server.close().catch(() => {});
    throw new Error(`Could not start mn serve on port ${requestedPort}: ${(err as Error).message}`, { cause: err });
  }
  const port = (server.wss.address() as AddressInfo).port;

  let opened: (OpenedConnector & { contractKeys: ContractKeys }) | undefined;
  try {
    opened = await openConnector(options);
  } catch (err) {
    await server.close().catch(() => {});
    throw err;
  }
  if (options.signal?.aborted === true) {
    await server.close().catch(() => {});
    await opened.stop();
    throw new CancelledError();
  }
  Object.assign(handlers, opened.connector.handlers);

  onMessage(`Server ready on ws://localhost:${port}`);

  const ready = opened;
  return {
    port,
    contractKeys: ready.contractKeys,
    async stop() {
      await server.close().catch(() => {});
      await ready.stop();
    },
  };
}
