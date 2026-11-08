// A contract state the ledger can't decode. midnight-js reports it as its
// SerializedStateDecodeFailedError, whose message only says the bytes are
// corrupt or the decoder is the wrong one; what the ledger said (for example
// "Node::Extension path must be of length 255 when having another
// Node::Extension child") is on its `cause`.
//
// stateDecodeFailureOf goes into the generated contract scripts' prelude with
// `.toString()`, so it imports nothing and refers to nothing outside itself.

/**
 * What the ledger said when it couldn't decode a contract state: the cause of
 * the SerializedStateDecodeFailedError among `err` and its causes (its own
 * message when it has no cause); undefined for any other failure.
 */
export function stateDecodeFailureOf(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (let current: unknown = err; current !== null && typeof current === 'object' && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    if ((current as { name?: unknown }).name !== 'SerializedStateDecodeFailedError') continue;
    const cause = (current as { cause?: unknown }).cause;
    const said = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : (current as { message?: unknown }).message;
    return String(said);
  }
  return undefined;
}
