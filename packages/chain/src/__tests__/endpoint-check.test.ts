// What is asked of a network's endpoints before a wallet sync starts, and before a command starts its work.

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { BlockfrostProjectIdRejectedError, BlockfrostProjectIdRequiredError, CancelledError, EndpointShutDownError, EndpointUnreachableError, blockfrostEndpoints } from '@kuiralabs/midnight-cli-core';
import { assertEndpointsReachable, assertNetworkAnswers, endpointsOf } from '../lib/endpoint-check.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

const ID = 'nightpreprodAbCdEfGhIjKlMnOpQrStUv0123';
const LOCAL = { indexer: 'http://localhost:8088/api/v4/graphql', indexerWS: 'ws://localhost:8088/api/v4/graphql/ws', node: 'ws://localhost:9944' };

/** A `fetch` that answers every request with `status`, and writes down what it was asked. */
function answering(status: number) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { asked, request };
}

describe('assertNetworkAnswers', () => {
  it('asks nothing of a network Blockfrost doesn\'t serve', async () => {
    const { asked, request } = answering(500);
    await assertNetworkAnswers(LOCAL, request);
    expect(asked).toEqual([]);
  });

  it('stops before asking when Blockfrost has no project id to go with', async () => {
    const { asked, request } = answering(200);
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', undefined), request)).rejects.toThrow(BlockfrostProjectIdRequiredError);
    expect(asked).toEqual([]);
  });

  it('stops before asking when an endpoint is one that was shut down', async () => {
    const { asked, request } = answering(200);
    const network = { ...LOCAL, indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws' };
    await expect(assertNetworkAnswers(network, request)).rejects.toThrow(EndpointShutDownError);
    expect(asked).toEqual([]);
  });

  it('asks Blockfrost\'s indexer one small query, and passes when it answers', async () => {
    const { asked, request } = answering(200);
    const network = blockfrostEndpoints('preprod', ID);
    await assertNetworkAnswers(network, request);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe(network.indexer);
    expect(asked[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(asked[0]!.init?.body))).toEqual({ query: '{ __typename }' });
  });

  it('says the project id was refused when Blockfrost answers 403', async () => {
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', ID), answering(403).request)).rejects.toThrow(BlockfrostProjectIdRejectedError);
  });

  it('leaves an endpoint that can\'t be reached, or answers something else, to the sync to report', async () => {
    const unreachable = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', ID), unreachable)).resolves.toBeUndefined();
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', ID), answering(500).request)).resolves.toBeUndefined();
  });
});

describe('assertEndpointsReachable', () => {
  /** An HTTP server that answers every request with 200, and a WebSocket server on the same port. */
  async function answeringServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":{"__typename":"Query"}}'); });
    const wss = new WebSocketServer({ server });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { port, close: () => new Promise((resolve) => { wss.close(); server.close(() => resolve()); }) };
  }

  /** A port that accepts the connection and never answers. */
  async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const sockets: Socket[] = [];
    const server = createNetServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { port, close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }) };
  }

  it('passes when the indexer, the node and the proof server answer', async () => {
    const up = await answeringServer();
    try {
      await assertEndpointsReachable({ indexer: `http://127.0.0.1:${up.port}/api/v4/graphql`, node: `ws://127.0.0.1:${up.port}`, proofServer: `http://127.0.0.1:${up.port}` });
    } finally {
      await up.close();
    }
  });

  it('names the endpoint that refuses the connection, its URL and what to set, as NETWORK_ERROR', async () => {
    const up = await answeringServer();
    const port = await closedPort();
    try {
      const failure = assertEndpointsReachable({ indexer: `http://127.0.0.1:${up.port}/api/v4/graphql`, node: `ws://127.0.0.1:${up.port}`, proofServer: `http://127.0.0.1:${port}` });
      await expect(failure).rejects.toBeInstanceOf(EndpointUnreachableError);
      await expect(failure).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        endpoint: 'proof server',
        message: `Cannot reach the proof server at http://127.0.0.1:${port}: connection refused.\nCheck that it is running and that the URL is right (--proof-server, or: midnight config set proof-server <url>).\nmn proves on this machine on every network. On preview, preprod and mainnet start a proof server with: docker run -p 6300:6300 midnightntwrk/proof-server:9.0.0 midnight-proof-server -v (on undeployed, midnight localnet up starts one).`,
      });
    } finally {
      await up.close();
    }
  });

  it('names a node that refuses the WebSocket connection', async () => {
    const port = await closedPort();
    await expect(assertEndpointsReachable({ node: `ws://127.0.0.1:${port}` })).rejects.toMatchObject({ code: 'NETWORK_ERROR', endpoint: 'node', message: expect.stringContaining(`Cannot reach the node at ws://127.0.0.1:${port}: connection refused.`) });
  });

  it('names an endpoint Bun\'s fetch can\'t connect to as NETWORK_ERROR, not as an error of its own', async () => {
    // Bun's fetch rejects with an Error whose code is "ConnectionRefused" (measured with Bun 1.3.14), where Node's throws a TypeError.
    const bunRefused = (async () => { throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }); }) as typeof fetch;
    const failure = assertEndpointsReachable({ indexer: 'http://127.0.0.1:1/api/v4/graphql' }, { request: bunRefused });
    await expect(failure).rejects.toBeInstanceOf(EndpointUnreachableError);
    await expect(failure).rejects.toMatchObject({ code: 'NETWORK_ERROR', endpoint: 'indexer', message: expect.stringContaining('Cannot reach the indexer at http://127.0.0.1:1/api/v4/graphql: cannot connect (connection refused, or no such host).') });
  });

  it('gives up on a silent endpoint within its timeout', async () => {
    const silent = await silentServer();
    try {
      const started = Date.now();
      await expect(assertEndpointsReachable({ indexer: `http://127.0.0.1:${silent.port}/api/v4/graphql`, node: `ws://127.0.0.1:${silent.port}` }, { timeoutMs: 300 }))
        .rejects.toMatchObject({ code: 'NETWORK_ERROR', endpoint: 'indexer', message: expect.stringContaining('no answer in time') });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await silent.close();
    }
  });

  it('throws the endpoint\'s own error when it can\'t be used as configured', async () => {
    await expect(assertEndpointsReachable({ indexer: blockfrostEndpoints('preprod', undefined).indexer })).rejects.toThrow(BlockfrostProjectIdRequiredError);
  });

  it('stops with CancelledError when the call is cancelled', async () => {
    const silent = await silentServer();
    try {
      const controller = new AbortController();
      const failure = assertEndpointsReachable({ node: `ws://127.0.0.1:${silent.port}` }, { signal: controller.signal });
      controller.abort();
      await expect(failure).rejects.toBeInstanceOf(CancelledError);
    } finally {
      await silent.close();
    }
  });

  it('asks for the proof server only for a command that proves', () => {
    const network = { indexer: 'http://i', node: 'ws://n', proofServer: 'http://p' };
    expect(endpointsOf(network)).toEqual({ indexer: 'http://i', node: 'ws://n' });
    expect(endpointsOf(network, { proofServer: true })).toEqual({ indexer: 'http://i', node: 'ws://n', proofServer: 'http://p' });
    expect(endpointsOf(network, { node: false })).toEqual({ indexer: 'http://i' });
  });
});
