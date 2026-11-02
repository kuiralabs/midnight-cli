// `npm run test:live`: the tests that read a running chain, and only those.
// Each fails, naming what it needs, when the chain isn't there; none is skipped.
// The same environment and setup as `npm test` (vitest.config.ts).

import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  resolve: base.resolve,
  test: {
    ...base.test,
    include: ['src/**/*.live.test.ts'],
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
