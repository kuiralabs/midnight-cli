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

/**
 * What `work` gives, unless `signal` aborts first (or already has): then
 * CancelledError at once. For work that takes no signal of its own; it still
 * runs to its end, but nobody waits for it.
 */
export function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new CancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}
