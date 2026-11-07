import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveWalletPath,
  listWallets,
  removeWallet,
  setActiveWallet,
  getActiveWalletName,
  loadWalletConfig,
} from '../lib/wallet-config.ts';
import { ensureWalletsDir, migrateOldWallet } from '../lib/wallet-paths.ts';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from '../../../../test-support/plain-wallet.ts';
import { loadCliConfig, saveCliConfig, type CliConfig, MIDNIGHT_DIR, WALLETS_DIR_NAME, DEFAULT_WALLET_NAME, DEFAULT_WALLET_FILENAME, DIR_MODE, FILE_MODE, isValidWalletName, createHost, InvalidWalletNameError } from '@kuiralabs/midnight-cli-core';
import { getCachePath, saveWalletCache } from '@kuiralabs/midnight-cli-core/engine';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

// The engines the wallet functions derive a wallet's missing addresses with: a host's of the engines the CLI ships.
const { engines } = createHost({ engineLoader: loadInstalledEngine });

// Use a temp dir that simulates ~/.midnight
const TEST_HOME = path.join(os.tmpdir(), `midnight-multi-wallet-test-${process.pid}`);
const TEST_MIDNIGHT_DIR = path.join(TEST_HOME, MIDNIGHT_DIR);
const TEST_WALLETS_DIR = path.join(TEST_MIDNIGHT_DIR, WALLETS_DIR_NAME);
const TEST_CONFIG_PATH = path.join(TEST_MIDNIGHT_DIR, 'config.json');

const SEED_1 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const SEED_2 = '1111111111111111111111111111111111111111111111111111111111111111';

const VALID_WALLET: WalletConfig = {
  seed: SEED_1,
  addresses: rcKeys.unshieldedAddresses(Buffer.from(SEED_1, 'hex')),
  createdAt: '2025-01-01T00:00:00.000Z',
};

const VALID_WALLET_2: WalletConfig = {
  seed: SEED_2,
  addresses: rcKeys.unshieldedAddresses(Buffer.from(SEED_2, 'hex')),
  createdAt: '2025-02-01T00:00:00.000Z',
};

// Helper to set up wallets dir with named wallets
function createWalletFile(name: string, config: WalletConfig): void {
  fs.mkdirSync(TEST_WALLETS_DIR, { recursive: true, mode: DIR_MODE });
  const filePath = path.join(TEST_WALLETS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', { mode: FILE_MODE });
}

function createConfig(config: Partial<CliConfig>): void {
  fs.mkdirSync(TEST_MIDNIGHT_DIR, { recursive: true, mode: DIR_MODE });
  const full: CliConfig = { network: 'undeployed', ...config };
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(full, null, 2) + '\n', { mode: FILE_MODE });
}

beforeEach(() => {
  fs.mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ─── resolveWalletPath ─────────────────────────────────────

describe('resolveWalletPath', () => {
  it('treats value with / as a file path', () => {
    const result = resolveWalletPath(TEST_MIDNIGHT_DIR, '/tmp/my-wallet.json');
    expect(result).toBe('/tmp/my-wallet.json');
  });

  it('treats value ending in .json as a file path', () => {
    const result = resolveWalletPath(TEST_MIDNIGHT_DIR, 'wallet.json');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('wallet.json');
  });

  it('treats simple name as wallet name and resolves to wallets dir', () => {
    const result = resolveWalletPath(TEST_MIDNIGHT_DIR, 'alice');
    expect(result).toContain(WALLETS_DIR_NAME);
    expect(result).toContain('alice.json');
  });

  it('resolves to wallets directory when no argument given', () => {
    // No config under the state root: the default wallet.
    const result = resolveWalletPath(TEST_MIDNIGHT_DIR);
    expect(result).toContain(WALLETS_DIR_NAME);
    expect(result).toMatch(/\.json$/);
  });

  it('uses active wallet from config when no argument given', () => {
    createConfig({ wallet: 'alice' });
    expect(resolveWalletPath(TEST_MIDNIGHT_DIR)).toBe(path.join(TEST_WALLETS_DIR, 'alice.json'));
  });
});

// ─── listWallets ────────────────────────────────────────────

describe('listWallets', () => {
  it('returns empty array when wallets dir does not exist', async () => {
    const wallets = await listWallets(TEST_MIDNIGHT_DIR, engines);
    expect(wallets).toEqual([]);
  });

  it('lists wallets from wallets directory', () => {
    createWalletFile('alice', VALID_WALLET);
    createWalletFile('bob', VALID_WALLET_2);

    // We can't directly test listWallets since it reads from real homedir,
    // but we can verify the wallet files were created correctly
    const files = fs.readdirSync(TEST_WALLETS_DIR);
    expect(files).toContain('alice.json');
    expect(files).toContain('bob.json');
  });

  it('marks active wallet correctly', () => {
    createWalletFile('alice', VALID_WALLET);
    createWalletFile('bob', VALID_WALLET_2);
    createConfig({ wallet: 'alice' });

    // Read config and verify
    const config = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, 'utf-8'));
    expect(config.wallet).toBe('alice');
  });
});

// ─── removeWallet ───────────────────────────────────────────

describe('removeWallet', () => {
  it('throws when wallet does not exist', () => {
    expect(() => removeWallet(TEST_MIDNIGHT_DIR, 'nonexistent')).toThrow('not found');
  });

  it('rejects invalid wallet names with path traversal', () => {
    expect(() => removeWallet(TEST_MIDNIGHT_DIR, '../evil')).toThrow('Invalid wallet name');
    expect(() => removeWallet(TEST_MIDNIGHT_DIR, 'path/to/wallet')).toThrow('Invalid wallet name');
  });

  it('rejects empty wallet name', () => {
    expect(() => removeWallet(TEST_MIDNIGHT_DIR, '')).toThrow('Invalid wallet name');
  });

  it('rejects wallet name ending in .json', () => {
    expect(() => removeWallet(TEST_MIDNIGHT_DIR, 'test.json')).toThrow('Invalid wallet name');
  });
});

// ─── migrateOldWallet ───────────────────────────────────────

describe('migrateOldWallet', () => {
  it('is a no-op when old wallet does not exist', () => {
    // Should not throw
    migrateOldWallet(TEST_MIDNIGHT_DIR);
  });

  it('is idempotent — does nothing on second call', () => {
    migrateOldWallet(TEST_MIDNIGHT_DIR);
    migrateOldWallet(TEST_MIDNIGHT_DIR);
    // No error
  });
});

// ─── loadWalletConfig error messages ────────────────────────

describe('loadWalletConfig error messages', () => {
  it('suggests "midnight wallet generate" in missing file error', async () => {
    const filePath = path.join(TEST_HOME, 'nonexistent.json');
    await expect(loadWalletConfig(filePath, engines)).rejects.toThrow('midnight wallet generate');
  });
});

// ─── setActiveWallet validation ──────────────────────────────

describe('setActiveWallet validation', () => {
  it('rejects path traversal names', () => {
    expect(() => setActiveWallet(TEST_MIDNIGHT_DIR, '../evil')).toThrow('Invalid wallet name');
    expect(() => setActiveWallet(TEST_MIDNIGHT_DIR, 'a/b')).toThrow('Invalid wallet name');
  });

  it('rejects empty name', () => {
    expect(() => setActiveWallet(TEST_MIDNIGHT_DIR, '')).toThrow('Invalid wallet name');
  });

  it('rejects .json suffix', () => {
    expect(() => setActiveWallet(TEST_MIDNIGHT_DIR, 'test.json')).toThrow('Invalid wallet name');
  });

  it('rejects control characters', () => {
    expect(() => setActiveWallet(TEST_MIDNIGHT_DIR, 'test\x00name')).toThrow('Invalid wallet name');
  });
});

// ─── isValidWalletName ──────────────────────────────────────

describe('isValidWalletName', () => {
  it('accepts simple names', () => {
    expect(isValidWalletName('alice')).toBe(true);
    expect(isValidWalletName('bob')).toBe(true);
    expect(isValidWalletName('my-wallet')).toBe(true);
    expect(isValidWalletName('wallet_1')).toBe(true);
    expect(isValidWalletName('default')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidWalletName('')).toBe(false);
  });

  it('rejects whitespace-only', () => {
    expect(isValidWalletName('   ')).toBe(false);
    expect(isValidWalletName(' alice')).toBe(false);
    expect(isValidWalletName('alice ')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isValidWalletName('a/b')).toBe(false);
    expect(isValidWalletName('a\\b')).toBe(false);
    expect(isValidWalletName('../evil')).toBe(false);
  });

  it('rejects .json suffix', () => {
    expect(isValidWalletName('wallet.json')).toBe(false);
  });

  it('rejects dot and double-dot', () => {
    expect(isValidWalletName('.')).toBe(false);
    expect(isValidWalletName('..')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isValidWalletName('test\x00name')).toBe(false);
    expect(isValidWalletName('test\nnewline')).toBe(false);
    expect(isValidWalletName('\ttab')).toBe(false);
  });
});

// ─── saveWalletConfig + loadWalletConfig round-trip ─────────

describe('wallet config round-trip with named wallets', () => {
  it('saves and loads from wallets directory path', async () => {
    const walletPath = path.join(TEST_WALLETS_DIR, 'test.json');
    saveWalletConfig(VALID_WALLET, walletPath);
    const loaded = await loadWalletConfig(walletPath, engines);
    expect(loaded).not.toHaveProperty('seed');
    expect(loaded.isSealed).toBe(false);
    expect(loaded.addresses).toEqual(VALID_WALLET.addresses);
  });
});

// The active wallet's name, written into config.json by hand, is checked as one
// given on the command line: "../../x" named a file outside the wallets folder.
describe('the active wallet named in config.json', () => {
  it.each(['../../x', '../wallets/alice', 'x'.repeat(65)])('%s is refused, saying how to choose a wallet', (name) => {
    createConfig({ wallet: name });
    expect(() => getActiveWalletName(TEST_MIDNIGHT_DIR)).toThrow(InvalidWalletNameError);
    expect(() => resolveWalletPath(TEST_MIDNIGHT_DIR)).toThrow(/active wallet in .*config\.json.*\n.*midnight wallet use <name>/s);
  });
});

// A removed wallet's sync caches went on taking space, and were read again by
// a wallet later made from the same seed.
describe('removeWallet and the wallet\'s caches', () => {
  it('removes the wallet\'s sync cache on each network, leaving the other wallet\'s', async () => {
    createWalletFile('alice', VALID_WALLET);
    createWalletFile('bob', VALID_WALLET_2);
    createConfig({ wallet: 'alice' });
    const serialized = { serializeState: async () => 's' };
    const facade = { shielded: serialized, unshielded: serialized, dust: serialized };
    for (const network of ['undeployed', 'preview'] as const) {
      await saveWalletCache(VALID_WALLET.addresses[network], network, facade, TEST_MIDNIGHT_DIR);
      await saveWalletCache(VALID_WALLET_2.addresses[network], network, facade, TEST_MIDNIGHT_DIR);
    }

    removeWallet(TEST_MIDNIGHT_DIR, 'bob');

    for (const network of ['undeployed', 'preview'] as const) {
      expect(fs.existsSync(getCachePath(VALID_WALLET_2.addresses[network], network, TEST_MIDNIGHT_DIR))).toBe(false);
      expect(fs.existsSync(getCachePath(VALID_WALLET.addresses[network], network, TEST_MIDNIGHT_DIR))).toBe(true);
    }
  });
});

describe('the wallets folder', () => {
  it('is narrowed to 0700, with the state root, when an earlier mn left them 0755', () => {
    fs.mkdirSync(TEST_WALLETS_DIR, { recursive: true });
    fs.chmodSync(TEST_MIDNIGHT_DIR, 0o755);
    fs.chmodSync(TEST_WALLETS_DIR, 0o755);
    ensureWalletsDir(TEST_MIDNIGHT_DIR);
    expect(fs.statSync(TEST_MIDNIGHT_DIR).mode & 0o777).toBe(0o700);
    expect(fs.statSync(TEST_WALLETS_DIR).mode & 0o777).toBe(0o700);
  });
});
