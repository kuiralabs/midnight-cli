// The engine's coin picking still works after garbage collection: a coin
// secret key held on its own is cleared by the ledger once the keys it came
// from are collected, which broke a spend rebuilt after a wait for Dust ("Coin
// secret key was cleared"). Run in a child process with --expose-gc, so the
// collection really happens between the picks.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Tests the coin picking of the engine whose shielded-wallet module is at `source` (an absolute path). */
export function coinPickingSurvivesCollection(engine: string, source: string): void {
  describe(`coin picking (${engine} engine) after garbage collection`, () => {
    it("computes the same nullifier before and after the keys could be collected, and picks around an open offer's coin", () => {
      const script = `
        const { shieldedCoinPicking, shieldedNullifier } = await import(${JSON.stringify(source)});
        const seed = new Uint8Array(32).fill(9);
        const coin = (nonce, value) => ({ type: '00'.repeat(31) + '01', nonce, value, mt_index: 0n });
        const held = coin('11'.repeat(32), 10n), free = coin('22'.repeat(32), 10n);
        const before = shieldedNullifier(seed, held);
        const offer = { id: 'f8'.repeat(32), nullifiers: [before], terms: {}, madeAt: new Date(0), expiresAt: new Date(0) };
        const picking = shieldedCoinPicking(seed, () => [offer]);
        const first = picking.pick([held, free], held.type, 10n).nonce;
        for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); }
        const second = picking.pick([held, free], held.type, 10n).nonce;
        console.log(JSON.stringify({ same: shieldedNullifier(seed, held) === before, first, second }));
      `;
      const run = spawnSync(process.execPath, ['--expose-gc', '--conditions=midnight-cli-source', '--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
      expect(run.stderr).toBe('');
      expect(JSON.parse(run.stdout.trim())).toEqual({ same: true, first: '22'.repeat(32), second: '22'.repeat(32) });
    });
  });
}
