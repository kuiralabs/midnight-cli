import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWalletConfig, matchWalletAddress, unlockWallet, walletAddress, writeSealedWallet, type WalletInfo } from '../lib/wallet-config.ts';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from './helpers/plain-wallet.ts';
import { DIR_MODE, FILE_MODE } from '@kuiralabs/midnight-cli-core/lib/constants';
import { deriveAllAddresses, deriveAllShieldedAddresses } from '@kuiralabs/midnight-engine-rc/derive-address';
import { stateRootIn } from './helpers/state-root-in.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-wallet-test-${process.pid}`);

const VALID_SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const VALID_ADDRESSES = deriveAllAddresses(Buffer.from(VALID_SEED, 'hex'));

const VALID_CONFIG: WalletConfig = {
  seed: VALID_SEED,
  addresses: VALID_ADDRESSES,
  createdAt: '2025-01-01T00:00:00.000Z',
};

const PASSPHRASE = 'correct horse battery staple';
// Unlocking in the test's own home, a plain-text wallet's warning kept out of the output.
const UNLOCK = { root: stateRootIn(TEST_DIR), source: { env: { [PASSPHRASE_ENV]: PASSPHRASE }, prompter: null }, warn: () => {} };

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  establishPassphrase(stateRootIn(TEST_DIR), PASSPHRASE);
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeSealedWallet', () => {
  const PUBLIC = { addresses: VALID_ADDRESSES, createdAt: VALID_CONFIG.createdAt };

  it('creates the file at the specified path, holding the addresses and no seed', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    expect(writeSealedWallet(filePath, PUBLIC, { seed: VALID_SEED }, PASSPHRASE)).toBe(filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.addresses).toEqual(VALID_ADDRESSES);
    expect(parsed.createdAt).toBe(VALID_CONFIG.createdAt);
    expect(parsed.seed).toBeUndefined();
    expect(parsed.mnemonic).toBeUndefined();
  });

  it('creates missing parent directories owner-only, and the file owner-only', () => {
    const filePath = path.join(TEST_DIR, 'secure', 'nested', 'wallet.json');
    writeSealedWallet(filePath, PUBLIC, { seed: VALID_SEED }, PASSPHRASE);
    expect(fs.statSync(path.join(TEST_DIR, 'secure')).mode & 0o777).toBe(DIR_MODE);
    expect(fs.statSync(filePath).mode & 0o777).toBe(FILE_MODE);
  });

  it('replaces an existing wallet completely when told to (--force)', async () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    writeSealedWallet(filePath, PUBLIC, { seed: VALID_SEED, mnemonic: 'abandon abandon abandon' }, PASSPHRASE);
    const otherSeed = '1111111111111111111111111111111111111111111111111111111111111111';
    const otherAddresses = deriveAllAddresses(Buffer.from(otherSeed, 'hex'));
    writeSealedWallet(filePath, { addresses: otherAddresses, createdAt: '2026-02-26T00:00:00.000Z' }, { seed: otherSeed }, PASSPHRASE, { overwrite: true });
    const loaded = await unlockWallet(filePath, UNLOCK);
    expect(loaded.seed).toBe(otherSeed);
    expect(loaded.mnemonic).toBeUndefined();
    expect(loaded.addresses).toEqual(otherAddresses);
    expect(loaded.createdAt).toBe('2026-02-26T00:00:00.000Z');
  });
});

describe('loadWalletConfig', () => {
  it('loads a plain-text wallet an earlier mn wrote, without its secrets', async () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const loaded = await loadWalletConfig(filePath);
    expect(loaded).not.toHaveProperty('seed');
    expect(loaded.isSealed).toBe(false);
    expect(loaded.addresses).toEqual(VALID_CONFIG.addresses);
    expect(loaded.createdAt).toBe(VALID_CONFIG.createdAt);
  });

  it('throws when file does not exist', async () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    await expect(loadWalletConfig(filePath)).rejects.toThrow('Wallet file not found');
  });

  it('includes actionable recovery guidance in missing file error', async () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    await expect(loadWalletConfig(filePath)).rejects.toThrow('midnight wallet generate');
  });

  it('includes the file path in missing file error', async () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    await expect(loadWalletConfig(filePath)).rejects.toThrow(filePath);
  });

  it('throws on invalid JSON', async () => {
    const filePath = path.join(TEST_DIR, 'bad.json');
    fs.writeFileSync(filePath, 'not json at all');
    await expect(loadWalletConfig(filePath)).rejects.toThrow('Invalid JSON');
  });

  it('throws when seed is missing', async () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      addresses: VALID_ADDRESSES,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    await expect(loadWalletConfig(filePath)).rejects.toThrow('seed');
  });

  it('throws when address and addresses are both missing', async () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: VALID_SEED,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    await expect(loadWalletConfig(filePath)).rejects.toThrow('address');
  });

  it('throws when createdAt is missing', async () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: 'aabb00',
      addresses: VALID_ADDRESSES,
    }));
    await expect(loadWalletConfig(filePath)).rejects.toThrow('createdAt');
  });

  it('throws on non-hex seed', async () => {
    const filePath = path.join(TEST_DIR, 'badseed.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: 'not-a-hex-string!',
      addresses: VALID_ADDRESSES,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    await expect(loadWalletConfig(filePath)).rejects.toThrow('Invalid seed format');
  });

  it('auto-migrates old format with address and network fields', async () => {
    const filePath = path.join(TEST_DIR, 'old-format.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: VALID_SEED,
      network: 'preprod',
      address: 'mn_addr_preprod1oldaddress',
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    const loaded = await loadWalletConfig(filePath);
    // Should have derived all addresses from the seed
    expect(loaded.addresses).toEqual(VALID_ADDRESSES);
    expect((loaded as any).network).toBeUndefined();
    expect((loaded as any).address).toBeUndefined();
  });

  it('accepts config without optional mnemonic', async () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    expect((await unlockWallet(filePath, UNLOCK)).mnemonic).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('a plain-text wallet unlocks to all it holds, mnemonic included', async () => {
    const filePath = path.join(TEST_DIR, 'roundtrip.json');
    const seed = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const addresses = deriveAllAddresses(Buffer.from(seed, 'hex'));
    const shieldedAddresses = deriveAllShieldedAddresses(Buffer.from(seed, 'hex'));
    const original: WalletConfig = {
      seed,
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      addresses,
      shieldedAddresses,
      createdAt: '2026-02-26T12:00:00.000Z',
    };
    saveWalletConfig(original, filePath);
    expect(await unlockWallet(filePath, UNLOCK)).toEqual({ ...original, isSealed: false });
  });

  it('a sealed wallet unlocks to all it was written with', async () => {
    const filePath = path.join(TEST_DIR, 'roundtrip.json');
    const shieldedAddresses = deriveAllShieldedAddresses(Buffer.from(VALID_SEED, 'hex'));
    writeSealedWallet(filePath, { addresses: VALID_ADDRESSES, shieldedAddresses, createdAt: VALID_CONFIG.createdAt }, { seed: VALID_SEED }, PASSPHRASE);
    expect(await unlockWallet(filePath, UNLOCK)).toEqual({ ...VALID_CONFIG, shieldedAddresses, isSealed: true });
  });
});

describe('matchWalletAddress', () => {
  const shieldedAddresses = deriveAllShieldedAddresses(Buffer.from(VALID_SEED, 'hex'));
  const SEED_2 = '1111111111111111111111111111111111111111111111111111111111111111';

  const alice: WalletInfo = {
    name: 'alice',
    addresses: VALID_ADDRESSES,
    shieldedAddresses,
    isActive: true,
    file: '/wallets/alice.json',
  };
  const bob: WalletInfo = {
    name: 'bob',
    addresses: deriveAllAddresses(Buffer.from(SEED_2, 'hex')),
    isActive: false,
    file: '/wallets/bob.json',
  };

  it('matches an unshielded address to its wallet and network', () => {
    const result = matchWalletAddress([alice, bob], VALID_ADDRESSES.undeployed);
    expect(result?.wallet.name).toBe('alice');
    expect(result?.network).toBe('undeployed');
  });

  it('matches a shielded address to its wallet and network', () => {
    const result = matchWalletAddress([alice, bob], shieldedAddresses.preprod);
    expect(result?.wallet.name).toBe('alice');
    expect(result?.network).toBe('preprod');
  });

  it('returns undefined for an address no wallet owns', () => {
    const stranger = deriveAllAddresses(Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000099', 'hex',
    )).undeployed;
    expect(matchWalletAddress([alice, bob], stranger)).toBeUndefined();
  });

  it('returns undefined against an empty wallet list', () => {
    expect(matchWalletAddress([], VALID_ADDRESSES.undeployed)).toBeUndefined();
  });
});

describe('a wallet written before stagenet', () => {
  // The addresses an earlier mn wrote: every network but stagenet.
  const { stagenet: stagenetAddress, ...earlierAddresses } = VALID_ADDRESSES;
  const { stagenet: stagenetShielded, ...earlierShielded } = deriveAllShieldedAddresses(Buffer.from(VALID_SEED, 'hex'));

  it('gets its stagenet address derived and saved when a plain-text wallet is read', async () => {
    const filePath = path.join(TEST_DIR, 'plain.json');
    fs.writeFileSync(filePath, JSON.stringify({ seed: VALID_SEED, addresses: earlierAddresses, createdAt: VALID_CONFIG.createdAt }));
    const config = await loadWalletConfig(filePath);
    expect(config.addresses.stagenet).toBe(stagenetAddress);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).addresses).toEqual(VALID_ADDRESSES);
    expect(await walletAddress(filePath, 'stagenet', stateRootIn(TEST_DIR))).toBe(stagenetAddress);
  });

  it('keeps a sealed wallet as written until it is unlocked, then derives and saves its stagenet addresses beside the sealed secret', async () => {
    const filePath = path.join(TEST_DIR, 'sealed.json');
    writeSealedWallet(filePath, { addresses: earlierAddresses as typeof VALID_ADDRESSES, shieldedAddresses: earlierShielded as typeof VALID_ADDRESSES, createdAt: VALID_CONFIG.createdAt }, { seed: VALID_SEED }, PASSPHRASE);
    const sealedBefore = JSON.parse(fs.readFileSync(filePath, 'utf-8')).sealed;

    expect((await loadWalletConfig(filePath)).addresses.stagenet).toBeUndefined();

    const unlocked = await unlockWallet(filePath, UNLOCK);
    expect(unlocked.addresses.stagenet).toBe(stagenetAddress);
    expect(unlocked.shieldedAddresses?.stagenet).toBe(stagenetShielded);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(saved.addresses).toEqual(VALID_ADDRESSES);
    expect(saved.shieldedAddresses.stagenet).toBe(stagenetShielded);
    expect(saved.sealed).toEqual(sealedBefore);
    expect(saved.seed).toBeUndefined();
    expect((await loadWalletConfig(filePath)).addresses.stagenet).toBe(stagenetAddress);
  });
});
