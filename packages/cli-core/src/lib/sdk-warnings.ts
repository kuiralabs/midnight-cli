// The SDK's transient errors (Wallet.Sync: Internal Server Error, …) surface
// as unhandled rejections and console.error calls, which the shell filters
// (sdk-noise.ts) while some call listens. A call that runs the SDK listens
// through its context (ctx.sdkWarnings) for its length, to show them as
// progress ("…, retrying") or only to keep them off the terminal; it never
// touches the process itself.
//
// Each call's warnings are its own. The host keeps one router; each
// call it runs is opened on it, and the shell tags the noise raised while a
// call runs with that call's identity. A warning with an identity goes to
// that call's newest listener, and to no other call. One without (raised
// where the identity didn't carry) goes to the one call listening; with
// several listening it goes to none, rather than to the wrong one. Either way
// it stays off the terminal while any call listens.

/** Where a transient SDK warning goes: its tag (Wallet.Sync) and message. */
export type SdkWarningListener = (tag: string, message: string) => void;

/** Where one call's SDK warnings go while it runs the SDK (its context's sdkWarnings). */
export interface CallSdkWarnings {
  /** Sends them to `listener` until the returned function is called; with none, they are only kept off the terminal. */
  listen(listener: SdkWarningListener | undefined): () => void;
}

/** A call opened on a router: the identity its warnings carry, and where they go. */
export interface SdkWarningCall {
  readonly id: number;
  readonly warnings: CallSdkWarnings;
}

/** The host's router of the SDK's warnings to the calls they came from. */
export interface SdkWarningRouter {
  /** Opens a call: its identity, and its warnings to listen to. */
  openCall(): SdkWarningCall;
  /** True while some call listens: the shell's filters act only then. */
  isListening(): boolean;
  /**
   * Hands one warning on: with `callId`, to that call's newest listener, or
   * to none when that call isn't listening; without one, to the one call
   * listening, or to none when several are.
   */
  route(callId: number | undefined, tag: string, message: string): void;
}

/** A router with no calls open yet. */
export function createSdkWarningRouter(): SdkWarningRouter {
  // Each listening call's listeners, oldest first; a call that stops listening leaves.
  const listening = new Map<number, SdkWarningListener[]>();
  let lastId = 0;
  return {
    openCall() {
      lastId += 1;
      const id = lastId;
      return {
        id,
        warnings: {
          listen(listener) {
            const own = listener ?? (() => {});
            listening.set(id, [...(listening.get(id) ?? []), own]);
            return () => {
              const listeners = listening.get(id) ?? [];
              const at = listeners.lastIndexOf(own);
              if (at < 0) return;
              const left = listeners.filter((_, i) => i !== at);
              if (left.length === 0) listening.delete(id);
              else listening.set(id, left);
            };
          },
        },
      };
    },
    isListening: () => listening.size > 0,
    route(callId, tag, message) {
      const listeners = callId !== undefined ? listening.get(callId) : listening.size === 1 ? [...listening.values()][0] : undefined;
      listeners?.at(-1)?.(tag, message);
    },
  };
}

/** How a runner gives each call it runs its SDK warnings. The host's knows which call raised one (sdk-noise.ts). */
export interface SdkWarningCalls {
  /** Runs one call, its warnings given to `run`. */
  run<T>(run: (warnings: CallSdkWarnings) => Promise<T>): Promise<T>;
}

/**
 * Calls opened on `router` whose noise carries no identity: a runner with no
 * host's filters (a test, a program's own runner) gives its calls these.
 */
export function sdkWarningCallsOn(router: SdkWarningRouter): SdkWarningCalls {
  return { run: (run) => run(router.openCall().warnings) };
}

/**
 * Runs `work` with a call's SDK warnings: `given`, the caller's, or else those
 * of a call of its own on `calls` (its host's).
 */
export function withCallSdkWarnings<T>(calls: SdkWarningCalls, given: CallSdkWarnings | undefined, work: (warnings: CallSdkWarnings) => Promise<T>): Promise<T> {
  return given === undefined ? calls.run(work) : work(given);
}

/** What a transient warning says when the SDK gives no message. */
const TRANSIENT_FALLBACK_MESSAGE = 'transient error';
/** The tag a bare-string Wallet.* trace is reported under. */
const STRING_TRACE_TAG = 'Wallet.Sync';

/**
 * The tag and message of a transient, retried SDK failure, as a rejection or a
 * console.error argument carries it (a Wallet.* error, or its string trace);
 * null for anything else.
 */
export function sdkTransientWarning(value: unknown): { tag: string; message: string } | null {
  if (typeof value === 'string') return value.startsWith('Wallet.') ? { tag: STRING_TRACE_TAG, message: TRANSIENT_FALLBACK_MESSAGE } : null;
  if (typeof value !== 'object' || value === null || !('_tag' in value)) return null;
  const { _tag: tag, message } = value as { _tag: unknown; message?: unknown };
  if (typeof tag !== 'string' || !tag.startsWith('Wallet.')) return null;
  return { tag, message: typeof message === 'string' ? message : TRANSIENT_FALLBACK_MESSAGE };
}
