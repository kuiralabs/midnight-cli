import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  loadWalletCache,
  saveWalletCache,
  clearWalletCache,
  getCachePath,
} from '@kuiralabs/midnight-cli-core/lib/wallet-cache';
import { CACHE_VERSION } from '@kuiralabs/midnight-cli-core/lib/constants';

const TEST_ADDRESS = 'mn_addr_preprod1mp06mtx1234567890abcdef';
const TEST_NETWORK = 'preprod';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `wallet-cache-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('wallet-cache', () => {
  // The state root the functions are given, and the cache folder under it.
  let root: string;
  let cacheDir: string;

  beforeEach(() => {
    root = makeTmpDir();
    cacheDir = join(root, 'cache');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('getCachePath', () => {
    it('returns path under the state root\'s cache/network/prefix.json', () => {
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      expect(path).toBe(join(cacheDir, TEST_NETWORK, `${TEST_ADDRESS.slice(0, 20)}.json`));
    });
  });

  describe('round-trip: save → load', () => {
    it('returns the same wallet data after save and load', async () => {
      const walletData = {
        shielded: '{"shielded":"state-data-1"}',
        unshielded: '{"unshielded":"state-data-2"}',
        dust: '{"dust":"state-data-3"}',
      };

      const fakeFacade = {
        shielded: { serializeState: async () => walletData.shielded },
        unshielded: { serializeState: async () => walletData.unshielded },
        dust: { serializeState: async () => walletData.dust },
      };

      await saveWalletCache(TEST_ADDRESS, TEST_NETWORK, fakeFacade, root);
      const loaded = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);

      expect(loaded).not.toBeNull();
      expect(loaded!.shielded).toBe(walletData.shielded);
      expect(loaded!.unshielded).toBe(walletData.unshielded);
      expect(loaded!.dust).toBe(walletData.dust);
    });

    it('save creates the directory structure', async () => {
      const fakeFacade = {
        shielded: { serializeState: async () => 'a' },
        unshielded: { serializeState: async () => 'b' },
        dust: { serializeState: async () => 'c' },
      };

      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      expect(existsSync(path)).toBe(false);

      await saveWalletCache(TEST_ADDRESS, TEST_NETWORK, fakeFacade, root);
      expect(existsSync(path)).toBe(true);
    });

    it('saved file contains correct metadata', async () => {
      const fakeFacade = {
        shielded: { serializeState: async () => 'shielded-data' },
        unshielded: { serializeState: async () => 'unshielded-data' },
        dust: { serializeState: async () => 'dust-data' },
      };

      await saveWalletCache(TEST_ADDRESS, TEST_NETWORK, fakeFacade, root);

      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      expect(raw.version).toBe(CACHE_VERSION);
      expect(raw.network).toBe(TEST_NETWORK);
      expect(raw.address).toBe(TEST_ADDRESS);
      expect(typeof raw.timestamp).toBe('string');
    });
  });

  describe('loadWalletCache — error cases', () => {
    it('returns null when cache file does not exist', () => {
      const result = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(result).toBeNull();
    });

    it('returns null when cache file is corrupted JSON', () => {
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      mkdirSync(join(cacheDir, TEST_NETWORK), { recursive: true });
      writeFileSync(path, 'not valid json{{{');

      const result = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(result).toBeNull();
    });

    it('returns null when version mismatches', () => {
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      mkdirSync(join(cacheDir, TEST_NETWORK), { recursive: true });
      writeFileSync(path, JSON.stringify({
        version: CACHE_VERSION + 1,
        network: TEST_NETWORK,
        address: TEST_ADDRESS,
        timestamp: new Date().toISOString(),
        wallets: { shielded: 'a', unshielded: 'b', dust: 'c' },
      }));

      const result = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(result).toBeNull();
    });

    it('returns null when network mismatches', () => {
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      mkdirSync(join(cacheDir, TEST_NETWORK), { recursive: true });
      writeFileSync(path, JSON.stringify({
        version: CACHE_VERSION,
        network: 'undeployed',
        address: TEST_ADDRESS,
        timestamp: new Date().toISOString(),
        wallets: { shielded: 'a', unshielded: 'b', dust: 'c' },
      }));

      const result = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(result).toBeNull();
    });

    it('returns null when address mismatches', () => {
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      mkdirSync(join(cacheDir, TEST_NETWORK), { recursive: true });
      writeFileSync(path, JSON.stringify({
        version: CACHE_VERSION,
        network: TEST_NETWORK,
        address: 'mn_addr_preprod1different_address',
        timestamp: new Date().toISOString(),
        wallets: { shielded: 'a', unshielded: 'b', dust: 'c' },
      }));

      const result = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(result).toBeNull();
    });

    it('returns null when wallets structure is missing fields', () => {
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      mkdirSync(join(cacheDir, TEST_NETWORK), { recursive: true });
      writeFileSync(path, JSON.stringify({
        version: CACHE_VERSION,
        network: TEST_NETWORK,
        address: TEST_ADDRESS,
        timestamp: new Date().toISOString(),
        wallets: { shielded: 'a' },
      }));

      const result = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(result).toBeNull();
    });

    it('returns null when wallets field is null', () => {
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      mkdirSync(join(cacheDir, TEST_NETWORK), { recursive: true });
      writeFileSync(path, JSON.stringify({
        version: CACHE_VERSION,
        network: TEST_NETWORK,
        address: TEST_ADDRESS,
        timestamp: new Date().toISOString(),
        wallets: null,
      }));

      const result = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(result).toBeNull();
    });
  });

  describe('clearWalletCache', () => {
    it('deletes a specific cache file', async () => {
      const fakeFacade = {
        shielded: { serializeState: async () => 'a' },
        unshielded: { serializeState: async () => 'b' },
        dust: { serializeState: async () => 'c' },
      };

      await saveWalletCache(TEST_ADDRESS, TEST_NETWORK, fakeFacade, root);
      const path = getCachePath(TEST_ADDRESS, TEST_NETWORK, root);
      expect(existsSync(path)).toBe(true);

      clearWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(existsSync(path)).toBe(false);
    });

    it('does not throw when cache file does not exist', () => {
      expect(() => clearWalletCache(TEST_ADDRESS, TEST_NETWORK, root)).not.toThrow();
    });

    it('deletes all caches for a network', async () => {
      const fakeFacade = {
        shielded: { serializeState: async () => 'a' },
        unshielded: { serializeState: async () => 'b' },
        dust: { serializeState: async () => 'c' },
      };

      const addr2 = 'mn_addr_preprod1other_address_here';
      await saveWalletCache(TEST_ADDRESS, TEST_NETWORK, fakeFacade, root);
      await saveWalletCache(addr2, TEST_NETWORK, fakeFacade, root);

      clearWalletCache(undefined, TEST_NETWORK, root);
      expect(existsSync(getCachePath(TEST_ADDRESS, TEST_NETWORK, root))).toBe(false);
      expect(existsSync(getCachePath(addr2, TEST_NETWORK, root))).toBe(false);
    });
  });

  describe('atomic write safety', () => {
    it('overwrites existing cache cleanly', async () => {
      const facade1 = {
        shielded: { serializeState: async () => 'old-shielded' },
        unshielded: { serializeState: async () => 'old-unshielded' },
        dust: { serializeState: async () => 'old-dust' },
      };
      const facade2 = {
        shielded: { serializeState: async () => 'new-shielded' },
        unshielded: { serializeState: async () => 'new-unshielded' },
        dust: { serializeState: async () => 'new-dust' },
      };

      await saveWalletCache(TEST_ADDRESS, TEST_NETWORK, facade1, root);
      await saveWalletCache(TEST_ADDRESS, TEST_NETWORK, facade2, root);

      const loaded = loadWalletCache(TEST_ADDRESS, TEST_NETWORK, root);
      expect(loaded!.shielded).toBe('new-shielded');
      expect(loaded!.unshielded).toBe('new-unshielded');
      expect(loaded!.dust).toBe('new-dust');
    });
  });
});
