// Stand-ins for the endpoints a balance read reaches, run inside the test.
//
// - An indexer WebSocket speaking enough graphql-transport-ws for mn's
//   unshielded balance subscription (lib/balance-subscription.ts):
//   connection_init → connection_ack; subscribe → a progress event with the
//   highest transaction id, then one transaction event per answer, each
//   creating one NIGHT UTXO, `delayMs` apart.
// - An endpoint that refuses every connection: it listens (so no other test
//   can take its port) and drops each connection at once.

import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { NATIVE_TOKEN_TYPE } from '../../lib/constants.ts';

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
