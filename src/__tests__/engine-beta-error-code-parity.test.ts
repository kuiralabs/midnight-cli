// The beta engine's stale-cache error, as error-code-parity.test.ts checks the
// rc engine's: in a file of its own, since one process loads one SDK set.
// Approved (Y52): an escaped stale cache reports STALE_CACHE, where it was UNKNOWN.

import { describe, expect, it } from 'vitest';
import { classifyError } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { StaleCacheError } from '@kuiralabs/midnight-engine-beta/facade';
import { installedCommands } from '../lib/installed-commands.ts';

describe("the beta engine's stale cache", () => {
  it('reports STALE_CACHE (exit 6) through the installed codes, where the message alone gave UNKNOWN', () => {
    const err = new StaleCacheError('applied 120 of 80 events');
    expect(classifyError(err)).toStrictEqual({ exitCode: 1, errorCode: 'UNKNOWN' });
    expect(classifyError(err, installedCommands)).toStrictEqual({ exitCode: 6, errorCode: 'STALE_CACHE' });
  });
});
