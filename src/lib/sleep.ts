// Waiting that a call's cancellation cuts short.

import { CancelledError } from './errors.ts';

/** Wait `ms`; reject with CancelledError if `signal` aborts first (or already has). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new CancelledError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new CancelledError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
