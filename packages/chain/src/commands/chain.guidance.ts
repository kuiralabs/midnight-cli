// What the chain package (the error codes its chain checks raise) tells agents:
// its pieces of `help --agent` and of the two skills, each
// naming its section and its place there.

import type { PackageGuidance } from '@kuiralabs/midnight-cli-core/lib/agent-guidance';

export const chainGuidance: PackageGuidance = {
  pieces: [
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 50,
      body: `  CHAIN_CLOCK_BEHIND      4     The chain's clock lags this computer's (a local
                                chain after sleep); wait for it or restart it
  UNSUPPORTED_LEDGER      4     The chain is on ledger 8; use mn 0.5.x for it
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 70,
      body: `  LOCAL_STACK_UNREACHABLE 4     No ledger-9 stack answers at the endpoints
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 30,
      body: `| \`UNSUPPORTED_LEDGER\` | The network is on ledger 8; this build supports ledger 9 only. | Tell the user: this network needs midnight-wallet-cli 0.5.x. Don't retry. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 50,
      body: `| \`LOCAL_STACK_UNREACHABLE\` | No ledger-9 stack answers at the configured endpoints. | Ask the user to start their stack or fix the configured node / indexer-ws / proof-server endpoints. |
`,
    },
  ],
  toolsTable: [
    { tool: 'midnight_tx_status', group: 'transactions', order: 50, description: ['What became of a transaction: block, fee, result'] },
  ],
};
