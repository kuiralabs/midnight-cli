// The runner localnet's Docker commands go through (2F, S7): asynchronous,
// and it kills the program when the call is cancelled. Checked on real
// processes (this Node, running a short script), never on Docker.

import { describe, expect, it } from 'vitest';
import { CancelledError } from '../lib/errors.ts';
import { execProgram, ProgramFailedError, ProgramTimedOutError } from '../lib/exec-program.ts';

/** Whether a process with this id is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const node = process.execPath;

describe('execProgram', () => {
  it('returns what the program printed on stdout', async () => {
    const out = await execProgram(node, ['-e', 'process.stdout.write("hello")'], { signal: new AbortController().signal });
    expect(out).toBe('hello');
  });

  it('kills the program when the call is cancelled, and fails with CancelledError', async () => {
    const call = new AbortController();
    let pid = 0;
    const run = execProgram(node, ['-e', 'process.stderr.write(String(process.pid)); setTimeout(() => {}, 60_000)'], {
      signal: call.signal,
      onStderr: (text) => { pid = Number(text); call.abort(); },
    });

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  });

  it('kills outright a program that ignores being told to stop, so the call still ends', async () => {
    const call = new AbortController();
    let pid = 0;
    const run = execProgram(node, ['-e', 'process.on("SIGTERM", () => {}); process.stderr.write(String(process.pid)); setInterval(() => {}, 1_000)'], {
      signal: call.signal,
      onStderr: (text) => { pid = Number(text); call.abort(); },
    });

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  }, 10_000);

  it('starts nothing for a call already cancelled', async () => {
    const call = new AbortController();
    call.abort();
    await expect(execProgram(node, ['-e', 'process.exit(0)'], { signal: call.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it('fails with the program\'s stderr and exit code when it exits non-zero', async () => {
    const err = await execProgram(node, ['-e', 'process.stderr.write("is already in use by container"); process.exit(3)'], { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProgramFailedError);
    expect((err as ProgramFailedError).exitCode).toBe(3);
    expect((err as Error).message).toContain('is already in use by container');
  });

  it('passes each chunk of stderr on as it comes', async () => {
    const seen: string[] = [];
    await execProgram(node, ['-e', 'process.stderr.write("Container node Started\\n")'], { signal: new AbortController().signal, onStderr: (text) => seen.push(text) });
    expect(seen.join('')).toBe('Container node Started\n');
  });

  it('kills a program that runs past its time limit', async () => {
    await expect(execProgram(node, ['-e', 'setTimeout(() => {}, 60_000)'], { signal: new AbortController().signal, timeoutMs: 200 }))
      .rejects.toBeInstanceOf(ProgramTimedOutError);
  });
});
