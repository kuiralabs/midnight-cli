// Stand-ins for the endpoints a balance read reaches, run inside the test.
//
// - An indexer WebSocket speaking enough graphql-transport-ws for mn's
//   unshielded balance subscription (lib/balance-subscription.ts):
//   connection_init → connection_ack; subscribe → a progress event with the
//   highest transaction id, then one transaction event per answer, each
//   creating one NIGHT UTXO, `delayMs` apart.
// - An endpoint that refuses every connection: it listens (so no other test
//   can take its port) and drops each connection at once.
// - An indexer of a ledger-8 chain: its HTTP GraphQL endpoint answers every
//   query with a protocol version below the ledger-9 fork, which mn refuses
//   before a wallet syncs (lib/ledger-guard.ts).
// - A silent network: an indexer and a node on one port that take every
//   connection and never answer (the indexer acknowledges graphql-transport-ws
//   and sends no event; the node takes JSON-RPC and replies to none), counting
//   the WebSockets a wallet opens and how many it has closed.

import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { NATIVE_TOKEN_TYPE } from '@kuiralabs/midnight-cli-core';

/** One subscription the stand-in indexer took. */
export interface Subscription {
  /** The address it was asked for. */
  readonly address: string;
  /** How many transaction events it has sent. */
  sent: number;
  /** It sent every transaction event. */
  done: boolean;
  /** The client closed the connection before it sent every event. */
  closedEarly: boolean;
}

export interface StandInIndexer {
  /** The indexer's WebSocket URL, as `--indexer-ws` takes it. */
  readonly url: string;
  readonly subscriptions: Subscription[];
  /** Resolves once a subscription has sent `count` transaction events. */
  sentAtLeast(count: number): Promise<void>;
  close(): Promise<void>;
}

/** A stand-in indexer answering every subscription with one NIGHT UTXO per value in `values`, `delayMs` apart. */
export async function startStandInIndexer(values: readonly bigint[], delayMs: number): Promise<StandInIndexer> {
  const subscriptions: Subscription[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const wakeWaiters = (): void => {
    for (const waiter of [...waiters]) {
      if (subscriptions.some((s) => s.sent >= waiter.count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: (protocols) => (protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false) });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  server.on('connection', (ws: WebSocket) => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let subscription: Subscription | undefined;
    ws.on('close', () => {
      for (const timer of timers) clearTimeout(timer);
      if (subscription !== undefined && !subscription.done) subscription.closedEarly = true;
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: string; type: string; payload?: { variables?: { address?: string } } };
      if (message.type === 'connection_init') {
        ws.send(JSON.stringify({ type: 'connection_ack' }));
        return;
      }
      if (message.type !== 'subscribe') return;
      const id = message.id;
      const current: Subscription = { address: String(message.payload?.variables?.address), sent: 0, done: false, closedEarly: false };
      subscription = current;
      subscriptions.push(current);
      const next = (event: unknown): void => { ws.send(JSON.stringify({ id, type: 'next', payload: { data: { unshieldedTransactions: event } } })); };
      next({ __typename: 'UnshieldedTransactionsProgress', highestTransactionId: values.length });
      values.forEach((value, at) => {
        timers.push(setTimeout(() => {
          if (ws.readyState !== ws.OPEN) return;
          const utxo = { value: value.toString(), owner: current.address, tokenType: NATIVE_TOKEN_TYPE, intentHash: `intent-${at + 1}`, outputIndex: 0, registeredForDustGeneration: false };
          next({ __typename: 'UnshieldedTransaction', transaction: { id: at + 1, hash: `hash-${at + 1}` }, createdUtxos: [utxo], spentUtxos: [] });
          current.sent += 1;
          if (current.sent === values.length) current.done = true;
          wakeWaiters();
        }, delayMs * (at + 1)));
      });
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/api/v4/graphql/ws`,
    subscriptions,
    sentAtLeast: (count) => new Promise<void>((resolve) => { waiters.push({ count, resolve }); wakeWaiters(); }),
    close: () => new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(() => resolve());
    }),
  };
}

/** An endpoint that refuses every connection: it keeps its port, and drops each connection the moment it opens. */
export async function startRefusingEndpoint(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** A ledger-8 chain's indexer, as its HTTP GraphQL endpoint answers. */
export interface Ledger8Indexer {
  /** Its WebSocket URL, as `--indexer-ws` takes it; mn reads the HTTP endpoint beside it. */
  readonly url: string;
  /** The queries it was asked, in order. */
  readonly queries: string[];
  close(): Promise<void>;
}

/** An indexer whose chain is on ledger 8 (protocol version 1000000): every query is answered with that block. */
export function startLedger8Indexer(): Promise<Ledger8Indexer> {
  return startIndexerOnProtocol(1_000_000);
}

/** An indexer whose chain's tip is at `protocolVersion` (ledger 9 from 2000000): every query is answered with that block. */
export async function startIndexerOnProtocol(protocolVersion: number): Promise<Ledger8Indexer> {
  const queries: string[] = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      queries.push((JSON.parse(body) as { query: string }).query);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { block: { protocolVersion } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/api/v4/graphql/ws`,
    queries,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** An indexer and a node that take every connection and never answer. */
export interface SilentNetwork {
  /** The indexer's HTTP and WebSocket URLs, and the node's, as a network config takes them. */
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  /** The WebSockets opened to it, by path, and how many of them are still open. */
  readonly opened: string[];
  open(): number;
  /** Resolves once every WebSocket opened to it has closed. */
  allClosed(): Promise<void>;
  close(): Promise<void>;
}

/** A silent network on 127.0.0.1: the indexer at /api/v4/graphql(/ws), the node at /node. */
export async function startSilentNetwork(): Promise<SilentNetwork> {
  const opened: string[] = [];
  let open = 0;
  let wakeWhenClosed: Array<() => void> = [];
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: null }));
    });
  });
  const sockets = new WebSocketServer({ server, handleProtocols: (protocols) => (protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false) });
  sockets.on('connection', (ws: WebSocket, req) => {
    opened.push(req.url ?? '');
    open += 1;
    ws.on('close', () => {
      open -= 1;
      if (open === 0) for (const wake of wakeWhenClosed.splice(0)) wake();
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string };
      if (message.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `127.0.0.1:${port}`;
  return {
    indexer: `http://${base}/api/v4/graphql`,
    indexerWS: `ws://${base}/api/v4/graphql/ws`,
    node: `ws://${base}/node`,
    opened,
    open: () => open,
    allClosed: () => new Promise<void>((resolve) => {
      if (open === 0) resolve();
      else wakeWhenClosed = [...wakeWhenClosed, resolve];
    }),
    close: () => new Promise<void>((resolve) => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
