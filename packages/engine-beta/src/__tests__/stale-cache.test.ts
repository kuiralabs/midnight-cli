// The beta engine's stale-cache error, as the rc engine's stale-cache.test.ts
// checks the rc engine's: in a file of its own, since one process loads one SDK set.
// Approved (Y52): an escaped stale cache reports STALE_CACHE, where it was UNKNOWN.

import { describe, expect, it } from 'vitest';
import { classifyError } from '@kuiralabs/midnight-cli-core';
import { StaleCacheError } from '../facade.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

describe("the beta engine's stale cache", () => {
  it('reports STALE_CACHE (exit 6) through its code, where the message alone gave UNKNOWN', () => {
    const err = new StaleCacheError('applied 120 of 80 events');
    expect(classifyError(err, CORE_CODES)).toStrictEqual({ exitCode: 6, errorCode: 'STALE_CACHE' });
  });
});
