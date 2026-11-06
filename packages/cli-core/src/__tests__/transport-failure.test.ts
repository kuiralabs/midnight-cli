// A connection that could not be made, as the engine boundary, a contract
// script and grant recognise it: by the transport's code anywhere among the
// failure's causes, or by the words the SDK says it with.

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { carriesOwnCode, isTransportFailure, withTransportCode } from '../lib/transport-failure.ts';
import { DustRequiredError, NetworkError } from '../lib/errors.ts';
import { classifyError } from '../lib/exit-codes.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

/** What a WebSocket to a closed port fails with: the socket's own error, ECONNREFUSED its code. */
async function refusedWebSocket(): Promise<Error> {
  const port = await closedPort();
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('error', (err) => resolve(err));
  });
}

describe('isTransportFailure', () => {
  it("names a socket's refusal, by its code", async () => {
    const refused = await refusedWebSocket();
    expect((refused as Error & { code?: string }).code).toBe('ECONNREFUSED');
    expect(isTransportFailure(refused)).toBe(true);
  });

  it("names fetch's failure, whose code is its cause's (an AggregateError's members, for a name with several addresses)", async () => {
    const fetched = await fetch(`http://127.0.0.1:${await closedPort()}/`).then(() => { throw new Error('expected fetch to fail'); }, (e: Error) => e);
    expect(fetched.message).toBe('fetch failed');
    expect(isTransportFailure(Object.assign(new Error('the indexer could not be asked'), { cause: fetched }))).toBe(true);
    const aggregate = new AggregateError([Object.assign(new Error('connect'), { code: 'ETIMEDOUT' })], 'several addresses');
    expect(isTransportFailure(new Error('no answer', { cause: aggregate }))).toBe(true);
    expect(isTransportFailure({ type: 'error', error: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) })).toBe(true);
  });

  it("names the SDK's words for it, in the failure's own message", () => {
    for (const said of ['fetch failed', 'WebSocket connection closed', 'connect ECONNREFUSED 127.0.0.1:6300', 'Connection refused', 'request to http://localhost:8088/api/v4/graphql failed, reason:', 'Network error: socket hang up']) {
      expect(isTransportFailure(new Error(said))).toBe(true);
    }
  });

  it('names nothing else, and survives a message that cannot be read', () => {
    expect(isTransportFailure(new Error('Something unexpected happened'))).toBe(false);
    expect(isTransportFailure(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
    expect(isTransportFailure('ECONNREFUSED')).toBe(false);
    const unreadable = Object.defineProperty(new Error(), 'message', { get() { throw new Error('no message'); } });
    expect(isTransportFailure(unreadable)).toBe(false);
  });

  it('runs from its own source text, as a contract script carries it', () => {
    const inlined = new Function(`return (${isTransportFailure.toString()});`)() as typeof isTransportFailure;
    expect(inlined(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(inlined(new Error('fetch failed'))).toBe(true);
    expect(inlined(new Error('Something unexpected happened'))).toBe(false);
  });
});

describe('withTransportCode', () => {
  it('reports a transport failure with no code of its own as a NetworkError, the failure its cause', async () => {
    const refused = await refusedWebSocket();
    const reported = withTransportCode(refused) as Error;
    expect(reported).toBeInstanceOf(NetworkError);
    expect(reported.message).toBe(refused.message);
    expect(reported.cause).toBe(refused);
    expect(classifyError(reported, CORE_CODES)).toStrictEqual({ errorCode: 'NETWORK_ERROR', exitCode: 4 });
  });

  it('leaves an error with a code of its own, and any other error, as it is', () => {
    const own = new DustRequiredError('Dust not available', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    expect(carriesOwnCode(own)).toBe(true);
    expect(withTransportCode(own)).toBe(own);
    const other = new Error('Something unexpected happened');
    expect(withTransportCode(other)).toBe(other);
    expect(carriesOwnCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(false);
  });
});
