// The contract runner emits a Node script for the engine's set: these tests
// check the scripts the rc engine generates with the runner's parts (each
// starts with the prelude, imports only what its packages export, and parses),
// and that a cancelled run starts none. The generated provider fragments are
// the rc engine's own (packages/engine-rc/src/__tests__/contract-scripts.test.ts).

import { describe, it, expect } from 'vitest';
import { CancelledError, contractKeysFromSeed, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import type { CallScript, DeployScript, StateScript } from '@kuiralabs/midnight-cli-core/engine';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRIPT_PARTS, SCRIPT_PRELUDE, runCall, runDeploy, runState } from '../lib/contract/runner.ts';
import { rcEngine } from '../../../../test-support/rc-engine.ts';
import { testHost } from '../../../../test-support/test-host.ts';

// The rc engine's scripts, with the parts the runner gives every engine.
const generateDeployScript = (opts: DeployScript & { dappDir?: string }): string => rcEngine.contracts.scripts.deploy(opts, SCRIPT_PARTS);
const generateCallScript = (opts: CallScript & { dappDir?: string }): string => rcEngine.contracts.scripts.call(opts, SCRIPT_PARTS);
const generateStateScript = (opts: StateScript & { dappDir?: string }): string => rcEngine.contracts.scripts.state(opts, SCRIPT_PARTS);

const NETWORK: NetworkConfig = {
  indexer: 'http://127.0.0.1:1/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:1/api/v4/graphql/ws',
  node: 'ws://127.0.0.1:1',
  proofServer: 'http://127.0.0.1:1',
  networkId: 'Undeployed',
};

describe('generated scripts', () => {
  const scripts = {
    deploy: generateDeployScript({
      dappDir: '/tmp/dapp', networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', servePort: 9932, args: [1, 'x'],
    }),
    call: generateCallScript({
      dappDir: '/tmp/dapp', networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', servePort: 9932, contractAddress: 'ab'.repeat(32), circuit: 'increment', args: [],
    }),
    state: generateStateScript({
      dappDir: '/tmp/dapp', networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', contractAddress: 'ab'.repeat(32),
    }),
  };

  it('starts every script with the prelude that reports failures as one marked line', () => {
    for (const script of Object.values(scripts)) {
      expect(script.startsWith(SCRIPT_PRELUDE)).toBe(true);
    }
  });

  for (const [name, script] of Object.entries(scripts)) {
    it(`${name} script: every named import exists in the installed package`, async () => {
      const imports = [...script.matchAll(/^import \{([^}]+)\} from '([^']+)';$/gm)];
      expect(imports.length).toBeGreaterThan(0);
      for (const [, names, specifier] of imports) {
        if (specifier.startsWith('node:')) continue;
        const mod = await import(specifier);
        for (const raw of names.split(',')) {
          const exported = raw.trim().split(/\s+as\s+/)[0];
          expect(mod[exported], `${exported} from ${specifier}`).toBeDefined();
        }
      }
    });

    it(`${name} script: parses as an ES module`, () => {
      const tmp = mkdtempSync(join(tmpdir(), 'mn-runner-syntax-'));
      try {
        const file = join(tmp, 'script.mjs');
        writeFileSync(file, script);
        const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        expect(res.stderr).toBe('');
        expect(res.status).toBe(0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

describe('a cancelled run', () => {
  it('starts no script for a deploy, a call or a state read whose run was cancelled, and says it was cancelled', async () => {
    const dappDir = mkdtempSync(join(tmpdir(), 'mn-cancelled-run-'));
    const root = mkdtempSync(join(tmpdir(), 'mn-cancelled-run-root-'));
    try {
      const common = { dappDir, network: 'undeployed' as const, root, engines: testHost().engines, networkConfig: NETWORK, managedDir: join(dappDir, 'managed', 'counter'), contractName: 'counter', signal: AbortSignal.abort(), contractKeys: contractKeysFromSeed(Buffer.alloc(32, 1)) };
      await expect(runDeploy({ ...common, servePort: 9932 })).rejects.toBeInstanceOf(CancelledError);
      await expect(runCall({ ...common, servePort: 9932, contractAddress: 'ab'.repeat(32), circuit: 'increment' })).rejects.toBeInstanceOf(CancelledError);
      await expect(runState({ ...common, contractAddress: 'ab'.repeat(32) })).rejects.toBeInstanceOf(CancelledError);
      expect(readdirSync(dappDir)).toEqual([]);
    } finally {
      rmSync(dappDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Regression: under tsx the inlined functions' text called esbuild's __name
// helper (an inner named arrow function), which the generated script lacks:
// every deploy failed with "__name is not defined".
describe('the functions the runner inlines into a script', () => {
  it('run on their own, in a context with nothing of this module\'s', async () => {
    const { runInNewContext } = await import('node:vm');
    const secret = runInNewContext(`${SCRIPT_PARTS.privateStateSecretFn}\nresolvePrivateStateSecretKey('ab'.repeat(32), undefined);`, { Uint8Array, parseInt });
    expect(Buffer.from(secret).toString('hex')).toBe('ab'.repeat(32));
    for (const fn of [SCRIPT_PARTS.privateStateSecretFn, SCRIPT_PARTS.privateStateStoreFn, SCRIPT_PARTS.coerceArgFn]) {
      expect(fn).not.toContain('__name');
      // A function given a name inside them is what keepNames wraps (vitest's transform doesn't, tsx's and bun's do).
      expect(fn.match(/(?:(?:const|let|var)\s+[\w$]+\s*=|[\w$]+\s*:)\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/g)).toBeNull();
      expect(fn.match(/(?:(?:const|let|var)\s+[\w$]+\s*=|[\w$]+\s*:)\s*(?:async\s+)?function\b/g)).toBeNull();
    }
    const store = runInNewContext(`${SCRIPT_PARTS.privateStateStoreFn}\nopenPrivateStateStore`, { JSON, String, Array, Error });
    await expect(store({}, { dir: '/x', storeName: 's', password: undefined, accountId: undefined })).rejects.toThrow(/MN_PRIVATE_STATE_PASSWORD/);
  });
});
