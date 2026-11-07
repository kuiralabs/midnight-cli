// The `test` command, described once.

import { type CommandDefinition, NETWORK_PARAM, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { RUNS_CONTRACTS } from '@kuiralabs/midnight-contract/commands';
import { OPENS_WALLET } from '@kuiralabs/midnight-wallet/commands';

export const testDefinition: CommandDefinition = {
  name: 'test',
  order: 140,
  subcommands: ['create', 'run', 'list', 'results'],
  flags: [
    {
      name: 'all',
      takesValue: false,
      subcommands: ['results'],
      help: ['--all                         Show all results (with results subcommand)'],
    },
    {
      name: 'browser-mode',
      takesValue: true,
      subcommands: ['create'],
      help: [
        '--browser-mode <m>            Browser strategy: dom (HTML UIs, fast — default), vision (canvas games), script (advanced)',
      ],
      agent: { type: 'string', enum: ['dom', 'vision', 'script'], description: 'Browser strategy only — how Claude perceives the page. dom (HTML/React UIs, fast, needs chrome-devtools-mcp), vision (canvas games, slow), script (advanced, needs hooks). Default: dom for AI scaffolds.' },
    },
    {
      name: 'build-cmd',
      takesValue: true,
      subcommands: ['create'],
      help: ['--build-cmd <cmd>             Browser strategy: build/serve command'],
      agent: { type: 'string', description: 'Browser strategy only — shell command that builds + serves the UI (e.g. "npm run dev").' },
    },
    {
      name: 'build-dir',
      takesValue: true,
      subcommands: ['create'],
      help: [
        '--build-dir <subdir>          Browser strategy: subdirectory the build runs in (monorepo case)',
      ],
      agent: { type: 'string', description: 'Browser strategy only — subdir the build runs in (monorepo case).' },
    },
    {
      name: 'force',
      takesValue: false,
      subcommands: ['create'],
      help: ['--force                       Overwrite existing scaffold files (create)'],
      agent: { type: 'boolean', description: 'Overwrite existing files instead of aborting on collision' },
    },
    {
      name: 'goal',
      takesValue: true,
      subcommands: ['create'],
      help: ['--goal "<text>"               AI scaffolding: the one-line success criterion the suite verifies (create)'],
      agent: { type: 'string', description: 'AI mode: one-line success criterion this suite should verify (e.g. "round goes from 0 to 1 after increment"). Triggers AI scaffolding.' },
    },
    {
      name: 'name',
      takesValue: true,
      subcommands: ['create'],
      help: [
        '--name <contract>             Specific contract name in multi-contract projects (create)',
      ],
      agent: { type: 'string', description: 'Specific contract name when the project has multiple' },
    },
    {
      name: 'network',
      takesValue: true,
      // run takes its network from dapp.test.json.
      subcommands: ['create'],
      help: ['--network <name>              Network for the generated suite (create; default: undeployed)'],
      agent: NETWORK_PARAM,
    },
    {
      name: 'no-ai',
      takesValue: false,
      subcommands: ['create'],
      help: ['--no-ai                       Use the deterministic scaffolder even when the claude CLI is there (create)'],
      agent: { type: 'boolean', description: 'Force deterministic scaffolder even when claude CLI is available.' },
    },
    {
      name: 'path',
      takesValue: true,
      // run and results find the dApp from the working directory.
      subcommands: ['create'],
      help: ['--path <dir>                  dApp directory (create; default: cwd)'],
      agent: { type: 'string', description: 'dApp directory (defaults to cwd)' },
    },
    {
      name: 'port',
      takesValue: true,
      subcommands: ['create'],
      help: [
        '--port <n>                    Browser strategy: dev server port (create --strategy ui)',
      ],
      agent: { type: 'string', description: 'Browser strategy only — dev server port (e.g. "4173").' },
    },
    {
      name: 'redeploy',
      takesValue: false,
      subcommands: ['run'],
      help: ['--redeploy                    Deploy the contract again instead of reusing the cached address (run)'],
    },
    {
      name: 'screen',
      takesValue: true,
      subcommands: ['create'],
      help: ['--screen <name>               AI scaffolding, browser strategy: the screen component to focus on (create)'],
      agent: { type: 'string', description: 'AI mode + browser strategy: name of the screen component to focus on (e.g. "loan-request-form" or "LoanRequestForm"). Auto-discovered from src/components, src/pages, src/screens.' },
    },
    {
      name: 'strategy',
      takesValue: true,
      subcommands: ['create'],
      help: [
        '--strategy cli|ui             Scaffold strategy (create — interactive prompt if omitted)',
      ],
      agent: { type: 'string', enum: ['cli', 'browser'], description: 'cli (default): drive contracts via actions.json. browser: drive a real UI via Claude + Chrome via prompt.md.' },
    },
    {
      name: 'suite',
      takesValue: true,
      subcommands: ['run', 'create', 'results'],
      help: ['--suite <name>                Select a specific test suite (run, create, results)'],
      agent: { type: 'string', description: 'Suite directory name under tests/suites/ (auto-derived from circuit/screen when AI scaffolds)' },
    },
    {
      name: 'url',
      takesValue: true,
      subcommands: ['create'],
      help: [
        '--url <url>                   Browser strategy: full URL Claude opens (default http://localhost:<port>/)',
      ],
      agent: { type: 'string', description: 'Browser strategy only — full URL Claude opens (default http://localhost:<port>/).' },
    },
    // Accepted, but test reads none of them (a run resolves endpoints from dapp.test.json's network).
    { name: 'node', takesValue: true, help: ['--node, --indexer-ws, --proof-server', '                              Accepted but unused: a run takes its network from dapp.test.json'], agent: { notForAgents: 'test reads no endpoint flag: a run takes its network from dapp.test.json' } },
    { name: 'indexer-ws', takesValue: true, agent: { notForAgents: 'test reads no endpoint flag: a run takes its network from dapp.test.json' } },
    { name: 'proof-server', takesValue: true, agent: { notForAgents: 'test reads no endpoint flag: a run takes its network from dapp.test.json' } },
  ],
  help: {
    description: 'Generate and run E2E test suites for Midnight dApps',
    usage: 'midnight test <create|run|list|results> [options]',
    flags: [
      'create                        Generate a test scaffold from the contract (CLI or browser strategy)',
      'run                           Run test suites for the current dApp',
      'list                          List available test suites',
      'results                       Show latest test results',
      { flag: 'suite' },
      { flag: 'all' },
      { flag: 'strategy' },
      { flag: 'name' },
      { flag: 'path' },
      { flag: 'network' },
      { flag: 'port' },
      { flag: 'build-cmd' },
      { flag: 'build-dir' },
      { flag: 'url' },
      { flag: 'browser-mode' },
      { flag: 'force' },
      { flag: 'goal' },
      { flag: 'screen' },
      { flag: 'no-ai' },
      { flag: 'redeploy' },
      { flag: 'node' },
      '--json                        Output structured JSON',
    ],
    examples: [
      'midnight test create',
      'midnight test create --strategy cli --force',
      'midnight test create --strategy ui --port 4173 --build-cmd "npm run dev"',
      'midnight test run',
      'midnight test run --suite e2e-gameplay',
      'midnight test list',
      'midnight test results --all --json',
    ],
    jsonFields: {
      dapp: 'DApp name from dapp.test.json',
      suite: 'Test suite name',
      status: 'Overall result: pass, fail, timeout, or error',
      duration: 'Total duration in seconds',
      prep: 'Array of prep step results',
      assertions: 'Array of assertion results',
    },
  },
  intro: { brief: 'Run dApp E2E tests', order: 17 },
  needsWalletSdk: true,
  shell: {},
  errors: {
    codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND', RUNS_CONTRACTS, 'SERVE_PORT_IN_USE', 'NO_TEST_CONFIG', 'MAINNET_REFUSED'],
    // `test run` returns it when a test fails, with the results as its JSON (COMMAND_FAILED under MCP).
    outcomes: [{ exitCode: EXIT_GENERAL_ERROR, when: 'A test failed' }],
  },
  load: () => import('./test.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_test_create',
        description: 'Generate a test scaffold for the contract. Two paths: (1) AI-assisted — pass `goal` (and optionally `screen` for UI strategy) and the scaffold is generated by Claude reading the contract + screen source, producing a focused suite with realistic args / on-screen labels. (2) Deterministic — pass `no-ai: true` (or omit goal/screen in non-interactive mode) for boilerplate scaffolds that the user reviews. CLI strategy emits dapp.test.json + tests/suites/<name>/{suite,actions,assertions}.json. Browser strategy emits prompt.md instead of actions.json plus the browser fields in dapp.test.json — required: port, build-cmd. Use force:true to overwrite.',
        annotations: { destructiveHint: true },
        params: [
          { flag: 'path' },
          { flag: 'name' },
          { flag: 'suite' },
          { flag: 'strategy' },
          { flag: 'network' },
          { flag: 'goal' },
          { flag: 'screen' },
          { flag: 'no-ai' },
          { flag: 'port' },
          { flag: 'build-cmd' },
          { flag: 'build-dir' },
          { flag: 'url' },
          { flag: 'browser-mode' },
          { flag: 'force' },
        ],
        argv: { subcommand: 'create', flags: 'rest' },
        order: 36,
      },
    ],
  },
};
