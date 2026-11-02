// The `cache` command, described once.

import { type CommandDefinition, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core/lib/command-definition';

export const cacheDefinition: CommandDefinition = {
  name: 'cache',
  order: 120,
  subcommands: ['clear'],
  flags: [
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Only clear cache for this network'],
      agent: NETWORK_PARAM,
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name|file> Only clear cache for this wallet'],
      agent: { type: 'string' },
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
  intro: { brief: 'Manage wallet cache', order: 14 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./cache.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_cache_clear',
        description: 'Clear sync cache.',
        annotations: { destructiveHint: true, idempotentHint: true },
        params: [{ flag: 'network' }, { flag: 'wallet' }],
        argv: { subcommand: 'clear', flags: 'rest' },
        order: 17,
      },
    ],
  },
};
