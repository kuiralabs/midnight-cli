// The `inspect-cost` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const inspectCostDefinition: CommandDefinition = {
  name: 'inspect-cost',
  flags: [
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>              Network to read (default: the selected one)'],
      agent: { type: 'string', description: 'Network to read (default: the selected one)' },
    },
    { name: 'node', takesValue: true },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>            Indexer to read the latest block from'],
    },
    { name: 'proof-server', takesValue: true },
  ],
  help: {
    description: 'Display the chain\'s current block limits, from its latest block\'s ledger parameters',
    usage: 'midnight inspect-cost [--network <name>] [--node <url>] [--indexer-ws <url>] [--proof-server <url>]',
    flags: [{ flag: 'network' }, { flag: 'indexer-ws' }],
    examples: ['midnight inspect-cost', 'midnight inspect-cost --network undeployed --json'],
    jsonFields: {
      network: 'Network the limits were read from',
      height: 'Block whose ledger parameters the limits come from',
      readTime: 'Read time limit (picoseconds)',
      computeTime: 'Compute time limit (picoseconds)',
      blockUsage: 'Block usage limit (bytes)',
      bytesWritten: 'Bytes written limit (bytes)',
      bytesChurned: 'Bytes churned limit (bytes)',
    },
  },
  intro: { brief: 'Display block limits', order: 6 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./inspect-cost.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_inspect_cost',
        description: 'The chain\'s current block limits, from its latest block\'s ledger parameters.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        params: [{ flag: 'network' }],
        argv: { flags: ['network'] },
        order: 10,
      },
    ],
  },
};
