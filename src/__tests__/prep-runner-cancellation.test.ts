// A cancelled `mn test run` starts no further prep step. The steps here need
// no chain: a cancel stops the run before the step would reach one.

import { describe, expect, it } from 'vitest';
import { runPrepSteps } from '../lib/test/prep-runner.ts';
import { createPrepContext, type DappTestConfig } from '../lib/test/types.ts';
import { createSdkWarningRouter } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import { CancelledError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { createHost } from '@kuiralabs/midnight-cli-core/lib/host';

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
