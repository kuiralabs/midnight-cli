// A cancelled `mn test run` starts no further prep step. The steps here need
// no chain: a cancel stops the run before the step would reach one.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrepSteps } from '../lib/test/prep-runner.ts';
import { createPrepContext, type DappTestConfig } from '../lib/test/types.ts';
import { createSdkWarningRouter, CancelledError, classifyError, createHost } from '@kuiralabs/midnight-cli-core';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';
import { devCodes } from '../commands/dev.codes.ts';
import { codeRegistry } from '../../../../test-support/core-codes.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

// The host the tests' calls run in: nobody to ask, notices dropped.
const host = createHost();

const config = { network: 'undeployed', prep: ['dust', 'mn-serve'] } as unknown as DappTestConfig;

describe('runPrepSteps', () => {
  it('starts no step once the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const started: string[] = [];
    await expect(runPrepSteps(config, '/nonexistent', createPrepContext('/nonexistent/.midnight', host, createSdkWarningRouter().openCall().warnings, controller.signal), {
      onStepStart: (step) => started.push(step),
      onStepComplete: () => {},
      onMessage: () => {},
    })).rejects.toBeInstanceOf(CancelledError);
    expect(started).toEqual([]);
  });
});

// The error-code parity table's row for a prep step (src/__tests__/error-code-parity.test.ts
// lists every typed error where mn throws it; this one is the test runner's own).
describe('a prep step that failed with no code, in the error-code parity table', () => {
  // A state root of the test's own, never ~/.midnight, with the engines mn ships.
  const root = mkdtempSync(join(tmpdir(), 'mn-prep-parity-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports UNKNOWN, exit 1, as before codes were owned per package', async () => {
    const err = await runPrepSteps({ network: 'undeployed', prep: ['no-such-step'] } as unknown as DappTestConfig, root, createPrepContext(root, createHost({ paths: { stateRoot: root, home: root }, engineLoader: loadInstalledEngine }), createSdkWarningRouter().openCall().warnings, new AbortController().signal), { onStepStart: () => {}, onStepComplete: () => {}, onMessage: () => {} })
      .then(() => { throw new Error('expected the prep step to fail'); }, (e: Error) => e);
    expect(classifyError(err, codeRegistry(coreCodes, devCodes))).toStrictEqual({ errorCode: 'UNKNOWN', exitCode: 1 });
  });
});
