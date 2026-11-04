// The localnet library: the compose file it writes (its services, ports,
// health checks and restart policies) and its version, the refusal every start
// path meets on this ledger-9 build, which containers a clean removes, and how
// docker compose's status lines are read. The localnet command's arguments,
// help and its refused up are the shell's tests (src/__tests__/localnet-command.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  COMPOSE_YAML,
  COMPOSE_VERSION,
  ensureComposeFile,
  getComposePath,
  LocalnetUnavailableError,
  parseServiceStatus,
} from '../lib/localnet.ts';

describe('COMPOSE_YAML content', () => {
  it('contains the node service with correct image', () => {
    expect(COMPOSE_YAML).toContain('midnight-node:');
  });

  it('contains the indexer service with correct image', () => {
    expect(COMPOSE_YAML).toContain('indexer-standalone:');
  });

  it('contains the proof-server service with correct image', () => {
    expect(COMPOSE_YAML).toContain('proof-server:');
  });

  it('exposes node port 9944', () => {
    expect(COMPOSE_YAML).toContain('"9944:9944"');
  });

  it('exposes indexer port 8088', () => {
    expect(COMPOSE_YAML).toContain("'8088:8088'");
  });

  it('exposes proof-server port 6300', () => {
    expect(COMPOSE_YAML).toContain('"6300:6300"');
  });

  it('includes healthcheck for node', () => {
    expect(COMPOSE_YAML).toContain('http://localhost:9944/health');
  });

  it('includes healthcheck for indexer', () => {
    expect(COMPOSE_YAML).toContain('cat /var/run/indexer-standalone/running');
  });

  it('has indexer depending on node', () => {
    expect(COMPOSE_YAML).toContain('depends_on');
    expect(COMPOSE_YAML).toContain('condition: service_started');
  });

  it('sets CFG_PRESET=dev for the node', () => {
    expect(COMPOSE_YAML).toContain('CFG_PRESET: "dev"');
  });

  it('starts with services: key (valid compose format)', () => {
    expect(COMPOSE_YAML.trimStart()).toMatch(/^services:/);
  });

  // Regression: node + proof-server used to have no restart policy while only the
  // indexer did. A Docker Desktop restart or any transient stop then left a
  // half-dead localnet (indexer up, node gone) — surfacing as ws "Normal Closure"
  // churn and a wedged dust sync. Every service must self-heal.
  it('gives every service a restart policy so the localnet self-heals', () => {
    const serviceBlock = (svc: string): string => {
      const start = COMPOSE_YAML.indexOf(`\n  ${svc}:`);
      if (start < 0) return '';
      const rest = COMPOSE_YAML.slice(start + 1);
      const next = rest.search(/\n {2}\S/); // next top-level (2-space) service key
      return next < 0 ? rest : rest.slice(0, next + 1);
    };
    for (const svc of ['proof-server', 'indexer', 'node']) {
      const block = serviceBlock(svc);
      expect(block, `service ${svc} present in compose`).not.toBe('');
      expect(block, `service ${svc} has a restart policy`).toMatch(/^\s+restart:/m);
    }
  });
});

describe('COMPOSE_VERSION', () => {
  it('is a semver-like string', () => {
    expect(COMPOSE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('ledger-9 build: mn localnet cannot start a network', () => {
  // The compose stack is ledger 8, which wallet-sdk 2.0 can't sync with, and
  // no published indexer image runs ledger 9 yet. Every start path goes
  // through ensureComposeFile, so it refuses there, before writing anything.
  // A state root of the test's own, which nothing creates.
  const root = join(tmpdir(), `midnight-localnet-ledger9-${process.pid}`);
  const composeFingerprint = () => {
    const path = getComposePath(root);
    return existsSync(path) ? `${statSync(path).mtimeMs}:${readFileSync(path, 'utf-8').length}` : 'absent';
  };

  it('ensureComposeFile refuses, says what to run instead, and writes nothing', () => {
    const before = composeFingerprint();
    let err: unknown;
    try { ensureComposeFile(root); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LocalnetUnavailableError);
    const msg = (err as Error).message;
    expect(msg).toContain('ledger 9');
    expect(msg).toContain('--node');
    expect(msg).toContain('--indexer-ws');
    expect(msg).toContain('--proof-server');
    expect(msg).toContain('midnight config set');
    expect(composeFingerprint()).toBe(before);
  });
});

describe('ensureComposeFile', () => {
  // Use a temp directory to test file writing logic without touching real ~/.midnight
  const TEST_DIR = join(tmpdir(), `midnight-localnet-test-${process.pid}`);
  const TEST_COMPOSE_PATH = join(TEST_DIR, 'compose.yml');
  const TEST_VERSION_PATH = join(TEST_DIR, '.version');

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('compose YAML can be written and read back', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_COMPOSE_PATH, COMPOSE_YAML, 'utf-8');
    writeFileSync(TEST_VERSION_PATH, COMPOSE_VERSION, 'utf-8');

    const content = readFileSync(TEST_COMPOSE_PATH, 'utf-8');
    expect(content).toBe(COMPOSE_YAML);

    const version = readFileSync(TEST_VERSION_PATH, 'utf-8');
    expect(version).toBe(COMPOSE_VERSION);
  });

  it('version file can detect stale compose file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_COMPOSE_PATH, COMPOSE_YAML, 'utf-8');
    writeFileSync(TEST_VERSION_PATH, '0.0.1', 'utf-8');

    const version = readFileSync(TEST_VERSION_PATH, 'utf-8').trim();
    expect(version).not.toBe(COMPOSE_VERSION);
  });
});

describe('localnet clean: which containers are mn\'s', () => {
  it('removes only containers from mn\'s compose project, keeping any other with the same generic name', async () => {
    const { partitionLocalnetContainers, LOCALNET_PROJECT } = await import('../lib/localnet.ts');
    expect(LOCALNET_PROJECT).toBe('localnet');
    expect(partitionLocalnetContainers([
      { name: 'node', project: 'localnet' },          // mn's (also an older mn's ledger-8 localnet)
      { name: 'indexer', project: 'my-app' },         // someone else's compose service
      { name: 'proof-server', project: '' },          // a plain docker run
    ])).toEqual({
      remove: ['node'],
      keep: [{ name: 'indexer', project: 'my-app' }, { name: 'proof-server', project: '' }],
    });
  });
});

describe('parseServiceStatus', () => {
  it('reads one service per line, stopped ones included', () => {
    const output = [
      JSON.stringify({ Service: 'node', State: 'running', Health: 'healthy', Image: 'midnightntwrk/midnight-node:1.0.0' }),
      JSON.stringify({ Service: 'indexer', State: 'exited', Health: '', Image: 'midnightntwrk/indexer-standalone:4.3.3' }),
      '',
    ].join('\n');
    expect(parseServiceStatus(output)).toEqual([
      { name: 'node', state: 'running', health: 'healthy', port: '9944', image: 'midnightntwrk/midnight-node:1.0.0' },
      { name: 'indexer', state: 'exited', health: '', port: '8088', image: 'midnightntwrk/indexer-standalone:4.3.3' },
    ]);
  });

  it('skips a line that is not JSON and is empty for no output', () => {
    expect(parseServiceStatus('time="..." level=warning msg="something"\n')).toEqual([]);
    expect(parseServiceStatus('')).toEqual([]);
  });
});
