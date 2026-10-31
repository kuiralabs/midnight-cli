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

/** A rejection or console.error argument the SDK throws for a transient, retried failure. */
export function isSdkTransient(value: unknown): boolean {
  const tag = (value as { _tag?: unknown } | null)?._tag;
  return (typeof tag === 'string' && tag.startsWith('Wallet.')) || (typeof value === 'string' && value.startsWith('Wallet.'));
}
