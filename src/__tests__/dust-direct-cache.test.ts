// Unit tests for the dust-direct cache (load/save/invalidate).
// Exercises the file-based persistence layer; no network involved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ledger from '@midnightntwrk/ledger-v9';

import { loadDustCache, saveDustCache, dustPublicKeyHex } from '@kuiralabs/midnight-engine-rc/dust-direct-cache';
import { clearDustDirectCache, getDustCachePath } from '@kuiralabs/midnight-cli-core/lib/reader-cache-files';

const STATE_ROOT = path.join(os.tmpdir(), `midnight-dust-cache-test-${process.pid}-${Date.now()}`);
const NETWORK = 'undeployed';
const SEED_HEX = '0000000000000000000000000000000000000000000000000000000000000042';

// Build a real DustLocalState so we exercise the actual serialize/deserialize path.
function freshDustState(): ledger.DustLocalState {
  const params = new ledger.DustParameters(5_000_000_000n, 8_267n, 3n * 60n * 60n);
  return new ledger.DustLocalState(params);
}

function testDustPubkeyHex(): string {
  const seed = Buffer.from(SEED_HEX, 'hex');
  // Mirror what the CLI does — derive dust key from seed via the HD wallet.
  // For a test-only pubkey we just call fromSeed on the raw seed bytes; the
  // cache only cares that it's a stable bigint identifier.
  const sk = ledger.DustSecretKey.fromSeed(seed.subarray(0, 32));
  return dustPublicKeyHex(sk.publicKey);
}

beforeEach(() => {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

describe('dustPublicKeyHex', () => {
  it('pads to 64 chars', () => {
    expect(dustPublicKeyHex(1n)).toHaveLength(64);
    expect(dustPublicKeyHex(1n)).toBe('0'.repeat(63) + '1');
  });

  it('is stable for the same key', () => {
    const a = testDustPubkeyHex();
    const b = testDustPubkeyHex();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('dust-direct cache: round-trip', () => {
  it('saves and loads a serialized state', () => {
    const pubkey = testDustPubkeyHex();
    const state = freshDustState();

    saveDustCache(NETWORK, pubkey, state, 42, STATE_ROOT);
    const loaded = loadDustCache(NETWORK, pubkey, STATE_ROOT);

    expect(loaded).not.toBeNull();
    expect(loaded!.lastAppliedEventId).toBe(42);
    expect(loaded!.state).toBeInstanceOf(ledger.DustLocalState);
    // Structural check: a fresh state has empty utxos.
    expect(loaded!.state.utxos).toEqual([]);
  });

  it('round-trips the retention data (owned indices + frontier)', () => {
    const pubkey = testDustPubkeyHex();
    const state = freshDustState();
    const retention = { ownedGenerationIndices: [0, 3, 99], generationFrontier: 120 };

    saveDustCache(NETWORK, pubkey, state, 42, STATE_ROOT, undefined, retention);
    const loaded = loadDustCache(NETWORK, pubkey, STATE_ROOT);

    expect(loaded!.retention).toEqual(retention);
  });

  it('defaults to empty retention when none is provided', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, STATE_ROOT);
    const loaded = loadDustCache(NETWORK, pubkey, STATE_ROOT);
    expect(loaded!.retention).toEqual({ ownedGenerationIndices: [], generationFrontier: 0 });
  });

  it('writes file with 0o600 permissions', () => {
    const pubkey = testDustPubkeyHex();
    const state = freshDustState();
    saveDustCache(NETWORK, pubkey, state, 0, STATE_ROOT);

    const filePath = getDustCachePath(NETWORK, pubkey, STATE_ROOT);
    const stat = fs.statSync(filePath);
    // On macOS/Linux the mode low 9 bits reflect user/group/other rwx.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('dust-direct cache: invalidation', () => {
  it('returns null when the file is missing', () => {
    expect(loadDustCache(NETWORK, testDustPubkeyHex(), STATE_ROOT)).toBeNull();
  });

  it('returns null on version mismatch', () => {
    const pubkey = testDustPubkeyHex();
    const state = freshDustState();
    saveDustCache(NETWORK, pubkey, state, 1, STATE_ROOT);

    // Corrupt: bump version on disk
    const filePath = getDustCachePath(NETWORK, pubkey, STATE_ROOT);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.version = 999;
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(loadDustCache(NETWORK, pubkey, STATE_ROOT)).toBeNull();
  });

  it('invalidates a legacy v1 cache (no retention fields) so it re-syncs', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 5, STATE_ROOT);

    // Rewrite as a pre-collapse v1 file: version 1, retention fields absent.
    const filePath = getDustCachePath(NETWORK, pubkey, STATE_ROOT);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.version = 1;
    delete data.ownedGenerationIndices;
    delete data.generationFrontier;
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(loadDustCache(NETWORK, pubkey, STATE_ROOT)).toBeNull();
  });

  it('invalidates a cache written by ledger-8 mn (v2) so a ledger-9 chain re-syncs', () => {
    // Dev-preset localnets share a genesis hash, so only the version keeps a
    // ledger-8 cache from being replayed onto a ledger-9 chain.
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 5, STATE_ROOT);
    const filePath = getDustCachePath(NETWORK, pubkey, STATE_ROOT);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.version = 2;
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(loadDustCache(NETWORK, pubkey, STATE_ROOT)).toBeNull();
  });

  it('returns null on network mismatch', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, STATE_ROOT);
    expect(loadDustCache('preprod', pubkey, STATE_ROOT)).toBeNull();
  });

  it('returns null on pubkey mismatch', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, STATE_ROOT);
    expect(loadDustCache(NETWORK, 'f'.repeat(64), STATE_ROOT)).toBeNull();
  });

  it('returns null on corrupted JSON', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, STATE_ROOT);
    fs.writeFileSync(getDustCachePath(NETWORK, pubkey, STATE_ROOT), '{not-json');
    expect(loadDustCache(NETWORK, pubkey, STATE_ROOT)).toBeNull();
  });

  it('returns null when dustState is not a hex string', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, STATE_ROOT);
    const filePath = getDustCachePath(NETWORK, pubkey, STATE_ROOT);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.dustState = 'not-hex-zzz';
    fs.writeFileSync(filePath, JSON.stringify(data));
    expect(loadDustCache(NETWORK, pubkey, STATE_ROOT)).toBeNull();
  });
});

describe('dust-direct cache: clearDustDirectCache', () => {
  it('removes a single (network, pubkey) file', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, STATE_ROOT);
    expect(fs.existsSync(getDustCachePath(NETWORK, pubkey, STATE_ROOT))).toBe(true);

    clearDustDirectCache(NETWORK, pubkey, STATE_ROOT);
    expect(fs.existsSync(getDustCachePath(NETWORK, pubkey, STATE_ROOT))).toBe(false);
  });

  it('removes all dust-* files in a network dir, preserving non-dust files', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, STATE_ROOT);
    // Simulate an existing facade cache file that should NOT be touched.
    const networkDir = path.join(STATE_ROOT, 'cache', NETWORK);
    const walletCachePath = path.join(networkDir, 'some-wallet-cache.json');
    fs.writeFileSync(walletCachePath, '{}');

    clearDustDirectCache(NETWORK, undefined, STATE_ROOT);

    expect(fs.existsSync(getDustCachePath(NETWORK, pubkey, STATE_ROOT))).toBe(false);
    expect(fs.existsSync(walletCachePath)).toBe(true);
  });

  it('removes all dust-* files across all networks when called with no args', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache('undeployed', pubkey, freshDustState(), 1, STATE_ROOT);
    saveDustCache('preprod', pubkey, freshDustState(), 2, STATE_ROOT);

    clearDustDirectCache(undefined, undefined, STATE_ROOT);

    expect(fs.existsSync(getDustCachePath('undeployed', pubkey, STATE_ROOT))).toBe(false);
    expect(fs.existsSync(getDustCachePath('preprod', pubkey, STATE_ROOT))).toBe(false);
  });
});
