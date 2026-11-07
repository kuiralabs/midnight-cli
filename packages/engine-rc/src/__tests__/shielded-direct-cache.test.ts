import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ledger from '@midnightntwrk/ledger-v9';
import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import { shieldedCoinPublicKeyHexFromSeed, loadShieldedCache, saveShieldedCache } from '../shielded-direct-cache.ts';
import { emptyShieldedLedgerState, type ShieldedLedgerState } from '../shielded-ledger-state.ts';
import { clearShieldedDirectCache } from '@kuiralabs/midnight-cli-core';
import { getShieldedCachePath } from '@kuiralabs/midnight-cli-core/engine';

const PUBKEY = 'aabbccddeeff00112233445566778899aabbccddeeff001122334455667788ff';
const OTHER_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';

function freshState(): ShieldedLedgerState {
  return emptyShieldedLedgerState(9);
}

describe('shieldedCoinPublicKeyHexFromSeed', () => {
  it('is deterministic and seed-dependent', () => {
    const a = shieldedCoinPublicKeyHexFromSeed(Buffer.from('00'.repeat(31) + '01', 'hex'));
    const a2 = shieldedCoinPublicKeyHexFromSeed(Buffer.from('00'.repeat(31) + '01', 'hex'));
    const b = shieldedCoinPublicKeyHexFromSeed(Buffer.from('00'.repeat(31) + '02', 'hex'));
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });
});

describe('shielded-direct cache round-trip', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-shielded-cache-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('saves and loads state + cursor', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 42, dir);
    const loaded = loadShieldedCache('undeployed', PUBKEY, dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastAppliedEventId).toBe(42);
    expect(loaded!.state.ledgerVersion).toBe(9);
    expect(loaded!.state.state).toBeInstanceOf(ledger.ZswapLocalState);
  });

  it('round-trips a ledger-8 state as ledger 8 (a forked chain read short of its fork)', () => {
    saveShieldedCache('preview', PUBKEY, emptyShieldedLedgerState(8), 7, dir);
    const loaded = loadShieldedCache('preview', PUBKEY, dir)!;
    expect(loaded.state.ledgerVersion).toBe(8);
    expect(loaded.state.state).toBeInstanceOf(ledgerV8.ZswapLocalState);
    expect(loaded.lastAppliedEventId).toBe(7);
  });

  it('records the state\'s ledger in the entry: the two ledgers\' bytes are the same codec', () => {
    saveShieldedCache('preview', PUBKEY, emptyShieldedLedgerState(8), 7, dir);
    const raw = JSON.parse(readFileSync(getShieldedCachePath('preview', PUBKEY, dir), 'utf-8'));
    expect(raw.ledgerVersion).toBe(8);
    expect(raw.zswapState).toBe(Buffer.from(emptyShieldedLedgerState(9).state.serialize()).toString('hex'));
  });

  it('rejects an entry with no ledger, or one it does not read', () => {
    saveShieldedCache('preview', PUBKEY, freshState(), 1, dir);
    const path = getShieldedCachePath('preview', PUBKEY, dir);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    for (const ledgerVersion of [undefined, 7, '9']) {
      writeFileSync(path, JSON.stringify({ ...raw, ledgerVersion }));
      expect(loadShieldedCache('preview', PUBKEY, dir), String(ledgerVersion)).toBeNull();
    }
  });

  it('returns null when nothing is cached', () => {
    expect(loadShieldedCache('undeployed', PUBKEY, dir)).toBeNull();
  });

  it('rejects a pubkey mismatch', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir);
    expect(loadShieldedCache('undeployed', OTHER_PUBKEY, dir)).toBeNull();
  });

  it('rejects a network mismatch', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir);
    expect(loadShieldedCache('preprod', PUBKEY, dir)).toBeNull();
  });

  it('rejects a version mismatch', () => {
    const path = getShieldedCachePath('undeployed', PUBKEY, dir);
    mkdirSync(join(dir, 'cache', 'undeployed'), { recursive: true });
    const raw = { version: 999, network: 'undeployed', coinPublicKeyHex: PUBKEY, lastAppliedEventId: 1, timestamp: '', zswapState: Buffer.from(freshState().state.serialize()).toString('hex'), ledgerVersion: 9 };
    writeFileSync(path, JSON.stringify(raw));
    expect(loadShieldedCache('undeployed', PUBKEY, dir)).toBeNull();
  });

  it('rejects a cache written by ledger-8 mn (v1), which shares a dev genesis hash with ledger-9 chains', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir);
    const path = getShieldedCachePath('undeployed', PUBKEY, dir);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(loadShieldedCache('undeployed', PUBKEY, dir)).not.toBeNull(); // valid as written
    raw.version = 1;
    writeFileSync(path, JSON.stringify(raw));
    expect(loadShieldedCache('undeployed', PUBKEY, dir)).toBeNull();
  });

  it('rejects a cache written before entries named their ledger (v2): it is re-synced once', () => {
    saveShieldedCache('preview', PUBKEY, freshState(), 1, dir);
    const path = getShieldedCachePath('preview', PUBKEY, dir);
    const { ledgerVersion: _ledger, ...v2 } = JSON.parse(readFileSync(path, 'utf-8'));
    writeFileSync(path, JSON.stringify({ ...v2, version: 2 }));
    expect(loadShieldedCache('preview', PUBKEY, dir)).toBeNull();
  });
});

describe('chain-reset invalidation', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-shielded-cache-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('discards a cache from a different chain', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir, 'chain-A');
    expect(loadShieldedCache('undeployed', PUBKEY, dir, 'chain-B')).toBeNull();
  });

  it('keeps a cache from the same chain', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir, 'chain-A');
    expect(loadShieldedCache('undeployed', PUBKEY, dir, 'chain-A')).not.toBeNull();
  });

  it('keeps a cache when no chainId is expected (back-compat)', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir, 'chain-A');
    expect(loadShieldedCache('undeployed', PUBKEY, dir)).not.toBeNull();
  });
});

describe('clearShieldedDirectCache', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-shielded-cache-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('clears a single (network, pubkey) entry', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir);
    saveShieldedCache('undeployed', OTHER_PUBKEY, freshState(), 1, dir);
    clearShieldedDirectCache('undeployed', PUBKEY, dir);
    expect(existsSync(getShieldedCachePath('undeployed', PUBKEY, dir))).toBe(false);
    expect(existsSync(getShieldedCachePath('undeployed', OTHER_PUBKEY, dir))).toBe(true);
  });

  it('clears a whole network', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir);
    saveShieldedCache('undeployed', OTHER_PUBKEY, freshState(), 1, dir);
    saveShieldedCache('preprod', PUBKEY, freshState(), 1, dir);
    clearShieldedDirectCache('undeployed', undefined, dir);
    expect(existsSync(getShieldedCachePath('undeployed', PUBKEY, dir))).toBe(false);
    expect(existsSync(getShieldedCachePath('undeployed', OTHER_PUBKEY, dir))).toBe(false);
    expect(existsSync(getShieldedCachePath('preprod', PUBKEY, dir))).toBe(true);
  });

  it('clears across all networks', () => {
    saveShieldedCache('undeployed', PUBKEY, freshState(), 1, dir);
    saveShieldedCache('preprod', PUBKEY, freshState(), 1, dir);
    clearShieldedDirectCache(undefined, undefined, dir);
    expect(existsSync(getShieldedCachePath('undeployed', PUBKEY, dir))).toBe(false);
    expect(existsSync(getShieldedCachePath('preprod', PUBKEY, dir))).toBe(false);
  });
});
