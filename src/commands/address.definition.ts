// The `address` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const addressDefinition: CommandDefinition = {
  name: 'address',
  flags: [
    {
      name: 'index',
      takesValue: true,
      help: ['--index <n>         Key derivation index (default: 0)'],
    },
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Network for address prefix (default: resolved)'],
    },
    {
      name: 'seed',
      takesValue: true,
      help: [
        '--seed <hex>        Seed to derive from (required): 64 or 128 hex chars (32-byte raw or 64-byte BIP-39)',
      ],
    },
    { name: 'wallet', takesValue: true },
  ],
  help: {
    description: 'Derive and display an unshielded address from a seed',
    usage: 'midnight address --seed <hex> [--network <name>] [--index <n>]',
    flags: [{ flag: 'seed' }, { flag: 'network' }, { flag: 'index' }],
    examples: [
      'midnight address --seed 0123456789abcdef... --network preprod',
      'midnight address --seed 0123456789abcdef... --index 1',
    ],
    jsonFields: {
      address: 'Derived address (bech32m)',
      network: 'Network name',
      index: 'Key derivation index',
      path: 'BIP-44 derivation path',
    },
  },
  intro: { brief: 'Derive address from seed', order: 4 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./address.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_address',
        description: 'Derive address from seed.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            seed: { type: 'string', description: '64 or 128 hex chars (32-byte raw or 64-byte BIP-39)' },
            network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
            index: { type: 'string' },
          },
          required: ['seed'],
        },
        argv: { flags: 'rest' },
        order: 8,
      },
    ],
  },
};
