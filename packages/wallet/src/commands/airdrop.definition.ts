// The `airdrop` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, LOCAL_WALLET_FUNDING_NIGHT, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from './wallet.codes.ts';

export const airdropDefinition: CommandDefinition = {
  name: 'airdrop',
  order: 80,
  flags: [
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>     Network to fund on (default: the selected one; only undeployed has a genesis wallet)'],
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
      agent: { type: 'boolean', description: 'Airdrop shielded NIGHT (from the genesis shielded balance)' },
    },
    {
      name: 'verbose',
      takesValue: false,
      help: ['--verbose            Print diagnostic lines about the sync to stderr'],
      // Its lines go to the server's stderr, which no agent reads.
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
    { name: 'node', takesValue: true, help: ['--node <url>         Node RPC endpoint'], agent: ENDPOINT_PARAMS.node },
    { name: 'indexer-ws', takesValue: true, help: ['--indexer-ws <url>   Indexer WebSocket endpoint'], agent: ENDPOINT_PARAMS['indexer-ws'] },
    { name: 'proof-server', takesValue: true, help: ['--proof-server <url> Proof server endpoint'], agent: ENDPOINT_PARAMS['proof-server'] },
  ],
  help: {
    description: 'Fund a wallet from the genesis wallet (undeployed network only)',
    usage: 'midnight airdrop <amount> [--shielded] [--wallet <name|file|address>] [--network <name>] [--node <url>] [--indexer-ws <url>] [--proof-server <url>] [--verbose]',
    flags: [
      '<amount>             Amount in NIGHT to airdrop',
      { flag: 'shielded' },
      { flag: 'wallet' },
      { flag: 'network' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'proof-server' },
      { flag: 'verbose' },
    ],
    examples: [
      `midnight airdrop ${LOCAL_WALLET_FUNDING_NIGHT}`,
      'midnight airdrop 1000 --wallet alice',
      'midnight airdrop 10000 --wallet mn_addr_undeployed1...',
      'midnight airdrop 100 --shielded',
      'midnight airdrop 100 --shielded --wallet mn_shield-addr_undeployed1...',
    ],
    jsonFields: {
      txHash: 'The transaction\'s identifier (midnight tx status takes it)',
      receipt: 'The transaction once the indexer lists it: blockHeight, blockHash, blockTime, fee (DUST, exact), feeSpecks, result; null when it has not within 60 s',
      receiptMissing: 'Why receipt is null; check later with midnight tx status <txHash>',
      amount: 'Amount airdropped (NIGHT string)',
      recipient: 'Recipient address (the shielded address with --shielded)',
      shieldedAddress: 'The same shielded address as recipient (--shielded airdrop; kept for older readers)',
      network: 'Network name',
    },
  },
  intro: { brief: 'Fund from genesis wallet', order: 7 },
  needsWalletSdk: true,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND', 'MAINNET_REFUSED'] },
  load: () => import('./airdrop.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_airdrop',
        description: 'Fund from genesis (undeployed). `wallet` accepts a wallet name, a wallet JSON path, or a raw bech32m address (mn_addr_… or mn_shield-addr_…). Add `shielded: true` to fund a shielded balance.',
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
