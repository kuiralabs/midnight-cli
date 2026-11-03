// A contract compiled for another compact runtime than the network's engine
// runs is refused up front, naming the compiler that engine needs.

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { classifyError } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { rcEngine } from '@kuiralabs/midnight-engine-rc';
import { assertContractRunsOn } from '../lib/contract/runtime-check.ts';
import { runDeploy } from '../lib/contract/runner.ts';

const contract = (runtimeVersion: string, compilerVersion = '0.30.0') => ({ name: 'counter', compilerVersion, runtimeVersion });
// A state root with no config: undeployed on the set the table names.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-runtime-check-root-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('the rc engine\'s compact runtime', () => {
  it('is the one it says, and takes contracts compiled for it, by the runtime\'s own rule', () => {
    const { scripts } = rcEngine.contracts;
    expect(scripts.compactRuntimeVersion).toBe('0.20.0');
    expect(scripts.compiler).toBe('compactc 0.35');
    expect(scripts.acceptsRuntime('0.20.0')).toBe(true);
    expect(scripts.acceptsRuntime('0.19.0')).toBe(false);
    expect(scripts.acceptsRuntime('0.16.0')).toBe(false);
    expect(scripts.acceptsRuntime('0.20.1')).toBe(false);
  });
});

describe('a contract for another compact runtime', () => {
  it('is refused as a usage mistake, naming both runtimes and the compiler to use', async () => {
    const refused = await assertContractRunsOn(contract('0.16.0'), 'undeployed', ROOT).then(() => undefined, (err: unknown) => err);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as Error).message).toBe(
      'counter was compiled by compactc 0.30.0 for compact-runtime 0.16.0, but undeployed runs contracts on compact-runtime 0.20.0.\nRecompile it with compactc 0.35.',
    );
    expect(classifyError(refused as Error).errorCode).toBe('INVALID_ARGS');
  });

  it('lets through one compiled for the engine\'s runtime, and one whose compiler recorded none', async () => {
    await expect(assertContractRunsOn(contract('0.20.0', '0.35.0'), 'undeployed', ROOT)).resolves.toBeUndefined();
    await expect(assertContractRunsOn(contract('unknown', 'unknown'), 'undeployed', ROOT)).resolves.toBeUndefined();
  });

  it('is refused by the runner too, before any script runs', async () => {
    const dappDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-runtime-check-'));
    try {
      const managedDir = path.join(dappDir, 'managed', 'counter');
      fs.mkdirSync(path.join(managedDir, 'compiler'), { recursive: true });
      fs.writeFileSync(path.join(managedDir, 'compiler', 'contract-info.json'), JSON.stringify({ 'compiler-version': '0.30.0', 'language-version': '0.22.0', 'runtime-version': '0.16.0', circuits: [], witnesses: [] }));
      const networkConfig = { indexer: 'http://127.0.0.1:1', indexerWS: 'ws://127.0.0.1:1', node: 'ws://127.0.0.1:1', proofServer: 'http://127.0.0.1:1', networkId: 'Undeployed' };
      await expect(runDeploy({ dappDir, network: 'undeployed', root: ROOT, networkConfig, managedDir, contractName: 'counter', servePort: 1 }))
        .rejects.toThrow('Recompile it with compactc 0.35.');
      // No script was written into the dApp.
      expect(fs.readdirSync(dappDir).filter((f) => f.endsWith('.mjs'))).toEqual([]);
    } finally {
      fs.rmSync(dappDir, { recursive: true, force: true });
    }
  });
});
