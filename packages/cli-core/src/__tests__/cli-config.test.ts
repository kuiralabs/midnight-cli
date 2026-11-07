import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadCliConfig, saveCliConfig, getConfigValue, setConfigValue, unsetConfigValue, getValidConfigKeys, getBlockfrostProjectId, getSdkSetOverride } from '../lib/cli-config.ts';
import { NetworkNotNamedError, sdkSetOfNetwork } from '../lib/network.ts';
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

  it('falls back to default for corrupted JSON', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), '{broken json!!');
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });

  it('falls back to default for empty file', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), '');
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
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

describe('the sdk-set key', () => {
  it('sets, reads and unsets a network\'s SDK set, the selected network\'s unless --network says', () => {
    expect(getConfigValue('sdk-set', TEST_DIR)).toBe('(not set)');
    setConfigValue('sdk-set', 'beta', TEST_DIR);
    setConfigValue('sdk-set', 'rc', TEST_DIR, 'stagenet');
    expect(getConfigValue('sdk-set', TEST_DIR)).toBe('beta');
    expect(getConfigValue('sdk-set', TEST_DIR, 'stagenet')).toBe('rc');
    expect(getSdkSetOverride(loadCliConfig(TEST_DIR), 'undeployed')).toBe('beta');
    unsetConfigValue('sdk-set', TEST_DIR);
    expect(getConfigValue('sdk-set', TEST_DIR)).toBe('(not set)');
    expect(getConfigValue('sdk-set', TEST_DIR, 'stagenet')).toBe('rc');
  });

  it('refuses a set mn has no engine for', () => {
    expect(() => setConfigValue('sdk-set', 'mainnet', TEST_DIR)).toThrow('Invalid SDK set: "mainnet"\nValid SDK sets: rc, beta');
  });

  it('drops a set it doesn\'t know from a hand-edited file', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({ network: 'undeployed', networks: { undeployed: { 'sdk-set': 'gamma' } } }));
    expect(getSdkSetOverride(loadCliConfig(TEST_DIR), 'undeployed')).toBeUndefined();
  });
});

describe('the SDK set a network runs on', () => {
  const root = path.join(TEST_DIR, 'state');

  it('is the table\'s until config gives the network another, and the caches follow it to a folder of the set\'s own', () => {
    expect(sdkSetOfNetwork('undeployed', root)).toBe('rc');
    expect(networkCacheFolder('undeployed', root)).toBe('undeployed');
    expect(getCachePath('mn_addr_undeployed1abcdefghijklmnopqrst', 'undeployed', root)).toBe(path.join(root, 'cache', 'undeployed', walletCacheFileName('mn_addr_undeployed1abcdefghijklmnopqrst')));

    setConfigValue('sdk-set', 'beta', root, 'undeployed');
    expect(sdkSetOfNetwork('undeployed', root)).toBe('beta');
    expect(networkCacheFolder('undeployed', root)).toBe('undeployed.beta');
    expect(getCachePath('mn_addr_undeployed1abcdefghijklmnopqrst', 'undeployed', root)).toBe(path.join(root, 'cache', 'undeployed.beta', walletCacheFileName('mn_addr_undeployed1abcdefghijklmnopqrst')));
    expect(getDustCachePath('undeployed', 'ab'.repeat(32), root)).toBe(path.join(root, 'cache', 'undeployed.beta', `dust-${'ab'.repeat(10)}.json`));

    // Back on the network's own set, the caches it kept there are the ones read.
    unsetConfigValue('sdk-set', root, 'undeployed');
    expect(networkCacheFolder('undeployed', root)).toBe('undeployed');
    expect(sdkSetOfNetwork('stagenet', root)).toBe('beta');
    expect(networkCacheFolder('stagenet', root)).toBe('stagenet');
  });
});
