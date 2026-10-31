// The SDK's transient errors (Wallet.Sync: Internal Server Error, …) surface
// as unhandled rejections and console.error calls, which the shell filters for
// the whole run (sdk-noise.ts). A library that wants to show them as progress
// ("…, retrying") listens here for the length of its call; it never touches
// the process itself. The latest listener gets each warning, as the innermost
// suppression did before.

type SdkWarningListener = (tag: string, message: string) => void;

const listeners: SdkWarningListener[] = [];

/** Sends the SDK's transient warnings to `listener` until the returned function is called. */
export function onSdkWarning(listener: SdkWarningListener | undefined): () => void {
  if (listener === undefined) return () => {};
  listeners.push(listener);
  return () => {
    const at = listeners.lastIndexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

/** Hands one transient SDK warning to the latest listener, if any. */
export function reportSdkWarning(tag: string, message: string): void {
  listeners.at(-1)?.(tag, message);
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
