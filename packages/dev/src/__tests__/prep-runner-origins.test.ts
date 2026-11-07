// The browser origins mn test's serve lets connect: the dApp page under test's, and no other.

import { describe, it, expect } from 'vitest';
import { dappPageOrigins } from '../lib/test/prep-runner.ts';

describe('dappPageOrigins', () => {
  // Regression: mn test's serve refused every browser page, so a browser suite's dApp could not reach the wallet.
  it('is the origin of the page a browser suite builds and serves (Vite\'s preview port by default)', () => {
    expect(dappPageOrigins({ name: 'd', prep: ['mn-serve', 'build-and-serve'] })).toEqual(['http://localhost:4173']);
    expect(dappPageOrigins({ name: 'd', prep: ['mn-serve', 'build-and-serve'], port: 3000 })).toEqual(['http://localhost:3000']);
  });

  it('is the origin of the URL the config names, path and all left out', () => {
    expect(dappPageOrigins({ name: 'd', prep: ['mn-serve'], url: 'http://127.0.0.1:5173/app/' })).toEqual(['http://127.0.0.1:5173']);
  });

  it('is none for a suite with no page: the serve refuses every browser', () => {
    expect(dappPageOrigins({ name: 'd', prep: ['mn-serve'] })).toEqual([]);
    expect(dappPageOrigins({ name: 'd', prep: ['mn-serve'], port: 3000 })).toEqual([]);
  });
});
