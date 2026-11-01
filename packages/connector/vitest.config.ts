import { defineConfig } from 'vitest/config';

// The connector is a package of its own: its tests run without mn's test
// setup (the repository root's config, which vitest would otherwise use).
export default defineConfig({
  test: {},
});
