// How mn says why an endpoint could not be reached.

import { describe, expect, it } from 'vitest';
import { transportReason } from '../lib/endpoint-unreachable.ts';

describe('transportReason', () => {
  it('reads the transport\'s code where fetch keeps it, under "fetch failed"', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    expect(transportReason(new TypeError('fetch failed', { cause: refused }))).toBe('connection refused');
    expect(transportReason(new AggregateError([Object.assign(new Error('x'), { code: 'ENOTFOUND' })], 'fetch failed'))).toBe('no such host');
  });

  it('says a timeout was one', () => {
    expect(transportReason(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe('no answer in time');
  });

  it('never gives an empty message or an event turned into a string', () => {
    expect(transportReason(new Error('[object ErrorEvent]'))).toBe('the connection failed');
    expect(transportReason(new TypeError('fetch failed'))).toBe('the connection failed');
    expect(transportReason({ message: '', error: new Error('Unexpected server response: 404') })).toBe('Unexpected server response: 404');
  });
});
