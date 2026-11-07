// A reader that stops reading early (`mn ... | head -1`, `| grep -q`, `| true`)
// closes the pipe, and the next write to it fails with EPIPE. Node raises that
// as an 'error' event on the stream, which with no listener crashes the process
// with a stack trace and exit 1.
//
// mn treats a closed reader as the reader's choice, not a failure: what is
// written after it is dropped and the command finishes as it would have, exit
// code included (0 on success). Not the shell's SIGPIPE convention (141): mn's
// exit codes are 0-7, and a write command (a transfer piped to `head`) is
// better finished than cut off between submitting and its receipt.

/** Errors a write to a reader that has gone away fails with: the pipe's EPIPE, and the closed stream's own refusal of the writes after it. */
const CLOSED_READER_CODES: readonly string[] = ['EPIPE', 'ERR_STREAM_DESTROYED'];

/** Whether `err` is a write to a reader that has gone away. */
export function isClosedReaderError(err: unknown): boolean {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CLOSED_READER_CODES.includes(code);
}

/**
 * Lets the streams' readers go away: an error from one of them that is a
 * closed reader is dropped; any other is thrown, as Node does without a listener.
 */
export function ignoreClosedReaders(streams: readonly NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    stream.on('error', (err) => {
      if (isClosedReaderError(err)) return;
      throw err;
    });
  }
}
