// Reading a secret or a file of arguments whole, from a path or the standard
// input, the way a shell hands them over to keep them off disk and out of
// argv: a pipe (`echo … | mn …`), a FIFO, or a process substitution
// (`--args-file <(…)`, which names /dev/fd/N).
//
// fs.readFileSync on such a descriptor fails with EAGAIN when the pipe is in
// non-blocking mode (Node's own stdin handling, or the writer, can leave it
// so) and its writer hasn't written yet. This reads it as a blocking read
// would: it waits for data until the writer closes its end.

import { closeSync, openSync, readSync } from 'node:fs';

const CHUNK_BYTES = 64 * 1024;
const RETRY_WAIT_MS = 5;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** Waits synchronously, without spinning the CPU. */
function pause(ms: number): void {
  Atomics.wait(waitCell, 0, 0, ms);
}

/** Reads an open descriptor to its end, waiting while a non-blocking pipe has nothing yet. */
export function readDescriptorWhole(fd: number): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(CHUNK_BYTES);
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buffer, 0, buffer.length, null);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'EAGAIN') {
        pause(RETRY_WAIT_MS);
        continue;
      }
      // A closed terminal or pipe reads as its end.
      if ((err as { code?: unknown }).code === 'EOF') break;
      throw err;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The whole text at `path`: a regular file, a FIFO or a process
 * substitution's /dev/fd/N. Throws what opening or reading throws (its `code`
 * says why), never EAGAIN.
 */
export function readInputFile(path: string): string {
  const fd = openSync(path, 'r');
  try {
    return readDescriptorWhole(fd);
  } finally {
    closeSync(fd);
  }
}

/** This process's whole standard input. */
export function readProcessStandardInput(): string {
  return readDescriptorWhole(0);
}
