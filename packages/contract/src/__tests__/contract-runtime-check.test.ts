// A contract compiled for another compact runtime than the network's engine
// runs is refused up front, naming the compiler that engine needs.

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UsageError, classifyError, contractKeysFromSeed, createHost } from '@kuiralabs/midnight-cli-core';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';
import { contractCodes } from '../commands/contract.codes.ts';
import { codeRegistry } from '../../../../test-support/core-codes.ts';
import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { assertContractRunsOn } from '../lib/contract/runtime-check.ts';
import { runDeploy } from '../lib/contract/runner.ts';

// What the shell classifies a contract run's errors by: core's codes and contract's.
const CONTRACT_CODES = codeRegistry(coreCodes, contractCodes);

// An rc engine, for what every host's has alike: its keys, ledger and contracts.
const rcEngine = createRcEngine(createHost());
// The engines the checks load the network's engine from: a host's of the engines the CLI ships.
const { engines } = createHost({ engineLoader: loadInstalledEngine });

const contract = (runtimeVersion: string, compilerVersion = '0.30.0') => ({ name: 'counter', compilerVersion, runtimeVersion });
// A state root with no config: undeployed on the set the table names.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-runtime-check-root-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('the rc engine\'s compact runtime', () => {
  it('is the one it says, and takes contracts compiled for it, by the runtime\'s own rule', () => {
    const { scripts } = rcEngine.contracts;
    expect(scripts.compactRuntimeVersion).toBe('0.21.0');
    expect(scripts.compiler).toBe('compactc 0.36');
    expect(scripts.acceptsRuntime('0.21.0')).toBe(true);
    expect(scripts.acceptsRuntime('0.20.0')).toBe(false);
    expect(scripts.acceptsRuntime('0.19.0')).toBe(false);
    expect(scripts.acceptsRuntime('0.16.0')).toBe(false);
    expect(scripts.acceptsRuntime('0.21.1')).toBe(false);
  });
});

describe('a contract for another compact runtime', () => {
  it('is refused as a usage mistake, naming both runtimes and the compiler to use', async () => {
    const refused = await assertContractRunsOn(contract('0.16.0'), 'undeployed', ROOT, engines).then(() => undefined, (err: unknown) => err);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as Error).message).toBe(
      'counter was compiled by compactc 0.30.0 for compact-runtime 0.16.0, but undeployed runs contracts on compact-runtime 0.21.0.\nRecompile it with compactc 0.36.',
    );
    expect(classifyError(refused as Error, CONTRACT_CODES).errorCode).toBe('INVALID_ARGS');
  });

  it('lets through one compiled for the engine\'s runtime, and one whose compiler recorded none', async () => {
    await expect(assertContractRunsOn(contract('0.21.0', '0.36.0'), 'undeployed', ROOT, engines)).resolves.toBeUndefined();
    await expect(assertContractRunsOn(contract('unknown', 'unknown'), 'undeployed', ROOT, engines)).resolves.toBeUndefined();
  });

  it('is refused by the runner too, before any script runs', async () => {
    const dappDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-runtime-check-'));
    try {
      const managedDir = path.join(dappDir, 'managed', 'counter');
      fs.mkdirSync(path.join(managedDir, 'compiler'), { recursive: true });
      fs.writeFileSync(path.join(managedDir, 'compiler', 'contract-info.json'), JSON.stringify({ 'compiler-version': '0.30.0', 'language-version': '0.22.0', 'runtime-version': '0.16.0', circuits: [], witnesses: [] }));
      const networkConfig = { indexer: 'http://127.0.0.1:1', indexerWS: 'ws://127.0.0.1:1', node: 'ws://127.0.0.1:1', proofServer: 'http://127.0.0.1:1', networkId: 'Undeployed' };
      await expect(runDeploy({ dappDir, network: 'undeployed', root: ROOT, engines, networkConfig, managedDir, contractName: 'counter', servePort: 1, contractKeys: contractKeysFromSeed(Buffer.alloc(32, 1)) }))
        .rejects.toThrow('Recompile it with compactc 0.36.');
      // No script was written into the dApp.
      expect(fs.readdirSync(dappDir).filter((f) => f.endsWith('.mjs'))).toEqual([]);
    } finally {
      fs.rmSync(dappDir, { recursive: true, force: true });
    }
  });
});
