import { describe, it, expect } from 'vitest';

describe('tieChildLifetime', () => {
  // The bug: the re-exec parent IGNORED signals, so `kill <parent>` orphaned the
  // child (which held the `mn serve` port). It must FORWARD them + kill on exit.
  it('forwards SIGINT/SIGTERM/SIGHUP to the child and force-kills it on parent exit', async () => {
    const { tieChildLifetime } = await import('../lib/heap-guard.ts');
    const killed: string[] = [];
    const child = { kill: (sig?: NodeJS.Signals) => { killed.push(sig ?? 'NONE'); return true; } };
    const handlers: Record<string, () => void> = {};

    tieChildLifetime(child, (event, handler) => { handlers[event] = handler; });

    expect(Object.keys(handlers).sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM', 'exit']);
    handlers.SIGINT(); handlers.SIGTERM(); handlers.SIGHUP();
    expect(killed).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']); // forwarded, not ignored
    handlers.exit();
    expect(killed).toContain('SIGKILL');                     // parent exit takes the child down
  });

  it('swallows a kill that throws (child already gone)', async () => {
    const { tieChildLifetime } = await import('../lib/heap-guard.ts');
    const child = { kill: () => { throw new Error('ESRCH'); } };
    const handlers: Record<string, () => void> = {};
    tieChildLifetime(child, (event, handler) => { handlers[event] = handler; });
    expect(() => handlers.SIGTERM()).not.toThrow();
  });
});

describe('reExecStdio', () => {
  it('passes on the descriptors an argument names by path, at the same number', async () => {
    const { reExecStdio } = await import('../lib/heap-guard.ts');
    expect(reExecStdio(['contract', 'call'])).toEqual(['inherit', 'inherit', 'inherit']);
    expect(reExecStdio(['--args-file', '/dev/fd/5', '--secret-key-file=/proc/self/fd/4'])).toEqual(['inherit', 'inherit', 'inherit', 'ignore', 4, 5]);
    // The standard three are inherited already; a plain file is not a descriptor.
    expect(reExecStdio(['--args-file', '/dev/fd/0', 'args.json'])).toEqual(['inherit', 'inherit', 'inherit']);
  });

  // The bug: `mn contract call --args-file <(echo …)` re-exec'd with only
  // fds 0-2, so the child's /dev/fd/N was not the shell's pipe and the read
  // failed (EAGAIN, or empty text).
  it('lets a re-exec\'d child read a process substitution the parent was given', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mn-reexec-'));
    try {
      const parent = join(dir, 'parent.ts');
      writeFileSync(parent, [
        `import { spawnSync } from 'node:child_process';`,
        `import { reExecStdio } from ${JSON.stringify(new URL('../lib/heap-guard.ts', import.meta.url).pathname)};`,
        `const path = process.argv[2];`,
        `const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', path], { stdio: reExecStdio([path]) });`,
        `process.stdout.write(String(child.status));`,
      ].join('\n'));
      const out = execFileSync('bash', ['-c', `"${process.execPath}" --import tsx "${parent}" <(sleep 0.3; echo '[1,2]')`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      // The child's stdout is inherited from the parent: its text, then the parent's status line.
      expect(out).toBe('[1,2]\n0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
