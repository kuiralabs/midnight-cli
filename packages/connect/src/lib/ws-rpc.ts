// JSON-RPC 2.0 over WebSocket server
// Transport layer for the DApp Connector — dispatches RPC calls to handler functions

import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { defineHostSlot, type Host, type APIError, type RpcHandler, type RpcHandlerContext, createApiError } from '@kuiralabs/midnight-cli-core';

// The wire types the connector's handlers use, from where every package can reach them.
export { createApiError, type APIError, type ErrorCode, type RpcHandler, type RpcHandlerContext } from '@kuiralabs/midnight-cli-core';

// ── JSON-RPC 2.0 types ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ── JSON-RPC 2.0 notification (server → client, no id) ──

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ── DApp Connector error code → JSON-RPC error code mapping ──

const API_ERROR_TO_RPC_CODE: Record<string, number> = {
  Rejected: -32000,
  PermissionRejected: -32001,
  Disconnected: -32002,
  InvalidRequest: -32602,
  InternalError: -32603,
};

function mapErrorToRpcCode(err: unknown): number {
  if (isApiError(err)) {
    return API_ERROR_TO_RPC_CODE[err.code] ?? -32603;
  }
  return -32603; // Internal error
}

function isApiError(err: unknown): err is APIError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as any).type === 'DAppConnectorAPIError'
  );
}

/**
 * mn's code for the failure, which the wire carries as `data.mnCode`: the one
 * the connector marked it with (an API error's own `code` is the API's), or
 * the code a typed error of mn's carries. Undefined when it has none.
 */
function mnCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const marked = (err as { mnCode?: unknown }).mnCode;
  if (typeof marked === 'string') return marked;
  const code = (err as { code?: unknown }).code;
  return !isApiError(err) && typeof code === 'string' ? code : undefined;
}

/** Walk an error's cause chain and extract structured data for the JSON-RPC error response. */
function extractErrorData(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error) && !(typeof err === 'object' && err !== null && '_tag' in err)) {
    return undefined;
  }
  const causes: string[] = [];
  let current: unknown = (err as any).cause;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const anyErr = current as any;
    if (current instanceof Error || (typeof current === 'object' && anyErr._tag)) {
      const tag = anyErr._tag;
      const msg = anyErr.message ?? '';
      causes.push(tag ? `[${tag}] ${msg}` : msg);
      current = anyErr.cause;
    } else if (typeof current === 'string') {
      causes.push(current);
      break;
    } else {
      try { causes.push(JSON.stringify(current)); } catch { causes.push(String(current)); }
      break;
    }
  }
  if (causes.length === 0) return undefined;
  return { causes };
}

// ── BigInt-aware JSON serialization ──

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  // We don't auto-convert strings to bigint on parse —
  // the handler layer is responsible for that conversion
  return value;
}

// ── Connection tracking ──

export interface RpcConnection {
  ws: WebSocket;
  id: string;
  connectedAt: Date;
  /** Whether this connection has completed the 'connect' handshake */
  authenticated: boolean;
  /** Network ID after connect */
  networkId?: string;
  /** Number of requests received on this connection */
  requestCount: number;
  /** Send a JSON-RPC notification to this client (no-op if socket is closed) */
  notify(method: string, params?: Record<string, unknown>): void;
}

// ── Server options ──

export interface RpcServerOptions {
  /** The host the server runs in: its notices, and the count its connection ids come from. */
  host: Pick<Host, 'notice' | 'slot'>;
  port: number;
  handlers: Record<string, RpcHandler>;
  /**
   * The browser origins (`http://localhost:5173`, as a browser sends them)
   * that may connect. A browser sends an Origin header on every WebSocket
   * connection, naming the page that opened it, and a Node script sends none:
   * a connection whose Origin isn't listed is refused with HTTP 403, so a web
   * page can reach the wallet only when its origin was allowed. None by
   * default.
   */
  allowedOrigins?: readonly string[];
  /** Called with the origin of each browser connection refused because its origin isn't allowed. */
  onOriginRefused?: (origin: string) => void;
  /** Called when a new WebSocket connection is established */
  onConnect?: (connection: RpcConnection) => void;
  /** Called when a connection is closed */
  onDisconnect?: (connection: RpcConnection) => void;
  /** Called on every incoming request for logging */
  onRequest?: (connection: RpcConnection, request: JsonRpcRequest) => void;
  /** Called after each request completes (success or failure) */
  onResponse?: (
    connection: RpcConnection,
    request: JsonRpcRequest,
    durationMs: number,
    result?: unknown,
    error?: { message: string; code?: string },
    metadata?: Record<string, unknown>,
  ) => void;
}

export interface RpcServer {
  /** The underlying WebSocketServer */
  wss: WebSocketServer;
  /** Active connections */
  connections: Map<string, RpcConnection>;
  /** Resolves once the port is bound; rejects with the bind error (e.g. EADDRINUSE). */
  ready: Promise<void>;
  /** Gracefully close the server and all connections */
  close(): Promise<void>;
}

// ── Parse incoming message ──

function parseRequest(data: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data, jsonReviver);
  } catch {
    throw Object.assign(new Error('Parse error'), { rpcCode: -32700 });
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as any).jsonrpc !== '2.0' ||
    typeof (parsed as any).method !== 'string'
  ) {
    throw Object.assign(new Error('Invalid Request'), { rpcCode: -32600 });
  }

  const req = parsed as JsonRpcRequest;
  if (req.id === undefined || req.id === null) {
    throw Object.assign(new Error('Missing request id'), { rpcCode: -32600 });
  }

  return req;
}

// ── Create server ──

/**
 * What allowing a page's origin means, said wherever one is refused: a page
 * the user merely opened must not get the wallet because a hint said so.
 */
export const ORIGIN_RISK = 'A web page allowed in can ask the wallet for its addresses and balances and ask it to sign and spend '
  + '(without asking, under --approve-all). Allow only your own dApp\'s page, by restarting mn serve with --allow-origin <its origin>; '
  + 'if you don\'t know this page, leave it refused.';

// The connections a host's servers have accepted: ids are unique across its servers.
const CONNECTIONS = defineHostSlot('ws-rpc.connections', () => ({ count: 0 }));

export function createRpcServer(options: RpcServerOptions): RpcServer {
  const { host, port, handlers, onConnect, onDisconnect, onRequest, onResponse, onOriginRefused } = options;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const connections = new Map<string, RpcConnection>();

  // Bind to loopback only — prevents remote machines on the network from
  // connecting. Loopback alone doesn't keep web pages out: any page the user
  // opens can open ws://localhost:<port>, so a browser's connection is
  // accepted only from an allowed origin.
  const wss = new WebSocketServer({
    port,
    host: '127.0.0.1',
    verifyClient: (info: { req: IncomingMessage }, accept: (ok: boolean, code?: number, message?: string) => void) => {
      const origin = info.req.headers.origin;
      if (origin === undefined || allowedOrigins.has(origin)) { accept(true); return; }
      onOriginRefused?.(origin);
      accept(false, 403, `Origin ${origin} is not allowed to reach this wallet. ${ORIGIN_RISK}`);
    },
  });
  const ready = new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  // A caller that never awaits `ready` must not see an unhandled rejection.
  ready.catch(() => { /* surfaced through `ready` */ });

  // Prevent unhandled server-level errors (e.g. port conflict) from crashing
  wss.on('error', (err: Error) => {
    // Callers handle this via the close() method or process-level error handling
    // We just need to prevent the uncaught exception
    host.notice(`WebSocket server error: ${err.message}`);
  });

  wss.on('connection', (ws: WebSocket) => {
    const id = `conn_${++host.slot(CONNECTIONS).count}`;
    const connection: RpcConnection = {
      ws,
      id,
      connectedAt: new Date(),
      authenticated: false,
      requestCount: 0,
      notify(method: string, params?: Record<string, unknown>): void {
        if (ws.readyState !== ws.OPEN) return;
        const notification: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params && { params }) };
        ws.send(JSON.stringify(notification, jsonReplacer));
      },
    };
    connections.set(id, connection);
    onConnect?.(connection);

    // The connect being answered, if any: a request sent right after it, before
    // its answer, waits for it rather than being refused as not connected.
    let handshake: Promise<void> | undefined;

    // Guard against double-disconnect (error fires before close)
    let disconnected = false;
    const handleDisconnect = () => {
      if (disconnected) return;
      disconnected = true;
      connections.delete(id);
      onDisconnect?.(connection);
    };

    ws.on('message', async (raw: Buffer) => {
      let requestId: number | string | null = null;
      let request: JsonRpcRequest | undefined;
      let context: RpcHandlerContext | undefined;
      let endHandshake: (() => void) | undefined;
      const startTime = Date.now();

      try {
        request = parseRequest(raw.toString('utf-8'));
        requestId = request.id;
        connection.requestCount++;
        onRequest?.(connection, request);

        if (request.method === 'connect') {
          handshake = new Promise<void>((resolve) => { endHandshake = resolve; });
        } else if (!connection.authenticated && handshake !== undefined) {
          await handshake;
        }

        // The DApp connector API offers only connect before a connection is
        // made: every other method is the connected API's.
        if (request.method !== 'connect' && !connection.authenticated) {
          throw createApiError('Disconnected', `Not connected: call connect with the wallet's network id before ${request.method}`);
        }

        // Own entries only: a name like "toString" or "__proto__" must not reach Object.prototype.
        const handler = Object.hasOwn(handlers, request.method) ? handlers[request.method] : undefined;
        if (!handler) {
          const response: JsonRpcErrorResponse = {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`,
            },
          };
          ws.send(JSON.stringify(response, jsonReplacer));
          return;
        }

        context = {
          notify: connection.notify.bind(connection),
          connectionId: id,
          requestId: request.id,
          metadata: {},
        };
        const result = await handler(request.params ?? {}, context);
        const durationMs = Date.now() - startTime;

        // Mark as authenticated after successful connect
        if (request.method === 'connect' && result && typeof result === 'object') {
          connection.authenticated = true;
          connection.networkId = (result as any).networkId;
        }

        // A response carries result or error: a handler that returns nothing answers null,
        // where JSON.stringify would drop an undefined result and leave neither.
        const response: JsonRpcSuccessResponse = {
          jsonrpc: '2.0',
          id: request.id,
          result: result === undefined ? null : result,
        };
        ws.send(JSON.stringify(response, jsonReplacer));
        onResponse?.(connection, request, durationMs, result, undefined, context.metadata);
      } catch (err: unknown) {
        const durationMs = Date.now() - startTime;
        const rpcCode = (err as any)?.rpcCode ?? mapErrorToRpcCode(err);
        const message = err instanceof Error ? err.message : 'Internal error';
        // The API's own error data as the specification has it, with mn's code beside it (an additive key).
        const mnCode = mnCodeOf(err);
        const described = isApiError(err) ? { type: err.type, code: err.code } : extractErrorData(err);
        const data = mnCode === undefined ? described : { ...described, mnCode };

        const response: JsonRpcErrorResponse = {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: rpcCode, message, data },
        };
        ws.send(JSON.stringify(response, jsonReplacer));
        if (request) {
          const errorInfo = {
            message,
            code: isApiError(err) ? err.code : undefined,
          };
          onResponse?.(connection, request, durationMs, undefined, errorInfo, context?.metadata);
        }
      } finally {
        // Answered either way: what waited on it goes on, connected or not.
        endHandshake?.();
      }
    });

    ws.on('close', handleDisconnect);

    ws.on('error', () => {
      handleDisconnect();
      try { ws.close(); } catch { /* already closing */ }
    });
  });

  async function close(): Promise<void> {
    // Close all active connections
    for (const conn of connections.values()) {
      conn.ws.close(1001, 'Server shutting down');
    }
    connections.clear();

    return new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { wss, connections, ready, close };
}
