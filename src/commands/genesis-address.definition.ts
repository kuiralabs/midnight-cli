// The `genesis-address` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const genesisAddressDefinition: CommandDefinition = {
  name: 'genesis-address',
  flags: [
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Network for address prefix (default: resolved)'],
    },
  ],
  help: {
    description: 'Display the genesis wallet address (seed 0x01) for a network',
    usage: 'midnight genesis-address [--network <name>]',
    flags: [{ flag: 'network' }],
    examples: [
      'midnight genesis-address --network undeployed',
      'midnight genesis-address --network preprod',
    ],
    jsonFields: { address: 'Genesis wallet address (bech32m)', network: 'Network name' },
  },
  intro: { brief: 'Show genesis address', order: 5 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./genesis-address.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_genesis_address',
        description: 'Genesis address.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: { network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] } },
        },
        argv: { flags: 'rest' },
        order: 9,
      },
    ],
  },
};
