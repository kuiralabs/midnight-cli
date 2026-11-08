import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CorruptConfigError, loadCliConfig, saveCliConfig, getConfigValue, setConfigValue, unsetConfigValue, getValidConfigKeys, getBlockfrostProjectId } from '../lib/cli-config.ts';
import { NetworkNotNamedError, RetiredNetworkError } from '../lib/network.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { getCachePath, networkCacheFolder, walletCacheFileName } from '../lib/wallet-cache.ts';
import { getDustCachePath } from '../lib/reader-cache-files.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-cli-config-test-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // The wallets the tests make active: config set wallet takes only a wallet that exists.
  fs.mkdirSync(path.join(TEST_DIR, 'wallets'));
  for (const name of ['alice', 'bob']) fs.writeFileSync(path.join(TEST_DIR, 'wallets', `${name}.json`), '{}');
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadCliConfig', () => {
  it('returns defaults when config dir does not exist', () => {
    const nonExistent = path.join(TEST_DIR, 'no-such-dir');
    const config = loadCliConfig(nonExistent);
    expect(config.network).toBe('undeployed');
  });

  it('returns defaults when config file is missing from dir', () => {
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });

  it('reads network from config file', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'preprod' }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preprod');
  });

  it('falls back to default for invalid network value', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'testnet' }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });

  // A file it can't read used to be taken as the defaults (another network, no
  // endpoints), and the next config set wrote the defaults over it.
  it.each([
    ['corrupted JSON', '{broken json!!'],
    ['an empty file', ''],
    ['JSON that is not an object', '["undeployed"]'],
  ])('refuses %s, saying how to fix it, as a usage error', (_what, content) => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), content);
    expect(() => loadCliConfig(TEST_DIR)).toThrow(CorruptConfigError);
    expect(() => loadCliConfig(TEST_DIR)).toThrow(/can't read its config file .*move it aside/s);
    expect(() => loadCliConfig(TEST_DIR)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
  });

  it('never writes over a file it can\'t read', () => {
    const file = path.join(TEST_DIR, 'config.json');
    fs.writeFileSync(file, '{broken json!!');
    expect(() => setConfigValue('network', 'preview', TEST_DIR)).toThrow(CorruptConfigError);
    expect(() => unsetConfigValue('node', TEST_DIR)).toThrow(CorruptConfigError);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken json!!');
  });

  it('falls back to default when network field is missing from JSON', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ someOtherKey: 'value' }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });
});

describe('saveCliConfig', () => {
  it('creates the config file', () => {
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    expect(fs.existsSync(path.join(TEST_DIR, 'config.json'))).toBe(true);
  });

  it('creates config directory if it does not exist', () => {
    const nested = path.join(TEST_DIR, 'deep', 'nested');
    saveCliConfig({ network: 'preprod' }, nested);
    expect(fs.existsSync(path.join(nested, 'config.json'))).toBe(true);
  });

  it('writes valid JSON that can be read back', () => {
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preview');
  });

  it('overwrites previous config completely', () => {
    saveCliConfig({ network: 'preprod' }, TEST_DIR);
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preview');
  });
});

describe('getConfigValue', () => {
  it('returns saved network value', () => {
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preview');
  });

  it('returns default when no config exists', () => {
    expect(getConfigValue('network', TEST_DIR)).toBe('undeployed');
  });

  it('throws for unknown key', () => {
    expect(() => getConfigValue('unknown', TEST_DIR)).toThrow('Unknown config key');
    expect(() => getConfigValue('unknown', TEST_DIR)).toThrow('Valid keys:');
  });

  it('accepts network-id as an alias for network (midnight-expert compat)', () => {
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    expect(getConfigValue('network-id', TEST_DIR)).toBe('preview');
  });
});

describe('setConfigValue', () => {
  it('persists a valid network', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
  });

  it('overwrites a previous network value', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    setConfigValue('network', 'preview', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preview');
  });

  it('throws for invalid network value with guidance', () => {
    expect(() => setConfigValue('network', 'testnet', TEST_DIR)).toThrow('Invalid network');
    expect(() => setConfigValue('network', 'testnet', TEST_DIR)).toThrow('preprod');
  });

  it('throws for unknown key', () => {
    expect(() => setConfigValue('unknown', 'value', TEST_DIR)).toThrow('Unknown config key');
  });

  it('accepts network-id as an alias when setting (midnight-expert compat)', () => {
    setConfigValue('network-id', 'preprod', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
  });

  it('does not corrupt existing config on validation failure', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    expect(() => setConfigValue('network', 'invalid', TEST_DIR)).toThrow();
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
  });
});

describe('endpoint config keys', () => {
  it('setConfigValue persists proof-server URL', () => {
    setConfigValue('proof-server', 'http://my-prover:6300', TEST_DIR);
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('http://my-prover:6300');
  });

  it('setConfigValue persists node URL', () => {
    setConfigValue('node', 'wss://rpc.preprod.midnight.network', TEST_DIR);
    expect(getConfigValue('node', TEST_DIR)).toBe('wss://rpc.preprod.midnight.network');
  });

  it('setConfigValue persists indexer-ws URL', () => {
    setConfigValue('indexer-ws', 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws', TEST_DIR);
    expect(getConfigValue('indexer-ws', TEST_DIR)).toBe('wss://indexer.preprod.midnight.network/api/v4/graphql/ws');
  });

  it('rejects invalid URL for endpoint keys', () => {
    expect(() => setConfigValue('proof-server', 'not-a-url', TEST_DIR)).toThrow('Invalid URL');
    expect(() => setConfigValue('node', 'localhost:9944', TEST_DIR)).toThrow('Must start with');
  });

  it('accepts http, https, ws, wss protocols', () => {
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    setConfigValue('node', 'ws://localhost:9944', TEST_DIR);
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('http://localhost:6300');
    expect(getConfigValue('node', TEST_DIR)).toBe('ws://localhost:9944');
  });

  it('returns (not set) for unset endpoint keys', () => {
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('(not set)');
    expect(getConfigValue('node', TEST_DIR)).toBe('(not set)');
    expect(getConfigValue('indexer-ws', TEST_DIR)).toBe('(not set)');
  });

  it('does not interfere with network config', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('http://localhost:6300');
  });

  it('loadCliConfig reads endpoint keys from file', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'preprod',
        'proof-server': 'http://my-prover:6300',
        node: 'wss://my-node',
        'indexer-ws': 'wss://my-indexer/ws',
      }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preprod');
    expect(config['proof-server']).toBe('http://my-prover:6300');
    expect(config.node).toBe('wss://my-node');
    expect(config['indexer-ws']).toBe('wss://my-indexer/ws');
  });

  it('loadCliConfig ignores non-string endpoint values', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'preprod',
        'proof-server': 123,
        node: true,
      }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config['proof-server']).toBeUndefined();
    expect(config.node).toBeUndefined();
  });
});

describe('wallet config key', () => {
  it('setConfigValue persists wallet name', () => {
    setConfigValue('wallet', 'alice', TEST_DIR);
    expect(getConfigValue('wallet', TEST_DIR)).toBe('alice');
  });

  it('overwrites a previous wallet value', () => {
    setConfigValue('wallet', 'alice', TEST_DIR);
    setConfigValue('wallet', 'bob', TEST_DIR);
    expect(getConfigValue('wallet', TEST_DIR)).toBe('bob');
  });

  it('rejects wallet name with path separators', () => {
    expect(() => setConfigValue('wallet', '../evil', TEST_DIR)).toThrow('Invalid wallet name');
    expect(() => setConfigValue('wallet', 'path/to/wallet', TEST_DIR)).toThrow('Invalid wallet name');
    expect(() => setConfigValue('wallet', 'path\\to\\wallet', TEST_DIR)).toThrow('Invalid wallet name');
  });

  it('rejects wallet name ending in .json', () => {
    expect(() => setConfigValue('wallet', 'alice.json', TEST_DIR)).toThrow('Invalid wallet name');
  });

  it('rejects empty wallet name', () => {
    expect(() => setConfigValue('wallet', '', TEST_DIR)).toThrow('Invalid wallet name');
  });

  it('rejects whitespace-only wallet name', () => {
    expect(() => setConfigValue('wallet', '   ', TEST_DIR)).toThrow('Invalid wallet name');
  });

  it('refuses a wallet with no file, as wallet use does, leaving the one set', () => {
    setConfigValue('wallet', 'alice', TEST_DIR);
    expect(() => setConfigValue('wallet', 'nope', TEST_DIR)).toThrow('Wallet "nope" not found');
    expect(getConfigValue('wallet', TEST_DIR)).toBe('alice');
  });

  it('refuses a name longer than a wallet name may be', () => {
    expect(() => setConfigValue('wallet', 'x'.repeat(65), TEST_DIR)).toThrow('at most 64');
  });

  it('returns (not set) when wallet is not configured', () => {
    expect(getConfigValue('wallet', TEST_DIR)).toBe('(not set)');
  });

  it('does not corrupt existing config on validation failure', () => {
    setConfigValue('wallet', 'alice', TEST_DIR);
    expect(() => setConfigValue('wallet', '../bad', TEST_DIR)).toThrow();
    expect(getConfigValue('wallet', TEST_DIR)).toBe('alice');
  });

  it('loadCliConfig reads wallet key from file', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'preprod', wallet: 'alice' }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.wallet).toBe('alice');
  });

  it('loadCliConfig ignores non-string wallet values', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'preprod', wallet: 123 }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.wallet).toBeUndefined();
  });

  it('does not interfere with other config keys', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    setConfigValue('wallet', 'alice', TEST_DIR);
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
    expect(getConfigValue('wallet', TEST_DIR)).toBe('alice');
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('http://localhost:6300');
  });
});

describe('the account-build key mn grant no longer takes', () => {
  it('is not a key any more', () => {
    expect(getValidConfigKeys()).not.toContain('account-build');
    expect(() => setConfigValue('account-build', '/opt/account-build', TEST_DIR)).toThrow();
  });

  it('is ignored in a config file an earlier mn wrote, and the rest of the file is read', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({ network: 'preprod', 'account-build': '/opt/account-build' }));
    const config: Record<string, unknown> = { ...loadCliConfig(TEST_DIR) };
    expect(config['account-build']).toBeUndefined();
    expect(config.network).toBe('preprod');
  });
});

describe('unsetConfigValue', () => {
  it('resets network to default (undeployed)', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    unsetConfigValue('network', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('undeployed');
  });

  it('removes endpoint key (proof-server)', () => {
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    unsetConfigValue('proof-server', TEST_DIR);
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('(not set)');
  });

  it('removes endpoint key (node)', () => {
    setConfigValue('node', 'ws://localhost:9944', TEST_DIR);
    unsetConfigValue('node', TEST_DIR);
    expect(getConfigValue('node', TEST_DIR)).toBe('(not set)');
  });

  it('removes endpoint key (indexer-ws)', () => {
    setConfigValue('indexer-ws', 'wss://indexer.example.com/ws', TEST_DIR);
    unsetConfigValue('indexer-ws', TEST_DIR);
    expect(getConfigValue('indexer-ws', TEST_DIR)).toBe('(not set)');
  });

  it('removes wallet key', () => {
    setConfigValue('wallet', 'alice', TEST_DIR);
    unsetConfigValue('wallet', TEST_DIR);
    expect(getConfigValue('wallet', TEST_DIR)).toBe('(not set)');
  });

  it('throws for unknown key', () => {
    expect(() => unsetConfigValue('unknown', TEST_DIR)).toThrow('Unknown config key');
  });

  it('round-trip: set → unset → get returns default/not-set', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    unsetConfigValue('network', TEST_DIR);
    unsetConfigValue('proof-server', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('undeployed');
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('(not set)');
  });

  it('does not corrupt other keys', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    setConfigValue('wallet', 'alice', TEST_DIR);
    unsetConfigValue('proof-server', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
    expect(getConfigValue('wallet', TEST_DIR)).toBe('alice');
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('(not set)');
  });
});

describe('blockfrost-project-id config key', () => {
  const ID = 'nightpreprodAbCdEfGhIjKlMnOpQrStUv0123';
  const raw = () => JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'config.json'), 'utf-8'));

  it('is a valid key, not set by default', () => {
    expect(getValidConfigKeys()).toContain('blockfrost-project-id');
    expect(getConfigValue('blockfrost-project-id', TEST_DIR)).toBe('(not set)');
  });

  it('is filed under the network its prefix names, whichever network is selected', () => {
    setConfigValue('network', 'undeployed', TEST_DIR);
    setConfigValue('blockfrost-project-id', ID, TEST_DIR);
    expect(raw().networks.preprod['blockfrost-project-id']).toBe(ID);
    expect(raw().networks.undeployed).toBeUndefined();
    expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'preprod')).toBe(ID);
    expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'preview')).toBeUndefined();
  });

  it('is shown masked, with its network', () => {
    setConfigValue('blockfrost-project-id', ID, TEST_DIR);
    expect(getConfigValue('blockfrost-project-id', TEST_DIR)).toBe('nightpreprod…0123 (preprod)');
  });

  it('refuses a project id for a network mn doesn\'t reach through Blockfrost, and writes nothing', () => {
    expect(() => setConfigValue('blockfrost-project-id', 'nighttestnetAbCdEfGhIjKlMnOp', TEST_DIR)).toThrow('it should start with "nightpreprod" (preprod), "nightmainnet" (mainnet)');
    expect(fs.existsSync(path.join(TEST_DIR, 'config.json'))).toBe(false);
  });

  describe('beside a mainnet one', () => {
    const MAINNET_ID = 'nightmainnetZyXwVuTsRqPoNmLkJiHg9876';

    it('files each under its own network, and neither replaces the other', () => {
      setConfigValue('blockfrost-project-id', ID, TEST_DIR);
      setConfigValue('blockfrost-project-id', MAINNET_ID, TEST_DIR);
      expect(raw().networks.preprod['blockfrost-project-id']).toBe(ID);
      expect(raw().networks.mainnet['blockfrost-project-id']).toBe(MAINNET_ID);
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'preprod')).toBe(ID);
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'mainnet')).toBe(MAINNET_ID);
    });

    it('is shown masked with its network, beside the preprod one', () => {
      setConfigValue('blockfrost-project-id', ID, TEST_DIR);
      setConfigValue('blockfrost-project-id', MAINNET_ID, TEST_DIR);
      expect(getConfigValue('blockfrost-project-id', TEST_DIR)).toBe('nightpreprod…0123 (preprod), nightmainnet…9876 (mainnet)');
      expect(getConfigValue('blockfrost-project-id', TEST_DIR, 'mainnet')).toBe('nightmainnet…9876 (mainnet)');
    });

    it('takes --network mainnet for a mainnet id, and refuses it for the preprod one', () => {
      setConfigValue('blockfrost-project-id', MAINNET_ID, TEST_DIR, 'mainnet');
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'mainnet')).toBe(MAINNET_ID);
      expect(() => setConfigValue('blockfrost-project-id', ID, TEST_DIR, 'mainnet')).toThrow('That is a preprod project id, and --network says mainnet.');
      expect(() => setConfigValue('blockfrost-project-id', MAINNET_ID, TEST_DIR, 'preprod')).toThrow('That is a mainnet project id, and --network says preprod.');
    });

    it('is removed by unset --network mainnet alone, leaving the preprod one', () => {
      setConfigValue('blockfrost-project-id', ID, TEST_DIR);
      setConfigValue('blockfrost-project-id', MAINNET_ID, TEST_DIR);
      unsetConfigValue('blockfrost-project-id', TEST_DIR, 'mainnet');
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'mainnet')).toBeUndefined();
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'preprod')).toBe(ID);
    });

    it('is never read for preprod when filed by hand under it, nor a preprod one for mainnet', () => {
      fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({ networks: { preprod: { 'blockfrost-project-id': MAINNET_ID }, mainnet: { 'blockfrost-project-id': ID } } }));
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'preprod')).toBeUndefined();
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'mainnet')).toBeUndefined();
    });

    it('leaves a preprod id stored before mainnet existed where it was', () => {
      fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({ network: 'preprod', networks: { preprod: { 'blockfrost-project-id': ID } } }));
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'preprod')).toBe(ID);
      expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'mainnet')).toBeUndefined();
    });
  });

  it('takes --network when it names the id\'s own network, and refuses another', () => {
    setConfigValue('blockfrost-project-id', ID, TEST_DIR, 'preprod');
    expect(getConfigValue('blockfrost-project-id', TEST_DIR, 'preprod')).toBe('nightpreprod…0123 (preprod)');
    expect(getConfigValue('blockfrost-project-id', TEST_DIR, 'preview')).toBe('(not set)');
    expect(() => setConfigValue('blockfrost-project-id', ID, TEST_DIR, 'preview')).toThrow('That is a preprod project id, and --network says preview.');
  });

  it('lives beside the network\'s endpoint overrides without disturbing them', () => {
    setConfigValue('proof-server', 'http://localhost:16300', TEST_DIR, 'preprod');
    setConfigValue('blockfrost-project-id', ID, TEST_DIR);
    expect(raw().networks.preprod).toEqual({ 'proof-server': 'http://localhost:16300', 'blockfrost-project-id': ID });

    unsetConfigValue('proof-server', TEST_DIR, 'preprod');
    expect(raw().networks.preprod).toEqual({ 'blockfrost-project-id': ID });
  });

  it('is removed by unset, leaving the network\'s other settings', () => {
    setConfigValue('proof-server', 'http://localhost:16300', TEST_DIR, 'preprod');
    setConfigValue('blockfrost-project-id', ID, TEST_DIR);
    unsetConfigValue('blockfrost-project-id', TEST_DIR);
    expect(getConfigValue('blockfrost-project-id', TEST_DIR)).toBe('(not set)');
    expect(raw().networks.preprod).toEqual({ 'proof-server': 'http://localhost:16300' });

    unsetConfigValue('proof-server', TEST_DIR, 'preprod');
    expect(raw().networks).toBeUndefined();
  });

  it('ignores one filed by hand under a network it isn\'t for', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({ network: 'preview', networks: { preview: { 'blockfrost-project-id': ID } } }));
    expect(getBlockfrostProjectId(loadCliConfig(TEST_DIR), 'preview')).toBeUndefined();
  });
});

describe('mainnet as the saved network', () => {
  const configPath = () => path.join(TEST_DIR, 'config.json');

  it('is refused by config set, which leaves the saved network as it was', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    expect(() => setConfigValue('network', 'mainnet', TEST_DIR)).toThrow(NetworkNotNamedError);
    expect(() => setConfigValue('network', 'mainnet', TEST_DIR)).toThrow('--network mainnet');
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
  });

  it('is refused through the network-id alias too', () => {
    expect(() => setConfigValue('network-id', 'mainnet', TEST_DIR)).toThrow(NetworkNotNamedError);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('is never read from a config file written by hand: the default network is', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ network: 'mainnet' }));
    expect(loadCliConfig(TEST_DIR).network).toBe('undeployed');
    expect(getConfigValue('network', TEST_DIR)).toBe('undeployed');
  });

  it('never resolves a command without --network to mainnet, and --network mainnet does', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ network: 'mainnet' }));
    const args = (flags: Record<string, string>) => ({ command: 'balance', subcommand: undefined, positionals: [], flags });
    expect(resolveNetworkName({ args: args({}), configDir: TEST_DIR })).toBe('undeployed');
    expect(resolveNetworkName({ args: args({ network: 'mainnet' }), configDir: TEST_DIR })).toBe('mainnet');
  });

  it('still lets mainnet\'s own settings be kept, which apply only when a command names it', () => {
    setConfigValue('proof-server', 'http://localhost:16300', TEST_DIR, 'mainnet');
    expect(getConfigValue('proof-server', TEST_DIR, 'mainnet')).toBe('http://localhost:16300');
    expect(getConfigValue('network', TEST_DIR)).toBe('undeployed');
  });
});

describe('getValidConfigKeys', () => {
  it('includes network', () => {
    expect(getValidConfigKeys()).toContain('network');
  });

  it('includes wallet key', () => {
    expect(getValidConfigKeys()).toContain('wallet');
  });

  it('includes endpoint keys', () => {
    const keys = getValidConfigKeys();
    expect(keys).toContain('proof-server');
    expect(keys).toContain('node');
    expect(keys).toContain('indexer-ws');
  });

  it('returns at least one key', () => {
    expect(getValidConfigKeys().length).toBeGreaterThan(0);
  });
});

describe('per-network endpoint scoping', () => {
  const configPath = () => path.join(TEST_DIR, 'config.json');
  const readRaw = () => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));

  it('set writes endpoint scoped under the current network and clears the flat key', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      network: 'preprod',
      node: 'wss://legacy-flat-node',
    }));
    setConfigValue('node', 'wss://new-preprod-node', TEST_DIR);
    const raw = readRaw();
    expect(raw.networks.preprod.node).toBe('wss://new-preprod-node');
    expect(raw.node).toBeUndefined();
  });

  it('get reads the scoped value for the current network', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      network: 'undeployed',
      networks: { undeployed: { node: 'ws://scoped:9944' } },
    }));
    expect(getConfigValue('node', TEST_DIR)).toBe('ws://scoped:9944');
  });

  it('get falls back to the flat key for the pinned network', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      network: 'preprod',
      node: 'wss://flat-node',
    }));
    expect(getConfigValue('node', TEST_DIR)).toBe('wss://flat-node');
  });

  it('switching network migrates flat endpoint keys into the OLD network scope', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      network: 'preprod',
      node: 'wss://rpc.preprod.midnight.network',
      'indexer-ws': 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    }));
    setConfigValue('network', 'undeployed', TEST_DIR);
    const raw = readRaw();
    expect(raw.network).toBe('undeployed');
    // Flat keys moved under preprod — the network they were set under.
    expect(raw.node).toBeUndefined();
    expect(raw['indexer-ws']).toBeUndefined();
    expect(raw.networks.preprod.node).toBe('wss://rpc.preprod.midnight.network');
    expect(raw.networks.preprod['indexer-ws']).toBe('wss://indexer.preprod.midnight.network/api/v4/graphql/ws');
    // And the new network sees defaults, not the old URLs.
    expect(getConfigValue('node', TEST_DIR)).toBe('(not set)');
  });

  it('unset clears both the scoped entry and the flat key', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      network: 'preprod',
      node: 'wss://flat-node',
      networks: { preprod: { node: 'wss://scoped-node' } },
    }));
    unsetConfigValue('node', TEST_DIR);
    const raw = readRaw();
    expect(raw.node).toBeUndefined();
    expect(raw.networks).toBeUndefined(); // empty scopes are pruned
    expect(getConfigValue('node', TEST_DIR)).toBe('(not set)');
  });

  it('unset for one network leaves other networks scoped entries alone', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      network: 'preprod',
      networks: {
        preprod: { node: 'wss://preprod-node' },
        undeployed: { node: 'ws://localnet-node' },
      },
    }));
    unsetConfigValue('node', TEST_DIR);
    const raw = readRaw();
    expect(raw.networks.preprod).toBeUndefined();
    expect(raw.networks.undeployed.node).toBe('ws://localnet-node');
  });

  it('loadCliConfig drops invalid network names and non-string endpoint values', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      network: 'preprod',
      networks: {
        bogusnet: { node: 'ws://x' },
        preprod: { node: 12345, 'indexer-ws': 'wss://ok/ws' },
      },
    }));
    const config = loadCliConfig(TEST_DIR);
    expect(config.networks?.preprod?.['indexer-ws']).toBe('wss://ok/ws');
    expect(config.networks?.preprod?.node).toBeUndefined();
    expect((config.networks as Record<string, unknown> | undefined)?.bogusnet).toBeUndefined();
  });
});

describe('endpoint keys for a network other than the selected one (--network)', () => {
  it('sets, reads and unsets a node for preprod while undeployed stays selected and untouched', () => {
    setConfigValue('node', 'ws://undeployed-node:9944', TEST_DIR);
    setConfigValue('node', 'wss://preprod-node.example', TEST_DIR, 'preprod');

    expect(getConfigValue('network', TEST_DIR)).toBe('undeployed');
    expect(getConfigValue('node', TEST_DIR)).toBe('ws://undeployed-node:9944');
    expect(getConfigValue('node', TEST_DIR, 'preprod')).toBe('wss://preprod-node.example');

    unsetConfigValue('node', TEST_DIR, 'preprod');
    expect(getConfigValue('node', TEST_DIR, 'preprod')).toBe('(not set)');
    expect(getConfigValue('node', TEST_DIR)).toBe('ws://undeployed-node:9944');
  });

  it('refuses --network on a key that is not per network', () => {
    expect(() => setConfigValue('wallet', 'alice', TEST_DIR, 'preprod')).toThrow('--network only applies to the endpoint keys');
    expect(() => getConfigValue('network', TEST_DIR, 'preprod')).toThrow('--network only applies to the endpoint keys');
  });
});

describe('a config an earlier mn wrote with stagenet, which mn no longer runs on', () => {
  const root = path.join(TEST_DIR, 'state');
  const writeConfig = (config: object) => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  };
  const savedFile = () => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8'));
  const args = (flags: Record<string, string>) => ({ command: 'balance', subcommand: undefined, positionals: [], flags });

  it('loads, and a command on the saved network refuses it, saying it is no longer supported and how to pick another', () => {
    writeConfig({ network: 'stagenet', node: 'wss://rpc.stagenet.example' });
    expect(loadCliConfig(root)).toMatchObject({ network: 'undeployed', retiredNetwork: 'stagenet' });
    const refusal = (() => { try { resolveNetworkName({ args: args({}), configDir: root }); } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(RetiredNetworkError);
    expect(refusal).toMatchObject({ code: 'INVALID_ARGS' });
    expect((refusal as Error).message).toBe(
      'stagenet is no longer supported (the saved network): mn runs on mainnet, preprod, preview, undeployed.\n'
      + 'Pick another network: --network <name> on the command, or save one with: midnight config set network <preprod|preview|undeployed>',
    );
  });

  it('runs a command that names its network, without the flat endpoints set under stagenet', () => {
    writeConfig({ network: 'stagenet', node: 'wss://rpc.stagenet.example', 'indexer-ws': 'wss://indexer.stagenet.example/api/v4/graphql/ws' });
    expect(resolveNetworkName({ args: args({ network: 'undeployed' }), configDir: root })).toBe('undeployed');
    expect(getConfigValue('node', root, 'undeployed')).toBe('(not set)');
  });

  it('shows stagenet as the saved network, and keeps it through another key\'s write', () => {
    writeConfig({ network: 'stagenet' });
    expect(getConfigValue('network', root)).toBe('stagenet');
    setConfigValue('proof-server', 'http://localhost:6300', root, 'undeployed');
    expect(savedFile().network).toBe('stagenet');
  });

  it('is gone once another network is saved, or the network is unset', () => {
    writeConfig({ network: 'stagenet' });
    setConfigValue('network', 'preview', root);
    expect(savedFile().network).toBe('preview');
    expect(resolveNetworkName({ args: args({}), configDir: root })).toBe('preview');

    writeConfig({ network: 'stagenet' });
    unsetConfigValue('network', root);
    expect(savedFile().network).toBe('undeployed');
    expect(loadCliConfig(root).retiredNetwork).toBeUndefined();
  });

  it('refuses stagenet as a network to save, given on a command, or as a scope, leaving the file as it was', () => {
    writeConfig({ network: 'preview' });
    expect(() => setConfigValue('network', 'stagenet', root)).toThrow(RetiredNetworkError);
    expect(savedFile().network).toBe('preview');
    expect(() => resolveNetworkName({ args: args({ network: 'stagenet' }), configDir: root })).toThrow('stagenet is no longer supported (given as the network)');
    expect(() => networkCacheFolder('stagenet', root)).toThrow(RetiredNetworkError);
  });

  it('drops the sdk-set key an earlier mn kept per network, which is no longer a key', () => {
    writeConfig({ network: 'undeployed', networks: { undeployed: { 'sdk-set': 'beta', node: 'ws://localhost:9944' } } });
    expect(loadCliConfig(root).networks).toStrictEqual({ undeployed: { node: 'ws://localhost:9944' } });
    expect(() => setConfigValue('sdk-set', 'rc', root)).toThrow('Unknown config key: "sdk-set"');
    expect(getValidConfigKeys()).not.toContain('sdk-set');
  });

  it('keeps every cache in the network\'s own folder', () => {
    expect(networkCacheFolder('undeployed', root)).toBe('undeployed');
    expect(getCachePath('mn_addr_undeployed1abcdefghijklmnopqrst', 'undeployed', root)).toBe(path.join(root, 'cache', 'undeployed', walletCacheFileName('mn_addr_undeployed1abcdefghijklmnopqrst')));
    expect(getDustCachePath('undeployed', 'ab'.repeat(32), root)).toBe(path.join(root, 'cache', 'undeployed', `dust-${'ab'.repeat(10)}.json`));
  });
});

// config.json can hold a Blockfrost project id. A folder or file an earlier mn
// left readable to others is narrowed to its owner when mn next writes it.
describe('the config file\'s permissions', () => {
  it('narrows an existing 0755 folder and 0644 file to 0700 and 0600 on save', () => {
    const root = path.join(TEST_DIR, 'wide');
    fs.mkdirSync(root, { mode: 0o755 });
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ network: 'undeployed' }), { mode: 0o644 });
    fs.chmodSync(path.join(root, 'config.json'), 0o644);
    setConfigValue('network', 'preview', root);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'config.json')).mode & 0o777).toBe(0o600);
  });
});
