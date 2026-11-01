// The `info` command, described once.

import { type CommandDefinition, NETWORK_PARAM } from '../lib/command-definition.ts';

export const infoDefinition: CommandDefinition = {
  name: 'info',
  order: 30,
  flags: [
    {
      name: 'network',
      takesValue: true,
      agent: { ...NETWORK_PARAM, description: 'Network whose address is shown as active (default: the selected one)' },
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name|file> Wallet name or path'],
      agent: { type: 'string' },
    },
  ],
  help: {
    description: 'Display wallet address, network, creation date (no secrets shown)',
    usage: 'midnight info [--wallet <name|file>]',
    flags: [{ flag: 'wallet' }],
    examples: ['midnight info', 'midnight info --wallet my-wallet.json'],
    jsonFields: {
      addresses: 'Per-network unshielded addresses { preprod, preview, undeployed }',
      shieldedAddresses: 'Per-network shielded addresses { preprod, preview, undeployed }',
      activeNetwork: 'Currently active network',
      activeAddress: 'Unshielded address for active network (also written to stdout)',
      createdAt: 'ISO 8601 creation timestamp',
      file: 'Wallet file path',
    },
  },
  intro: { brief: 'Display wallet metadata', order: 2 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./info.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_info',
        description: 'Wallet metadata.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        params: [{ flag: 'wallet' }],
        argv: { flags: 'rest' },
        order: 6,
      },
    ],
  },
};
