import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Inside this repository the workspace packages run from their source:
  // in what vite resolves (both kinds of module it runs tests as), in the
  // workers' own Node resolution, and in every process a test starts
  // (NODE_OPTIONS). Without all three, some imports load a package's build.
  resolve: { conditions: ['midnight-cli-source'] },
  ssr: { resolve: { conditions: ['midnight-cli-source'], externalConditions: ['midnight-cli-source'] } },
  test: {
    // Tests must never spawn the native dust-sync sidecar (it would make real
    // network calls / behave differently by machine). Force the WASM path; the
    // native bridge is covered directly by dust-sync-native.test.ts.
    // Likewise, local stack detection must not depend on what docker runs on
    // the machine; it's covered with captured docker output in local-stacks.test.ts.
    env: { MN_DISABLE_NATIVE_DUST: '1', MN_NO_LOCAL_DETECT: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=midnight-cli-source`.trim() },
    // Libraries read those variables, and the ones tests set, as settings the shell gives them.
    setupFiles: ['src/__tests__/helpers/shell-settings.ts'],
    // Tests seal and open wallets and accounts at their real cost (scrypt at
    // 128 MiB, the private state's own key derivation): a backup test takes
    // 3 s on a laptop, 8 s on a CI runner, and 32 s on a runner that was four
    // times slower at everything (npm ci included). Nothing hangs, but vitest's
    // default 5 s fails them; a test that does hang still fails here.
    poolOptions: {
      forks: { execArgv: ['--conditions=midnight-cli-source'] },
      threads: { execArgv: ['--conditions=midnight-cli-source'] },
    },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Nested checkouts under .claude/ run their own tests; count only this
    // checkout's.
    // Live tests read a running chain: `npm run test:live` runs them (vitest.live.config.ts), never `npm test`.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/*.live.test.ts'],
  },
});
