// mn cache clear names its network without resolving endpoints, so several
// local stacks running (core's local stack detection refuses to pick one)
// never stop it.

import { describe, expect, it } from 'vitest';

describe('mn cache clear with several local stacks', () => {
  it('needs only the network name, so it never runs detection', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../commands/cache.ts', import.meta.url), 'utf-8');
    // Full resolution would detect local stacks and refuse when several run,
    // yet cache takes no endpoint flags to settle it.
    expect(src).toContain('resolveNetworkName(');
    expect(src).not.toMatch(/\bresolveNetwork\(/);
  });
});
