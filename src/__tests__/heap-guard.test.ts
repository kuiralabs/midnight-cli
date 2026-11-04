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
