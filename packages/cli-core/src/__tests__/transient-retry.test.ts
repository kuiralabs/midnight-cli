// A read whose connection fails is run again after a wait; any other failure,
// an endpoint's own refusal, or the last failure, is thrown.

import { describe, expect, it } from 'vitest';
import { BlockfrostProjectIdRejectedError, CancelledError, NetworkError, isTransientNetworkFailure, retryingTransient } from '../index.ts';

describe('isTransientNetworkFailure', () => {
  it('is a NETWORK_ERROR, or a transport failure carrying no code of its own', () => {
    expect(isTransientNetworkFailure(new NetworkError('WebSocket error: socket hang up'))).toBe(true);
    expect(isTransientNetworkFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }))).toBe(true);
  });

  it('is not an endpoint refusing the request, a cancel, or any other failure', () => {
    expect(isTransientNetworkFailure(new BlockfrostProjectIdRejectedError('preprod'))).toBe(false);
    expect(isTransientNetworkFailure(new CancelledError())).toBe(false);
    expect(isTransientNetworkFailure(new Error('deserialize event 7: bad tag'))).toBe(false);
  });
});

describe('retryingTransient', () => {
  it('runs the read again after each wait until it succeeds, saying each retry', async () => {
    let calls = 0;
    const said: string[] = [];
    const result = await retryingTransient(async () => {
      calls++;
      if (calls < 3) throw new NetworkError('WebSocket error: socket hang up');
      return 'read';
    }, { delaysMs: [5, 5, 5], onRetry: (_failure, retry, retries, delayMs) => said.push(`${retry}/${retries} after ${delayMs}`) });
    expect(result).toBe('read');
    expect(calls).toBe(3);
    expect(said).toEqual(['1/3 after 5', '2/3 after 5']);
  });

  it('throws the last failure once the waits are used up', async () => {
    let calls = 0;
    await expect(retryingTransient(async () => { calls++; throw new NetworkError(`down ${calls}`); }, { delaysMs: [1, 1] })).rejects.toThrow('down 3');
    expect(calls).toBe(3);
  });

  it('throws any other failure at once', async () => {
    let calls = 0;
    await expect(retryingTransient(async () => { calls++; throw new Error('bad tag'); }, { delaysMs: [1] })).rejects.toThrow('bad tag');
    expect(calls).toBe(1);
  });

  it('stops waiting with CancelledError when the call is cancelled', async () => {
    const controller = new AbortController();
    const read = retryingTransient(async () => { throw new NetworkError('down'); }, { delaysMs: [60_000], signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toBeInstanceOf(CancelledError);
  });
});
