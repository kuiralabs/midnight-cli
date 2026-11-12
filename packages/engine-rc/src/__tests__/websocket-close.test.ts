// The global WebSocket, once the engine has loaded, closes a connection that
// failed with exactly one unclean `close`, on Node 22 as on Node 24 (Node 22,
// patched, gives 1006; Node 24 gives 1002 itself), and one that opened and was
// closed with exactly one `close` too.
//
// Regression: on Node 22 a refused connection fired `error` and never `close`,
// so polkadot-js's WsProvider never cleared its interval and a program stayed
// up after its wallet stopped.

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import '../websocket-close.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

/** Every `close` a socket fires, by property handler and by listener, until `settleMs` after its first. */
function closes(socket: WebSocket, settleMs = 300): Promise<{ handler: number[]; listener: number[]; clean: boolean[] }> {
  const seen = { handler: [] as number[], listener: [] as number[], clean: [] as boolean[] };
  return new Promise((done, fail) => {
    const hung = setTimeout(() => fail(new Error(`no close within 5 s (readyState ${socket.readyState})`)), 5_000);
    socket.onclose = (event) => { seen.handler.push(event.code); };
    socket.addEventListener('close', (event) => {
      seen.listener.push(event.code);
      seen.clean.push(event.wasClean);
      clearTimeout(hung);
      setTimeout(() => done(seen), settleMs);
    });
  });
}

describe('the global WebSocket closes once, whatever ends the connection', () => {
  let server: WebSocketServer | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('a refused connection fires error, then one unclean close', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${await closedPort()}`);
    let errored = false;
    socket.addEventListener('error', () => { errored = true; });
    const seen = await closes(socket);
    expect(errored).toBe(true);
    expect(seen.listener).toHaveLength(1);
    expect(seen.handler).toEqual(seen.listener);
    expect(seen.clean).toEqual([false]);
    expect(seen.listener[0]).not.toBe(1000);
  });

  it('a connection that opened and was closed fires one close with its own code', async () => {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    const seen = closes(socket);
    socket.close(1000);
    expect(await seen).toEqual({ handler: [1000], listener: [1000], clean: [true] });
  });
});
