// What the dev package (localnet, test and dev) tells agents:
// its pieces of `help --agent` and of the two skills, each naming its section
// and its place there, and its tools' rows in the manual's tools table.

import type { PackageGuidance } from '../lib/agent-guidance.ts';

export const devGuidance: PackageGuidance = {
  pieces: [
    {
      text: 'agent-manual',
      section: 'e2e-testing',
      order: 10,
      body: `E2E TESTING
───────────

  midnight test run [--suite <name>] [--json]
  midnight test list [--json]
  midnight test results [--all] [--json]

Runs E2E tests for Midnight dApps defined in dapp.test.json. Includes
contract deployment, circuit calls, and state verification.

`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 60,
      body: `  LOCALNET_UNAVAILABLE    4     localnet up can't start a ledger-9 stack; run
                                one and set its endpoints (config set)
`,
    },
    {
      text: 'agent-manual',
      section: 'typical-workflows',
      order: 20,
      body: `  Contract development (CLI only — not an MCP tool):
  Run "mn dev" in a Compact project. It checks the local network is up,
  provisions 3 funded wallets (dev-alice/dev-bob/dev-carol), compiles on
  save, and accepts a "d" keystroke to deploy the current artifact with
  dev-alice. See "mn help dev". On this ledger-9 build it uses a ledger-9
  stack you run (configured endpoints) instead of starting one.

`,
    },
    {
      text: 'skill-core',
      section: 'intent-routing',
      order: 20,
      body: `| "Start localnet" / "start a local network" | Refused on this build: explain, and point the user at running a ledger-9 stack (see \`/full\`) |
| "Stop localnet" | \`midnight_localnet_stop()\` |
| "Show localnet logs" / "what's the indexer doing" | \`midnight_localnet_logs({ tail: "200" })\` |
`,
    },
    {
      text: 'skill-core',
      section: 'intent-routing',
      order: 40,
      body: `| "Generate tests for this contract" / "scaffold a test suite" | \`midnight_test_create({ path })\` (default cli; pass \`strategy: "browser"\` + \`port\` + \`build-cmd\` for UI tests) |
`,
    },
    {
      text: 'skill-full',
      section: 'intent-routing',
      order: 20,
      body: `| "Start localnet" / "start a local network" | Explain that \`midnight_localnet_up()\` is refused on this ledger-9 build; the user runs a ledger-9 stack and points mn at it (see the note at the top) |
| "Stop localnet" | \`midnight_localnet_stop()\` |
`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 60,
      body: `### User wants to scaffold tests for a contract
Use \`midnight_test_create({ path, strategy })\`. Strategies:
- \`"cli"\` (default) — emits \`dapp.test.json\` + \`tests/suites/cli-default/{suite,actions,assertions}.json\` with deploy → state → one call per impure circuit → state. Placeholder args; user reviews and edits before \`mn test run\`.
- \`"browser"\` — additionally needs \`port\` and \`build-cmd\`; emits \`prompt.md\` instead of \`actions.json\`. Claude drives the UI per \`prompt.md\`.

Running a suite is a CLI command, not an MCP tool: \`mn test run --suite <name>\` (exit code 0 on PASS, 1 on FAIL; \`--json\` prints the result, \`mn test results\` shows the last one). Browser strategy supports \`browserMode: "vision"\` (screenshots — default), \`"dom"\` (accessibility tree, faster, requires \`chrome-devtools-mcp\`), \`"script"\` (direct JS, fastest, requires \`chrome-devtools-mcp\`). Pre-flight detects missing \`chrome-devtools-mcp\` and orphan automation Chromes from prior crashes.

`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 40,
      body: `| \`LOCALNET_UNAVAILABLE\` | \`midnight_localnet_up()\` can't start a ledger-9 stack on this build. | Ask the user to start their ledger-9 stack and point mn at it (endpoint config). |
`,
    },
    {
      text: 'skill-full',
      section: 'not-this-cli',
      order: 10,
      body: `- Not a contract compiler. The project's \`package.json\` should expose a \`compact\` script (Midnight convention, e.g. \`"compact": "compact compile src/foo.compact src/managed/foo"\`) or a \`compile\` script as a generic fallback. \`mn dev\` detects whichever is present; create-mn-app and midnight-starship templates ship with the \`compact\` script already wired.
`,
    },
  ],
  toolsTable: [
    { tool: 'midnight_localnet_up', group: 'local-network', order: 10, description: ['Refused on this ledger-9 build (see OVERVIEW)'] },
    { tool: 'midnight_localnet_stop', group: 'local-network', order: 20, description: ['Stop local network (preserves state)'] },
    { tool: 'midnight_localnet_down', group: 'local-network', order: 30, description: ['Full teardown (volumes + undeployed cache)'] },
    { tool: 'midnight_localnet_status', group: 'local-network', order: 40, description: ['Show service status and ports'] },
    { tool: 'midnight_localnet_clean', group: 'local-network', order: 50, description: ['Remove conflicting containers'] },
    { tool: 'midnight_localnet_logs', group: 'local-network', order: 60, description: ['Snapshot of recent logs from each service'] },
    { tool: 'midnight_test_create', group: 'test-framework', order: 10, description: ['Generate a CLI or browser test scaffold from the', 'compiled contract'], params: ['path, strategy,', 'port, build-cmd'] },
  ],
};
