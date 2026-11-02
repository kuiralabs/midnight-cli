// What `localnet down` asks the owners to clear once the local chain is gone:
// the wallet's caches for that chain (and no other chain's), and the
// contract private-state store in the dApp's folder. Temporary folders only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearChainCaches } from '../lib/chain-caches.ts';
import { getCachePath } from '../lib/wallet-cache.ts';
import { getDustCachePath } from '../lib/reader-cache-files.ts';
import { getShieldedCachePath } from '../lib/reader-cache-files.ts';
import { PRIVATE_STATE_DATABASE, clearDappPrivateState } from '../lib/contract/private-state.ts';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-chain-reset-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const touch = (file: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  return file;
};

describe('clearChainCaches', () => {
  it("clears the wallet, Dust, shielded and native-sidecar caches of one network and leaves another network's", () => {
    const cache = path.join(dir, 'cache');
    const wallet = touch(getCachePath('mn_addr_undeployed1abcdefghijklmnop', 'undeployed', cache));
    const dust = touch(getDustCachePath('undeployed', 'ab'.repeat(32), cache));
    const shielded = touch(getShieldedCachePath('undeployed', 'cd'.repeat(32), cache));
    const native = touch(path.join(cache, 'undeployed', `dust-native-${'ab'.repeat(10)}.json`));
    const otherWallet = touch(getCachePath('mn_addr_preview1abcdefghijklmnop', 'preview', cache));
    const otherDust = touch(getDustCachePath('preview', 'ab'.repeat(32), cache));

    clearChainCaches('undeployed', cache);

    expect([wallet, dust, shielded, native].map((f) => fs.existsSync(f))).toEqual([false, false, false, false]);
    expect([fs.existsSync(otherWallet), fs.existsSync(otherDust)]).toEqual([true, true]);
  });
});

describe('clearDappPrivateState', () => {
  it("removes the dApp's private-state store, and says so", () => {
    touch(path.join(dir, PRIVATE_STATE_DATABASE, 'CURRENT'));
    expect(clearDappPrivateState(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, PRIVATE_STATE_DATABASE))).toBe(false);
  });

  it('says false when the folder has no store', () => {
    expect(clearDappPrivateState(dir)).toBe(false);
  });
});
