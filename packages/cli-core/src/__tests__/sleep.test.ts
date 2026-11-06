import { describe, expect, it } from 'vitest';
import { untilCancelled } from '../lib/sleep.ts';
import { CancelledError } from '../lib/errors.ts';

describe('untilCancelled', () => {
  it('gives what the work gives, and its error', async () => {
    await expect(untilCancelled(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
    await expect(untilCancelled(Promise.reject(new Error('no')), new AbortController().signal)).rejects.toThrow('no');
  });

  it('stops waiting with CancelledError when the signal aborts before the work ends', async () => {
    const controller = new AbortController();
    const waiting = untilCancelled(new Promise<never>(() => {}), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
  });

  it('refuses at once when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(untilCancelled(Promise.resolve(1), controller.signal)).rejects.toBeInstanceOf(CancelledError);
  });

  it('waits for the work when there is no signal', async () => {
    await expect(untilCancelled(Promise.resolve('done'))).resolves.toBe('done');
  });
});
