// Unit tests for the shared wallet-seed resolver used by `address`, `balance`,
// and `dust export`. Precedence: --seed → MN_SEED → --wallet <name> → active.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs, createHost, settingsFromEnvironment } from '@kuiralabs/midnight-cli-core';
import { parseSeedHex, resolveSeedSource, resolveSeed, seedOf, walletSourceOf } from '../lib/seed-resolver.ts';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { mkdirSync } from 'node:fs';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { type WalletPublic, writeSealedWallet } from '../lib/wallet-config.ts';
import { stateRootIn } from './helpers/state-root-in.ts';
import { testHost } from '../../test-support/test-host.ts';

// The host the tests' calls run in (test-host.ts): settings from the test's environment, nobody to ask, notices dropped, and an engine of its own from the engines the CLI ships.
const host = testHost();

const PASSPHRASE = 'correct horse battery staple';
const ORIGINAL_HOME = process.env.HOME;

const SEED_A = '11'.repeat(32);
const SEED_B = '22'.repeat(32);

let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'mn-seedres-')); delete process.env.MN_SEED; });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); delete process.env.MN_SEED; });

function walletFile(seedHex: string): string {
  const p = join(TMP, 'w.json');
  writeFileSync(p, JSON.stringify({ seed: seedHex, addresses: {}, createdAt: new Date().toISOString() }));
  return p;
}
const argsFor = (extra: string[]) => parseArgs(['balance', ...extra]);

describe('parseSeedHex', () => {
  it('parses a 64-hex string to the exact 32 bytes', () => {
    const b = parseSeedHex('ab'.repeat(32), '--seed');
    expect(b.length).toBe(32);
    expect(b.toString('hex')).toBe('ab'.repeat(32));
  });

  it('parses a 128-hex string to the exact 64 bytes', () => {
    const b = parseSeedHex('cd'.repeat(64), '--seed');
    expect(b.length).toBe(64);
    expect(b.toString('hex')).toBe('cd'.repeat(64));
  });

  it('strips 0x and surrounding whitespace before the length check', () => {
    expect(parseSeedHex(`0x${'ee'.repeat(64)}\n`, '--seed').toString('hex')).toBe('ee'.repeat(64));
  });

  it.each([
    ['empty', ''],
    ['too short', 'aabb'],
    ['between the two sizes', 'ff'.repeat(48)],
    ['too long', 'ff'.repeat(65)],
    ['right length, non-hex', 'zz'.repeat(32)],
  ])('rejects %s with the sizes it does accept', (_name, input) => {
    expect(() => parseSeedHex(input, '--seed')).toThrow(/64 or 128 hex characters/);
  });

  it('names the offending source in the error', () => {
    expect(() => parseSeedHex('aabb', 'MN_SEED')).toThrow(/^MN_SEED /);
  });
});

describe('resolveSeedSource', () => {
  it('reads --seed, with no backing wallet file/config', async () => {
    const r = await resolveSeedSource(argsFor(['--seed', SEED_A]), stateRootIn(TMP), host);
    expect(r.seed.toString('hex')).toBe(SEED_A);
    expect(r.walletPath).toBeNull();
    expect(r.config).toBeNull();
  });

  it('reads MN_SEED when --seed is absent', async () => {
    process.env.MN_SEED = SEED_A;
    const r = await resolveSeedSource(argsFor([]), stateRootIn(TMP), host);
    expect(r.seed.toString('hex')).toBe(SEED_A);
    expect(r.walletPath).toBeNull();
  });

  it('lets --seed win over MN_SEED', async () => {
    process.env.MN_SEED = SEED_B;
    const r = await resolveSeedSource(argsFor(['--seed', SEED_A]), stateRootIn(TMP), host);
    expect(r.seed.toString('hex')).toBe(SEED_A);
  });

  it('strips 0x and trims a trailing newline (MN_SEED from $(cat seed.hex))', async () => {
    process.env.MN_SEED = `0x${SEED_A}\n`;
    const r = await resolveSeedSource(argsFor([]), stateRootIn(TMP), host);
    expect(r.seed.toString('hex')).toBe(SEED_A);
  });

  it('rejects a bad-length --seed', async () => {
    await expect(resolveSeedSource(argsFor(['--seed', 'aabb']), stateRootIn(TMP), host)).rejects.toThrow(/64 or 128 hex characters/);
  });

  it('accepts a 128-hex (64-byte BIP-39) --seed', async () => {
    const seed64 = '33'.repeat(64);
    const r = await resolveSeedSource(argsFor(['--seed', seed64]), stateRootIn(TMP), host);
    expect(r.seed.length).toBe(64);
    expect(r.seed.toString('hex')).toBe(seed64);
  });

  it('rejects in-between lengths (only 32- and 64-byte seeds occur)', async () => {
    await expect(resolveSeedSource(argsFor(['--seed', '44'.repeat(48)]), stateRootIn(TMP), host)).rejects.toThrow(/64 or 128 hex characters/);
  });

  it('names MN_SEED in the error when MN_SEED is the bad source', async () => {
    process.env.MN_SEED = 'zz';
    await expect(resolveSeedSource(argsFor([]), stateRootIn(TMP), host)).rejects.toThrow(/MN_SEED/);
  });

  it('reads a wallet file via --wallet, exposing walletPath + config', async () => {
    const p = walletFile(SEED_B);
    const r = await resolveSeedSource(argsFor(['--wallet', p]), stateRootIn(TMP), host);
    expect(r.seed.toString('hex')).toBe(SEED_B);
    expect(r.walletPath).toBe(p);
    expect(r.config).not.toHaveProperty('seed');
    expect(r.config?.isSealed).toBe(false);
  });

  it('opens a sealed wallet via --wallet with mn\'s passphrase', async () => {
    process.env.HOME = TMP;
    process.env[PASSPHRASE_ENV] = PASSPHRASE;
    try {
      establishPassphrase(stateRootIn(TMP), PASSPHRASE);
      const p = writeSealedWallet(join(TMP, 'sealed.json'), { addresses: {} as WalletPublic['addresses'], createdAt: new Date().toISOString() }, { seed: SEED_B }, PASSPHRASE);
      const r = await resolveSeedSource(argsFor(['--wallet', p]), stateRootIn(TMP), host);
      expect(r.seed.toString('hex')).toBe(SEED_B);
      expect(r.config?.isSealed).toBe(true);
    } finally {
      process.env.HOME = ORIGINAL_HOME;
      delete process.env[PASSPHRASE_ENV];
    }
  });

  it('requireExplicit throws a labeled error naming every source when none is given', async () => {
    // No --seed / MN_SEED / --wallet, and requireExplicit disables the active fallback.
    await expect(resolveSeedSource(argsFor([]), stateRootIn(TMP), host, { requireExplicit: true, label: 'address' }))
      .rejects.toThrow(/address needs a seed source/);
    const msg = await resolveSeedSource(argsFor([]), stateRootIn(TMP), host, { requireExplicit: true, label: 'address' }).then(() => '', (e: Error) => e.message);
    expect(msg).toContain('--seed');
    expect(msg).toContain('MN_SEED');
    expect(msg).toContain('--wallet');
  });

  it('resolveSeed returns just the seed buffer', async () => {
    expect((await resolveSeed(argsFor(['--seed', SEED_A]), stateRootIn(TMP), host)).toString('hex')).toBe(SEED_A);
  });
});

describe('seedOf', () => {
  // A program's host: its own state root, its passphrase given in its settings, no environment read.
  const programHost = (root: string) => createHost({
    paths: { stateRoot: root, home: TMP },
    settings: settingsFromEnvironment({ [PASSPHRASE_ENV]: PASSPHRASE }),
    engineLoader: loadInstalledEngine,
  });

  it('gives a seed the program holds as it is, with no wallet file', async () => {
    const r = await seedOf(programHost(stateRootIn(TMP)), { seed: Buffer.from(SEED_A, 'hex') });
    expect(r).toEqual({ seed: Buffer.from(SEED_A, 'hex'), walletPath: null, config: null });
    expect((await seedOf(programHost(stateRootIn(TMP)), { seed: new Uint8Array(64).fill(7) })).seed.length).toBe(64);
  });

  it.each([0, 16, 33, 65])('refuses a seed of %i bytes as a usage error', async (size) => {
    await expect(seedOf(programHost(stateRootIn(TMP)), { seed: new Uint8Array(size) })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('32 or 64 bytes') });
  });

  it('unlocks a sealed wallet by path through the host\'s passphrase', async () => {
    const root = stateRootIn(TMP);
    establishPassphrase(root, PASSPHRASE);
    const p = writeSealedWallet(join(TMP, 'sealed.json'), { addresses: {} as WalletPublic['addresses'], createdAt: new Date().toISOString() }, { seed: SEED_B }, PASSPHRASE);
    const r = await seedOf(programHost(root), { wallet: p });
    expect(r.seed.toString('hex')).toBe(SEED_B);
    expect(r.walletPath).toBe(p);
    expect(r.config?.isSealed).toBe(true);
  });

  it('finds a wallet by name, and the active one, each under its own host\'s state root', async () => {
    const rootA = join(TMP, 'a');
    const rootB = join(TMP, 'b');
    for (const [root, seed] of [[rootA, SEED_A], [rootB, SEED_B]] as const) {
      mkdirSync(join(root, 'wallets'), { recursive: true });
      writeFileSync(join(root, 'wallets', 'alice.json'), JSON.stringify({ seed, addresses: {}, createdAt: new Date().toISOString() }));
      writeFileSync(join(root, 'config.json'), JSON.stringify({ wallet: 'alice' }));
    }
    expect((await seedOf(programHost(rootA), { wallet: 'alice' })).seed.toString('hex')).toBe(SEED_A);
    expect((await seedOf(programHost(rootB), { wallet: 'alice' })).seed.toString('hex')).toBe(SEED_B);
    expect((await seedOf(programHost(rootB), {})).seed.toString('hex')).toBe(SEED_B);
  });

  it('refuses a wallet that is not there, with WALLET_NOT_FOUND', async () => {
    await expect(seedOf(programHost(stateRootIn(TMP)), { wallet: 'nobody' })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });
});

describe('walletSourceOf', () => {
  it('takes --seed over MN_SEED over --wallet, and the active wallet when none is given', () => {
    expect(walletSourceOf(argsFor(['--seed', SEED_A, '--wallet', 'bob']), { seed: SEED_B })).toEqual({ seed: Buffer.from(SEED_A, 'hex') });
    expect(walletSourceOf(argsFor(['--wallet', 'bob']), { seed: SEED_B })).toEqual({ seed: Buffer.from(SEED_B, 'hex') });
    expect(walletSourceOf(argsFor(['--wallet', 'bob']), { seed: undefined })).toEqual({ wallet: 'bob' });
    expect(walletSourceOf(argsFor([]), { seed: undefined })).toEqual({});
  });
});
