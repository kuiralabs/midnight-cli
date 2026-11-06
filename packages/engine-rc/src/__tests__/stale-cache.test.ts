// The rc engine's stale-cache error, the error-code parity table's row for it
// (src/__tests__/error-code-parity.test.ts lists every typed error where mn
// throws it; this one is the engine's own).
// Approved (Y52): an escaped stale cache reports STALE_CACHE, where it was UNKNOWN.

import { describe, expect, it } from 'vitest';
import { classifyError } from '@kuiralabs/midnight-cli-core';
import { StaleCacheError } from '../facade.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

describe("the rc engine's stale cache", () => {
  it('reports STALE_CACHE (exit 6) through its code, where the message alone gave UNKNOWN', () => {
    const err = new StaleCacheError('applied 120 of 80 events');
    expect(classifyError(err, CORE_CODES)).toStrictEqual({ exitCode: 6, errorCode: 'STALE_CACHE' });
  });
});
