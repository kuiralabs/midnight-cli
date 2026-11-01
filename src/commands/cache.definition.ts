// The `cache` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const cacheDefinition: CommandDefinition = {
  name: 'cache',
  subcommands: ['clear'],
  flags: [
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Only clear cache for this network'],
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name|file> Only clear cache for this wallet'],
    },
  ],
  help: {
    description: 'Manage wallet state cache (clear cached sync data)',
    usage: 'midnight cache clear [--network <name>] [--wallet <name|file>]',
    flags: [
      'clear               Clear cached wallet state',
      { flag: 'network' },
      { flag: 'wallet' },
    ],
    examples: [
      'midnight cache clear',
      'midnight cache clear --network preprod',
      'midnight cache clear --wallet alice',
    ],
    jsonFields: {
      action: 'clear',
      scope: 'all, network, or wallet',
      network: 'Network name (when scoped)',
      wallet: 'Wallet name (when scoped)',
    },
  },
  intro: { brief: 'Manage wallet cache', order: 13 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./cache.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_cache_clear',
        description: 'Clear sync cache.',
        annotations: { destructiveHint: true, idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
            wallet: { type: 'string' },
          },
        },
        argv: { subcommand: 'clear', flags: 'rest' },
        order: 17,
      },
    ],
  },
};
