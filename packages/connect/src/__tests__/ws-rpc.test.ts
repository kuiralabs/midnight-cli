import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createRpcServer, createApiError, type RpcServer } from '../lib/ws-rpc.ts';
import { createHost, DustRequiredError } from '@kuiralabs/midnight-cli-core';

// The host the servers run in: notices dropped.
const host = createHost();

// Test helpers
function sendRpc(ws: WebSocket, id: number, method: string, params?: Record<string, unknown>): void {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString('utf-8')));
    });
  });
}

/** A socket to the server, open but not connected to the wallet. */
function openClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** A socket to the server, connected to the wallet as a dApp connects first (`connect`). */
async function connectClient(port: number): Promise<WebSocket> {
  const ws = await openClient(port);
  const answered = waitForMessage(ws);
  sendRpc(ws, 0, 'connect', { networkId: 'undeployed' });
  await answered;
  return ws;
}

/** A server whose handlers answer `connect` too, as every connector's do. */
function serve(options: Parameters<typeof createRpcServer>[0]): RpcServer {
  return createRpcServer({ ...options, handlers: { connect: async () => ({ networkId: 'undeployed' }), ...options.handlers } });
}

// Use unique ports to avoid conflicts
let testPort = 19921;
function nextPort(): number {
  return testPort++;
}

describe('ws-rpc', () => {
  let server: RpcServer | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of clients) {
      ws.close();
    }
    clients.length = 0;
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  describe('before connect', () => {
    // Regression: every method answered on a socket that never called connect,
    // though the DApp connector API offers only connect until then.
    it('refuses every method but connect as Disconnected, and answers once connected', async () => {
      const port = nextPort();
      server = serve({ host, port, handlers: { getDustBalance: async () => ({ cap: 1n, balance: 1n }) } });
      const ws = await openClient(port);
      clients.push(ws);

      let answered = waitForMessage(ws);
      sendRpc(ws, 1, 'getDustBalance');
      const refused = await answered;
      expect(refused.result).toBeUndefined();
      expect(refused.error.code).toBe(-32002);
      expect(refused.error.data.code).toBe('Disconnected');
      expect(refused.error.message).toMatch(/Not connected: call connect/);

      answered = waitForMessage(ws);
      sendRpc(ws, 2, 'connect', { networkId: 'undeployed' });
      expect((await answered).result).toEqual({ networkId: 'undeployed' });

      answered = waitForMessage(ws);
      sendRpc(ws, 3, 'getDustBalance');
      expect((await answered).result).toEqual({ cap: '1', balance: '1' });
    });

    // Regression: a request sent right after connect, without awaiting its
    // answer, was refused as Disconnected while connect was still running.
    it('answers a request sent right after connect, before its answer, once connect has answered', async () => {
      const port = nextPort();
      let finishConnect: () => void = () => {};
      server = createRpcServer({ host, port, handlers: {
        connect: () => new Promise((resolve) => { finishConnect = () => resolve({ networkId: 'undeployed' }); }),
        getDustBalance: async () => ({ cap: 1n, balance: 1n }),
      } });
      const ws = await openClient(port);
      clients.push(ws);
      const answers: any[] = [];
      const both = new Promise<void>((resolve) => {
        ws.on('message', (data: Buffer) => {
          answers.push(JSON.parse(data.toString('utf-8')));
          if (answers.length === 2) resolve();
        });
      });

      sendRpc(ws, 1, 'connect', { networkId: 'undeployed' });
      sendRpc(ws, 2, 'getDustBalance');
      // Both requests are in before connect answers.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answers).toEqual([]);
      finishConnect();
      await both;

      expect(answers.map((a) => a.id)).toEqual([1, 2]);
      expect(answers[1].result).toEqual({ cap: '1', balance: '1' });
    });

    it('refuses a request sent right after a connect the wallet refuses, as Disconnected', async () => {
      const port = nextPort();
      server = createRpcServer({ host, port, handlers: {
        connect: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); throw createApiError('InvalidRequest', 'Network mismatch'); },
        getDustBalance: async () => 'ok',
      } });
      const ws = await openClient(port);
      clients.push(ws);
      const answers: any[] = [];
      const both = new Promise<void>((resolve) => {
        ws.on('message', (data: Buffer) => {
          answers.push(JSON.parse(data.toString('utf-8')));
          if (answers.length === 2) resolve();
        });
      });
      sendRpc(ws, 1, 'connect', { networkId: 'mainnet' });
      sendRpc(ws, 2, 'getDustBalance');
      await both;
      expect(answers.find((a) => a.id === 1).error.message).toBe('Network mismatch');
      expect(answers.find((a) => a.id === 2).error.data.code).toBe('Disconnected');
    });

    it('stays unconnected after a connect the wallet refused', async () => {
      const port = nextPort();
      server = createRpcServer({ host, port, handlers: {
        connect: async () => { throw createApiError('InvalidRequest', 'Network mismatch'); },
        getDustBalance: async () => 'ok',
      } });
      const ws = await openClient(port);
      clients.push(ws);
      let answered = waitForMessage(ws);
      sendRpc(ws, 1, 'connect', { networkId: 'mainnet' });
      expect((await answered).error.message).toBe('Network mismatch');
      answered = waitForMessage(ws);
      sendRpc(ws, 2, 'getDustBalance');
      expect((await answered).error.data.code).toBe('Disconnected');
    });
  });

  describe('createRpcServer', () => {
    it('starts a WebSocket server on the given port', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    /** How a socket opened from a page at `origin` ends: 'open', or the HTTP status it was refused with. */
    async function openFrom(port: number, origin: string): Promise<{ outcome: number | 'open'; body: string; ws: WebSocket }> {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
      ws.on('error', () => { /* a refused socket errors when terminated */ });
      return new Promise((resolve) => {
        ws.once('unexpected-response', (_req, res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve({ outcome: res.statusCode ?? 0, body, ws }));
        });
        ws.once('open', () => resolve({ outcome: 'open', body: '', ws }));
      });
    }

    // Regression: mn serve accepted a connection from any web page the user
    // opened, so under --approve-all a page could spend and sign.
    // Regression: the refusal told whoever read it to start mn serve with
    // --allow-origin <that page>, nudging users to let an unknown page in.
    it('refuses a connection from a browser page (an Origin) by default, saying what allowing one risks, and accepts mn\'s own scripts', async () => {
      const port = nextPort();
      const refusedOrigins: string[] = [];
      server = serve({ host, port, handlers: {}, onOriginRefused: (origin) => refusedOrigins.push(origin) });
      await server.ready;

      const fromPage = await openFrom(port, 'https://evil.example');
      fromPage.ws.terminate();
      expect(fromPage.outcome).toBe(403);
      expect(fromPage.body).toContain('Origin https://evil.example is not allowed to reach this wallet');
      expect(fromPage.body).toContain('can ask the wallet for its addresses and balances and ask it to sign and spend');
      expect(fromPage.body).toContain('if you don\'t know this page, leave it refused');
      expect(fromPage.body).not.toContain('--allow-origin https://evil.example');
      expect(refusedOrigins).toEqual(['https://evil.example']);
      expect(server.connections.size).toBe(0);

      const fromScript = await connectClient(port);
      clients.push(fromScript);
      expect(fromScript.readyState).toBe(WebSocket.OPEN);
    });

    it('accepts a browser page only from an allowed origin', async () => {
      const port = nextPort();
      server = serve({ host, port, handlers: {}, allowedOrigins: ['http://localhost:5173'] });
      await server.ready;

      const allowed = await openFrom(port, 'http://localhost:5173');
      clients.push(allowed.ws);
      expect(allowed.outcome).toBe('open');

      for (const other of ['http://localhost:5174', 'http://127.0.0.1:5173', 'https://localhost:5173', 'null']) {
        const refused = await openFrom(port, other);
        refused.ws.terminate();
        expect(refused.outcome, other).toBe(403);
      }
    });

    // Regression: a handler that returns nothing (hintUsage) was answered
    // {"jsonrpc":"2.0","id":1}, neither result nor error, which JSON-RPC 2.0 forbids.
    it('answers a handler that returns nothing with result null', async () => {
      const port = nextPort();
      server = serve({ host, port, handlers: { hintUsage: async () => undefined } });
      const ws = await connectClient(port);
      clients.push(ws);
      const raw = new Promise<string>((resolve) => ws.once('message', (data: Buffer) => resolve(data.toString('utf-8'))));
      sendRpc(ws, 1, 'hintUsage', { methodNames: ['getDustBalance'] });
      expect(JSON.parse(await raw)).toStrictEqual({ jsonrpc: '2.0', id: 1, result: null });
    });

    it('dispatches method calls to handlers', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {
          echo: async (params) => params,
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'echo', { message: 'hello' });
      const response = await responsePromise;

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ message: 'hello' });
    });

    it('returns method not found for unknown methods', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'nonExistentMethod');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('nonExistentMethod');
    });

    it.each(['toString', 'hasOwnProperty', 'constructor', '__proto__', 'valueOf', '__defineGetter__'])(
      'treats %s, inherited from Object.prototype, as an unknown method',
      async (method) => {
        const port = nextPort();
        server = serve({ host, port, handlers: { getDustBalance: async () => 'ok' } });
        const ws = await connectClient(port);
        clients.push(ws);

        const responsePromise = waitForMessage(ws);
        sendRpc(ws, 1, method, { a: 1 });
        const response = await responsePromise;

        expect(response.result).toBeUndefined();
        expect(response.error).toEqual({ code: -32601, message: `Method not found: ${method}` });
      },
    );

    it('returns parse error for invalid JSON', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      ws.send('not json');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32700);
    });

    it('returns invalid request for malformed JSON-RPC', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      ws.send(JSON.stringify({ jsonrpc: '1.0', method: 'test' }));
      const response = await responsePromise;

      expect(response.error.code).toBe(-32600);
    });

    it('serializes bigint values as strings in responses', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {
          getBalance: async () => ({ balance: 5000000n }),
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'getBalance');
      const response = await responsePromise;

      expect(response.result.balance).toBe('5000000');
    });

    it('maps APIError to JSON-RPC error with data', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {
          reject: async () => {
            throw createApiError('Rejected', 'User rejected the request');
          },
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'reject');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32000);
      expect(response.error.message).toBe('User rejected the request');
      expect(response.error.data).toEqual({
        type: 'DAppConnectorAPIError',
        code: 'Rejected',
      });
    });

    it("carries mn's code for an APIError beside the API's own, as an additive key", async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {
          short: async () => { throw createApiError('InternalError', "Not enough Dust available for this transaction's fee", 'DUST_REQUIRED'); },
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'short');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toBe("Not enough Dust available for this transaction's fee");
      expect(response.error.data).toEqual({ type: 'DAppConnectorAPIError', code: 'InternalError', mnCode: 'DUST_REQUIRED' });
    });

    it("carries the code of mn's typed error as mnCode, beside its causes", async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {
          short: async () => { throw new DustRequiredError('Dust not available', { cause: new Error('the wallet SDK said so') }); },
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'short');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32603);
      expect(response.error.data).toEqual({ causes: ['the wallet SDK said so'], mnCode: 'DUST_REQUIRED' });
    });

    it('tracks connections', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {},
      });

      expect(server.connections.size).toBe(0);

      const ws = await connectClient(port);
      clients.push(ws);

      // Small delay for connection to be registered
      await new Promise((r) => setTimeout(r, 50));
      expect(server.connections.size).toBe(1);
    });

    it('returns internal error for non-APIError exceptions', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {
          broken: async () => { throw new TypeError('Cannot read property of undefined'); },
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'broken');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32603); // Internal error
      expect(response.error.message).toContain('Cannot read property of undefined');
      expect(response.error.data).toBeUndefined(); // No APIError data
    });

    it('calls onDisconnect only once when error fires before close', async () => {
      const disconnections: string[] = [];
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {},
        onDisconnect: (conn) => disconnections.push(conn.id),
      });

      const ws = await connectClient(port);
      await new Promise((r) => setTimeout(r, 50));

      // terminate() causes both error and close events
      ws.terminate();
      await new Promise((r) => setTimeout(r, 100));

      // Should be exactly 1 despite both error + close firing
      expect(disconnections.length).toBe(1);
    });

    it('calls onConnect and onDisconnect callbacks', async () => {
      const port = nextPort();
      const events: string[] = [];

      server = serve({
        host,
        port,
        handlers: {},
        onConnect: () => events.push('connect'),
        onDisconnect: () => events.push('disconnect'),
      });

      const ws = await connectClient(port);
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain('connect');

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain('disconnect');
    });
  });

  describe('requestCount', () => {
    it('increments per request on the same connection', async () => {
      const port = nextPort();
      const counts: number[] = [];
      server = serve({
        host,
        port,
        handlers: {
          ping: async () => 'pong',
        },
        onRequest: (conn) => counts.push(conn.requestCount),
      });

      const ws = await connectClient(port);
      clients.push(ws);

      sendRpc(ws, 1, 'ping');
      await waitForMessage(ws);
      sendRpc(ws, 2, 'ping');
      await waitForMessage(ws);
      sendRpc(ws, 3, 'ping');
      await waitForMessage(ws);

      // The connect the client made first is the connection's first request.
      expect(counts).toEqual([1, 2, 3, 4]);
    });
  });

  describe('onResponse', () => {
    it('calls onResponse with result on success', async () => {
      const port = nextPort();
      const responses: Array<{ method: string; result: unknown; error?: { message: string; code?: string } }> = [];
      server = serve({
        host,
        port,
        handlers: {
          echo: async (params) => params,
        },
        onResponse: (_conn, req, _durationMs, result, error) => {
          if (req.method !== 'connect') responses.push({ method: req.method, result, error });
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      sendRpc(ws, 1, 'echo', { msg: 'hi' });
      await waitForMessage(ws);

      expect(responses).toHaveLength(1);
      expect(responses[0].method).toBe('echo');
      expect(responses[0].result).toEqual({ msg: 'hi' });
      expect(responses[0].error).toBeUndefined();
    });

    it('calls onResponse with error on failure', async () => {
      const port = nextPort();
      const responses: Array<{ method: string; result?: unknown; error?: { message: string; code?: string } }> = [];
      server = serve({
        host,
        port,
        handlers: {
          fail: async () => { throw new Error('broken'); },
        },
        onResponse: (_conn, req, _durationMs, result, error) => {
          if (req.method !== 'connect') responses.push({ method: req.method, result, error });
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      sendRpc(ws, 1, 'fail');
      await waitForMessage(ws);

      expect(responses).toHaveLength(1);
      expect(responses[0].method).toBe('fail');
      expect(responses[0].result).toBeUndefined();
      expect(responses[0].error).toEqual({ message: 'broken', code: undefined });
    });

    it('provides durationMs greater than or equal to zero', async () => {
      const port = nextPort();
      let capturedDuration = -1;
      server = serve({
        host,
        port,
        handlers: {
          slow: async () => {
            await new Promise((r) => setTimeout(r, 20));
            return 'done';
          },
        },
        onResponse: (_conn, _req, durationMs) => {
          capturedDuration = durationMs;
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      sendRpc(ws, 1, 'slow');
      await waitForMessage(ws);

      expect(capturedDuration).toBeGreaterThanOrEqual(15);
    });
  });

  describe('connectionId in handler context', () => {
    it('passes connectionId to handler context', async () => {
      const port = nextPort();
      let capturedId = '';
      server = serve({
        host,
        port,
        handlers: {
          whoami: async (_params, context) => {
            capturedId = context.connectionId;
            return { id: context.connectionId };
          },
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'whoami');
      const response = await responsePromise;

      expect(capturedId).toMatch(/^conn_\d+$/);
      expect(response.result.id).toBe(capturedId);
    });
  });

  describe('createApiError', () => {
    it('creates an APIError with correct properties', () => {
      const err = createApiError('Rejected', 'User said no');

      expect(err).toBeInstanceOf(Error);
      expect(err.type).toBe('DAppConnectorAPIError');
      expect(err.code).toBe('Rejected');
      expect(err.reason).toBe('User said no');
      expect(err.message).toBe('User said no');
    });

    it('creates errors for all error codes', () => {
      const codes = ['InternalError', 'Rejected', 'InvalidRequest', 'PermissionRejected', 'Disconnected'] as const;
      for (const code of codes) {
        const err = createApiError(code, `test ${code}`);
        expect(err.code).toBe(code);
      }
    });
  });

  describe('close', () => {
    it('closes all connections and the server', async () => {
      const port = nextPort();
      server = serve({
        host,
        port,
        handlers: {},
      });

      const ws = await connectClient(port);

      const closePromise = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });

      await server.close();
      await closePromise;
      server = undefined; // Already closed
    });

    it('calls onDisconnect when WebSocket errors', async () => {
      const disconnections: string[] = [];
      const p = nextPort();
      server = serve({
        host,
        port: p,
        handlers: {},
        onDisconnect: (conn) => disconnections.push(conn.id),
      });

      const ws = await connectClient(p);

      // Force an error by terminating the socket abruptly
      ws.terminate();

      // Wait for disconnect handler
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(disconnections.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('createRpcServer readiness', () => {
  // `mn serve` must not report ready (or keep running) when its port is taken:
  // a client would then talk to whatever already listens there.
  it('resolves ready once listening', async () => {
    const server = serve({ host, port: 0, handlers: {} });
    await expect(server.ready).resolves.toBeUndefined();
    await server.close();
  });

  it('rejects ready with EADDRINUSE when the port is already taken', async () => {
    const { createServer } = await import('node:net');
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as import('node:net').AddressInfo).port;
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as any;
    try {
      const server = serve({ host, port, handlers: {} });
      await expect(server.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await server.close();
    } finally {
      process.stderr.write = origWrite;
      blocker.close();
    }
  });
});
