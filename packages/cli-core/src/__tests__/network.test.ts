import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { addressPrefix, defaultSdkSetOf, detectNetworkFromAddress, isNamedOnlyNetwork, isValidNetworkName, getNetworkConfig, getValidNetworkNames, looksLikeShieldedAddress, looksLikeUnshieldedAddress, NetworkNotNamedError, resolveNetworkConfig, applyEndpointOverrides, indexerHttpFromWs } from '../lib/network.ts';
import { UsageError } from '../lib/errors.ts';
import { ProjectIdNetworkMismatchError } from '../lib/blockfrost.ts';

describe('detectNetworkFromAddress', () => {
  it('detects preprod from address prefix', () => {
    expect(detectNetworkFromAddress('mn_addr_preprod1qqqqqq...')).toBe('preprod');
  });

  it('detects preview from address prefix', () => {
    expect(detectNetworkFromAddress('mn_addr_preview1qqqqqq...')).toBe('preview');
  });

  it('detects undeployed from address prefix', () => {
    expect(detectNetworkFromAddress('mn_addr_undeployed1qqqqqq...')).toBe('undeployed');
  });

  it('detects mainnet from its prefix, which has no network segment', () => {
    expect(detectNetworkFromAddress('mn_addr1qqqqqq...')).toBe('mainnet');
  });

  it('keeps mainnet apart from every network whose prefix has a segment', () => {
    expect(detectNetworkFromAddress('mn_addr_preprod1qqqqqq...')).not.toBe('mainnet');
    expect(detectNetworkFromAddress('mn_addr_stagenet1qqqqqq...')).toBe('stagenet');
  });

  it('returns null for unknown prefix', () => {
    // Mainnet's addresses carry no network segment, so this one names no network.
    expect(detectNetworkFromAddress('mn_addr_mainnet1qqqqqq...')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectNetworkFromAddress('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(detectNetworkFromAddress('not-an-address')).toBeNull();
  });

  it('matches prefix exactly, not partial substrings', () => {
    // "preproduction" should not match "preprod"
    expect(detectNetworkFromAddress('mn_addr_preproduction1abc')).toBeNull();
  });
});

describe('isValidNetworkName', () => {
  it('accepts all known networks', () => {
    expect(isValidNetworkName('preprod')).toBe(true);
    expect(isValidNetworkName('preview')).toBe(true);
    expect(isValidNetworkName('undeployed')).toBe(true);
  });

  it('accepts mainnet', () => {
    expect(isValidNetworkName('mainnet')).toBe(true);
  });

  it('rejects unknown networks', () => {
    expect(isValidNetworkName('testnet')).toBe(false);
    expect(isValidNetworkName('MainNet')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidNetworkName('')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isValidNetworkName('PreProd')).toBe(false);
    expect(isValidNetworkName('PREPROD')).toBe(false);
  });
});

describe('getNetworkConfig', () => {
  it('returns Blockfrost\'s mainnet URLs without a project id, the local proof server, and the MainNet id', () => {
    expect(getNetworkConfig('mainnet')).toEqual({
      indexer: 'https://midnight-mainnet.blockfrost.io/api/v0',
      indexerWS: 'wss://midnight-mainnet.blockfrost.io/api/v0/ws',
      node: 'wss://rpc.midnight-mainnet.blockfrost.io',
      proofServer: 'http://localhost:6300',
      networkId: 'MainNet',
    });
  });

  // Midnight shut its own preprod indexer down on 2026-10-09; Blockfrost serves it.
  it('returns Blockfrost\'s URLs for preprod, without a project id', () => {
    const config = getNetworkConfig('preprod');
    expect(config.indexer).toBe('https://midnight-preprod.blockfrost.io/api/v0');
    expect(config.indexerWS).toBe('wss://midnight-preprod.blockfrost.io/api/v0/ws');
    expect(config.node).toBe('wss://rpc.midnight-preprod.blockfrost.io');
    expect(config.proofServer).toBe('http://localhost:6300');
    expect(config.networkId).toBe('PreProd');
  });

  it('returns exact URLs for preview', () => {
    const config = getNetworkConfig('preview');
    expect(config.indexer).toBe('https://indexer.preview.midnight.network/api/v4/graphql');
    expect(config.indexerWS).toBe('wss://indexer.preview.midnight.network/api/v4/graphql/ws');
    expect(config.node).toBe('wss://rpc.preview.midnight.network');
    expect(config.proofServer).toBe('http://localhost:6300');
    expect(config.networkId).toBe('Preview');
  });

  it('returns localhost URLs for undeployed', () => {
    const config = getNetworkConfig('undeployed');
    expect(config.indexer).toBe('http://localhost:8088/api/v4/graphql');
    expect(config.indexerWS).toBe('ws://localhost:8088/api/v4/graphql/ws');
    expect(config.node).toBe('ws://localhost:9944');
    expect(config.proofServer).toBe('http://localhost:6300');
    expect(config.networkId).toBe('Undeployed');
  });

  it('returns a defensive copy (mutation does not affect source)', () => {
    const a = getNetworkConfig('preprod');
    const b = getNetworkConfig('preprod');
    a.proofServer = 'http://mutated';
    a.indexer = 'http://mutated';
    expect(b.proofServer).toBe('http://localhost:6300');
    expect(b.indexer).toBe('https://midnight-preprod.blockfrost.io/api/v0');
  });
});

describe('getValidNetworkNames', () => {
  it('returns all five networks', () => {
    const names = getValidNetworkNames();
    expect(names).toContain('mainnet');
    expect(names).toContain('preprod');
    expect(names).toContain('preview');
    expect(names).toContain('stagenet');
    expect(names).toContain('undeployed');
    expect(names).toHaveLength(5);
  });

  it('agrees with isValidNetworkName', () => {
    const names = getValidNetworkNames();
    for (const name of names) {
      expect(isValidNetworkName(name)).toBe(true);
    }
  });
});

describe('resolveNetworkConfig', () => {
  it('returns standard config for preprod (no docker override)', () => {
    const resolved = resolveNetworkConfig('preprod');
    const standard = getNetworkConfig('preprod');
    expect(resolved).toEqual(standard);
  });

  it('returns standard config for preview (no docker override)', () => {
    const resolved = resolveNetworkConfig('preview');
    const standard = getNetworkConfig('preview');
    expect(resolved).toEqual(standard);
  });

  it('returns the default localnet endpoints for undeployed when no local stack runs', () => {
    // Detection injected: the real docker state varies by machine.
    const resolved = resolveNetworkConfig('undeployed', { detect: () => ({ node: [], indexer: [], proofServer: [] }) });
    expect(resolved).toEqual(getNetworkConfig('undeployed'));
    expect(resolved.networkId).toBe('Undeployed');
  });

  it('returns a copy that can be mutated without affecting future calls', () => {
    const a = resolveNetworkConfig('preprod');
    a.node = 'wss://mutated';
    const b = resolveNetworkConfig('preprod');
    expect(b.node).toBe('wss://rpc.midnight-preprod.blockfrost.io');
  });

  it('puts the Blockfrost project id on preprod\'s indexer and node', () => {
    const config = resolveNetworkConfig('preprod', { blockfrostProjectId: 'nightpreprodAbCdEfGhIjKlMnOp' });
    expect(config.indexer).toBe('https://midnight-preprod.blockfrost.io/api/v0?project_id=nightpreprodAbCdEfGhIjKlMnOp');
    expect(config.indexerWS).toBe('wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=nightpreprodAbCdEfGhIjKlMnOp');
    expect(config.node).toBe('wss://rpc.midnight-preprod.blockfrost.io?project_id=nightpreprodAbCdEfGhIjKlMnOp');
    expect(config.proofServer).toBe('http://localhost:6300');
  });

  it('lets given endpoints win over Blockfrost\'s', () => {
    const config = resolveNetworkConfig('preprod', { blockfrostProjectId: 'nightpreprodAbCdEfGhIjKlMnOp', given: { node: 'wss://my-node', indexerWS: 'wss://my-indexer/api/v4/graphql/ws' } });
    expect(config.node).toBe('wss://my-node');
    expect(config.indexer).toBe('https://my-indexer/api/v4/graphql');
  });

  it('puts a mainnet project id on mainnet\'s indexer and node', () => {
    const config = resolveNetworkConfig('mainnet', { blockfrostProjectId: 'nightmainnetAbCdEfGhIjKlMnOp' });
    expect(config.indexer).toBe('https://midnight-mainnet.blockfrost.io/api/v0?project_id=nightmainnetAbCdEfGhIjKlMnOp');
    expect(config.indexerWS).toBe('wss://midnight-mainnet.blockfrost.io/api/v0/ws?project_id=nightmainnetAbCdEfGhIjKlMnOp');
    expect(config.node).toBe('wss://rpc.midnight-mainnet.blockfrost.io?project_id=nightmainnetAbCdEfGhIjKlMnOp');
  });

  it('never sends one network\'s project id to the other', () => {
    expect(() => resolveNetworkConfig('mainnet', { blockfrostProjectId: 'nightpreprodAbCdEfGhIjKlMnOp' })).toThrow(ProjectIdNetworkMismatchError);
    expect(() => resolveNetworkConfig('preprod', { blockfrostProjectId: 'nightmainnetAbCdEfGhIjKlMnOp' })).toThrow(ProjectIdNetworkMismatchError);
  });

  it('gives a project id to no network Blockfrost doesn\'t serve', () => {
    expect(resolveNetworkConfig('preview', { blockfrostProjectId: 'nightpreprodAbCdEfGhIjKlMnOp' })).toEqual(getNetworkConfig('preview'));
  });
});

describe('mainnet', () => {
  it('runs on the rc SDK set', () => {
    expect(defaultSdkSetOf('mainnet')).toBe('rc');
  });

  it('is the one network a command must name itself', () => {
    expect(isNamedOnlyNetwork('mainnet')).toBe(true);
    for (const name of ['preprod', 'preview', 'stagenet', 'undeployed']) expect(isNamedOnlyNetwork(name)).toBe(false);
  });

  it('says how to name it when it was not, as a usage mistake', () => {
    const err = new NetworkNotNamedError('mainnet', 'it can\'t be the saved network');
    expect(err).toBeInstanceOf(UsageError);
    expect(err.code).toBe('INVALID_ARGS');
    expect(err.message).toContain('--network mainnet');
  });
});

describe('address prefixes', () => {
  it('are mainnet\'s without a network segment, the others\' with one', () => {
    expect(addressPrefix('unshielded', 'mainnet')).toBe('mn_addr1');
    expect(addressPrefix('shielded', 'mainnet')).toBe('mn_shield-addr1');
    expect(addressPrefix('unshielded', 'preprod')).toBe('mn_addr_preprod1');
    expect(addressPrefix('shielded', 'undeployed')).toBe('mn_shield-addr_undeployed1');
  });

  it('tell an address, mainnet\'s included, from a wallet name', () => {
    expect(looksLikeUnshieldedAddress('mn_addr1qqq')).toBe(true);
    expect(looksLikeUnshieldedAddress('mn_addr_preprod1qqq')).toBe(true);
    expect(looksLikeUnshieldedAddress('alice')).toBe(false);
    expect(looksLikeUnshieldedAddress('mn_shield-addr1qqq')).toBe(false);
    expect(looksLikeShieldedAddress('mn_shield-addr1qqq')).toBe(true);
    expect(looksLikeShieldedAddress('mn_shield-addr_preview1qqq')).toBe(true);
    expect(looksLikeShieldedAddress('mn_addr1qqq')).toBe(false);
  });
});

describe('applyEndpointOverrides', () => {
  const TEST_DIR = path.join(os.tmpdir(), `midnight-network-test-${process.pid}`);

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('applies flag overrides for proofServer', () => {
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, { proofServer: 'http://custom:6300' }, 'preprod', TEST_DIR);
    expect(config.proofServer).toBe('http://custom:6300');
  });

  it('applies flag overrides for node', () => {
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, { node: 'wss://custom-node' }, 'preprod', TEST_DIR);
    expect(config.node).toBe('wss://custom-node');
  });

  it('applies flag overrides for indexerWS and derives indexer HTTP', () => {
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, { indexerWS: 'wss://custom-indexer/api/v4/graphql/ws' }, 'preprod', TEST_DIR);
    expect(config.indexerWS).toBe('wss://custom-indexer/api/v4/graphql/ws');
    expect(config.indexer).toBe('https://custom-indexer/api/v4/graphql');
  });

  it('falls back to persistent config when no flag provided', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'preprod', 'proof-server': 'http://config-prover:6300' }),
    );
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, {}, 'preprod', TEST_DIR);
    expect(config.proofServer).toBe('http://config-prover:6300');
  });

  it('flag overrides take priority over persistent config', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'preprod', 'proof-server': 'http://config-prover:6300' }),
    );
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, { proofServer: 'http://flag-prover:6300' }, 'preprod', TEST_DIR);
    expect(config.proofServer).toBe('http://flag-prover:6300');
  });

  it('preserves network defaults when no overrides exist', () => {
    const config = getNetworkConfig('preprod');
    const original = { ...config };
    applyEndpointOverrides(config, {}, 'preprod', TEST_DIR);
    expect(config.proofServer).toBe(original.proofServer);
    expect(config.node).toBe(original.node);
    expect(config.indexerWS).toBe(original.indexerWS);
    expect(config.indexer).toBe(original.indexer);
  });

  it('does not modify networkId', () => {
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, { proofServer: 'http://custom:6300' }, 'preprod', TEST_DIR);
    expect(config.networkId).toBe('PreProd');
  });

  it('derives http indexer from ws:// protocol', () => {
    const config = getNetworkConfig('undeployed');
    applyEndpointOverrides(config, { indexerWS: 'ws://localhost:9999/api/v4/graphql/ws' }, 'undeployed', TEST_DIR);
    expect(config.indexer).toBe('http://localhost:9999/api/v4/graphql');
  });
});

describe('applyEndpointOverrides — network scoping (cross-network leak regression)', () => {
  const TEST_DIR = path.join(os.tmpdir(), `midnight-network-scope-test-${process.pid}`);

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // The original bug: config pinned to preprod with flat preprod endpoint
  // overrides hijacked `--network undeployed` runs — the genesis wallet
  // synced against the preprod indexer (HRP mismatch warnings, then a
  // ledger WASM "memory access out of bounds" from cross-chain state).
  it('flat overrides set under one network do NOT leak into another network', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'preprod',
        node: 'wss://rpc.preprod.midnight.network',
        'indexer-ws': 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
        'proof-server': 'http://localhost:6300',
      }),
    );
    const config = getNetworkConfig('undeployed');
    applyEndpointOverrides(config, {}, 'undeployed', TEST_DIR);
    expect(config.node).toBe('ws://localhost:9944');
    expect(config.indexerWS).toBe('ws://localhost:8088/api/v4/graphql/ws');
    expect(config.indexer).toBe('http://localhost:8088/api/v4/graphql');
  });

  it('flat overrides still apply to the network they were pinned under', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'preprod', node: 'wss://my-custom-preprod-node' }),
    );
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, {}, 'preprod', TEST_DIR);
    expect(config.node).toBe('wss://my-custom-preprod-node');
  });

  it('scoped overrides apply only to their own network', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'preprod',
        networks: { undeployed: { node: 'ws://my-localnet:19944' } },
      }),
    );
    const undeployed = getNetworkConfig('undeployed');
    applyEndpointOverrides(undeployed, {}, 'undeployed', TEST_DIR);
    expect(undeployed.node).toBe('ws://my-localnet:19944');

    const preprod = getNetworkConfig('preprod');
    applyEndpointOverrides(preprod, {}, 'preprod', TEST_DIR);
    expect(preprod.node).toBe('wss://rpc.midnight-preprod.blockfrost.io');
  });

  it('scoped override beats the flat key for the pinned network', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'preprod',
        node: 'wss://flat-node',
        networks: { preprod: { node: 'wss://scoped-node' } },
      }),
    );
    const config = getNetworkConfig('preprod');
    applyEndpointOverrides(config, {}, 'preprod', TEST_DIR);
    expect(config.node).toBe('wss://scoped-node');
  });

  it('scoped indexer-ws derives the HTTP indexer URL', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'undeployed',
        networks: { undeployed: { 'indexer-ws': 'ws://localhost:19088/api/v4/graphql/ws' } },
      }),
    );
    const config = getNetworkConfig('undeployed');
    applyEndpointOverrides(config, {}, 'undeployed', TEST_DIR);
    expect(config.indexer).toBe('http://localhost:19088/api/v4/graphql');
  });
});

describe('indexerHttpFromWs', () => {
  it('changes the protocol and drops the path\'s trailing /ws', () => {
    expect(indexerHttpFromWs('ws://localhost:8088/api/v4/graphql/ws')).toBe('http://localhost:8088/api/v4/graphql');
    expect(indexerHttpFromWs('wss://indexer.preview.midnight.network/api/v4/graphql/ws')).toBe('https://indexer.preview.midnight.network/api/v4/graphql');
  });

  // An explicit Blockfrost URL kept its /ws, so every HTTP query went to the WebSocket path.
  it('keeps a query string where it is', () => {
    expect(indexerHttpFromWs('wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=nightpreprodAbCdEfGhIjKlMnOp'))
      .toBe('https://midnight-preprod.blockfrost.io/api/v0?project_id=nightpreprodAbCdEfGhIjKlMnOp');
  });

  it('leaves a path that doesn\'t end in /ws alone', () => {
    expect(indexerHttpFromWs('wss://example.org/graphql?ws=/ws')).toBe('https://example.org/graphql?ws=/ws');
  });
});
