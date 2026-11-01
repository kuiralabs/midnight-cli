// The `airdrop` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const airdropDefinition: CommandDefinition = {
  name: 'airdrop',
  flags: [
    { name: 'network', takesValue: true },
    { name: 'no-cache', takesValue: false },
    {
      name: 'shielded',
      takesValue: false,
      help: ['--shielded           Airdrop shielded NIGHT (from genesis shielded balance)'],
    },
    { name: 'verbose', takesValue: false },
    {
      name: 'wallet',
      takesValue: true,
      help: [
        '--wallet <…>         Destination — a wallet name, a wallet JSON path, or',
        '                     a raw bech32m address (mn_addr_… / mn_shield-addr_…).',
        '                     Defaults to the active wallet when omitted.',
      ],
    },
    { name: 'node', takesValue: true },
    { name: 'indexer-ws', takesValue: true },
    { name: 'proof-server', takesValue: true },
  ],
  help: {
    description: 'Fund a wallet from the genesis wallet (undeployed network only)',
    usage: 'midnight airdrop <amount> [--shielded] [--wallet <name|file|address>]',
    flags: [
      '<amount>             Amount in NIGHT to airdrop',
      { flag: 'shielded' },
      { flag: 'wallet' },
    ],
    examples: [
      'midnight airdrop 1000',
      'midnight airdrop 1000 --wallet alice',
      'midnight airdrop 10000 --wallet mn_addr_undeployed1...',
      'midnight airdrop 100 --shielded',
      'midnight airdrop 100 --shielded --wallet mn_shield-addr_undeployed1...',
    ],
    jsonFields: {
      txHash: 'Transaction hash',
      amount: 'Amount airdropped (NIGHT string)',
      recipient: 'Recipient address (unshielded airdrop)',
      shieldedAddress: 'Shielded address (--shielded airdrop)',
      network: 'Network name',
    },
  },
  intro: { brief: 'Fund from genesis wallet', order: 7 },
  needsWalletSdk: true,
  shell: { signal: true },
  load: () => import('./airdrop.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_airdrop',
        description: 'Fund from genesis (undeployed). `wallet` accepts a wallet name, a wallet JSON path, or a raw bech32m address (mn_addr_… or mn_shield-addr_…). Add `shielded: "true"` to fund a shielded balance.',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            amount: { type: 'string', description: 'NIGHT' },
            wallet: {
              type: 'string',
              description: 'Destination: wallet name, JSON path, or bech32m address',
            },
            shielded: { type: 'string', description: 'Set to "true" for shielded airdrop' },
          },
          required: ['amount'],
        },
        argv: { subcommand: { param: 'amount' }, flags: 'rest' },
        order: 11,
      },
    ],
  },
};
