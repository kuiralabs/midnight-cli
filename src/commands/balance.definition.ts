// The `balance` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const balanceDefinition: CommandDefinition = {
  name: 'balance',
  flags: [
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded    Sync shielded even on preview/preprod (skipped by default — no faucet there)',
      ],
    },
    { name: 'network', takesValue: true, help: ['--network <name>    Override network'] },
    {
      name: 'no-cache',
      takesValue: false,
      help: ['--no-cache          Bypass wallet state cache (force a fresh sync)'],
    },
    { name: 'seed', takesValue: true },
    {
      name: 'shielded',
      takesValue: false,
      help: [
        '--shielded          Include shielded balance — needs the seed, so the address must be one of your wallets',
      ],
    },
    { name: 'verbose', takesValue: false },
    { name: 'wallet', takesValue: true },
    { name: 'node', takesValue: true },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>  Custom indexer WebSocket URL'],
    },
    { name: 'proof-server', takesValue: true },
  ],
  help: {
    description: 'Check unshielded + shielded balance (full wallet sync)',
    usage: 'midnight balance [address] [--network <name>] [--indexer-ws <url>]',
    flags: [
      '<address>           Check a specific address (unshielded only, no wallet sync)',
      { flag: 'shielded' },
      { flag: 'force-shielded' },
      { flag: 'no-cache' },
      { flag: 'network' },
      { flag: 'indexer-ws' },
    ],
    examples: [
      'midnight balance',
      'midnight balance mn_addr_preprod1...',
      'midnight balance --wallet alice --shielded',
    ],
    jsonFields: {
      address: 'Unshielded address (bech32m)',
      shieldedAddress: 'Shielded address',
      network: 'Network name',
      unshielded: '{ NIGHT, utxoCount }',
      shielded: '{ NIGHT, availableCoins, pendingCoins }',
    },
  },
  intro: { brief: 'Check balance', order: 3 },
  needsWalletSdk: true,
  shell: {},
  load: () => import('./balance.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_balance',
        description: 'NIGHT balance. Default: { network, unshielded, shielded } — no echoed addresses. Pass { full: true } for the human shape including address + shieldedAddress.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            wallet: { type: 'string' },
            network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
            'indexer-ws': { type: 'string' },
            full: {
              type: 'boolean',
              description: 'Include the queried address + shieldedAddress in the response (matches `mn balance --json`). Default false (slim).',
            },
          },
        },
        argv: { subcommand: { param: 'address' }, flags: 'rest' },
        order: 7,
      },
    ],
  },
};
