// The `airdrop` command, described once (plan 2B, spec §4.1).

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM } from '../lib/command-definition.ts';

export const airdropDefinition: CommandDefinition = {
  name: 'airdrop',
  order: 80,
  flags: [
    {
      name: 'network',
      takesValue: true,
      agent: { ...NETWORK_PARAM, description: 'Network to fund on (default: the selected one; only undeployed has a genesis wallet)' },
    },
    {
      name: 'no-cache',
      takesValue: false,
      // The command refuses it: a write always syncs from the cache.
      agent: { notForAgents: 'refused by airdrop: writes always use the cache' },
    },
    {
      name: 'shielded',
      takesValue: false,
      help: ['--shielded           Airdrop shielded NIGHT (from genesis shielded balance)'],
      agent: { type: 'string', description: 'Set to "true" for shielded airdrop' },
    },
    {
      name: 'verbose',
      takesValue: false,
      // Its lines go to the server's stderr, which no agent reads, and it switches verbose on for the whole process (2F).
      agent: { notForAgents: 'diagnostics for a person at a terminal' },
    },
    {
      name: 'wallet',
      takesValue: true,
      help: [
        '--wallet <…>         Destination — a wallet name, a wallet JSON path, or',
        '                     a raw bech32m address (mn_addr_… / mn_shield-addr_…).',
        '                     Defaults to the active wallet when omitted.',
      ],
      agent: { type: 'string', description: 'Destination: wallet name, JSON path, or bech32m address' },
    },
    { name: 'node', takesValue: true, agent: ENDPOINT_PARAMS.node },
    { name: 'indexer-ws', takesValue: true, agent: ENDPOINT_PARAMS['indexer-ws'] },
    { name: 'proof-server', takesValue: true, agent: ENDPOINT_PARAMS['proof-server'] },
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
  shell: {},
  load: () => import('./airdrop.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_airdrop',
        description: 'Fund from genesis (undeployed). `wallet` accepts a wallet name, a wallet JSON path, or a raw bech32m address (mn_addr_… or mn_shield-addr_…). Add `shielded: "true"` to fund a shielded balance.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { name: 'amount', schema: { type: 'string', description: 'NIGHT' } },
          { flag: 'wallet' },
          { flag: 'shielded' },
        ],
        required: ['amount'],
        argv: { subcommand: { param: 'amount' }, flags: 'rest' },
        order: 11,
      },
    ],
  },
};
