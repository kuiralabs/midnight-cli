// The `transfer` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM, confirmationTarget } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from './wallet.codes.ts';

export const transferDefinition: CommandDefinition = {
  name: 'transfer',
  order: 90,
  flags: [
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded    Allow --shielded on preview, preprod and stagenet, where the shielded',
        '                    wallet is not synced by default (the first sync takes a while)',
      ],
      agent: { type: 'boolean', description: 'With shielded: allow it on preview, preprod and stagenet, where the shielded wallet is not synced by default (the first sync takes a while)' },
    },
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Network to send on (default: the selected one)'],
      agent: { ...NETWORK_PARAM, description: 'Network to send on (default: the selected one)' },
    },
    {
      name: 'no-cache',
      takesValue: false,
      // The command refuses it: a write always syncs from the cache.
      agent: { notForAgents: 'refused by transfer: writes always use the cache' },
    },
    {
      name: 'shielded',
      takesValue: false,
      help: ['--shielded          Send from shielded balance to a shielded address'],
      agent: { type: 'boolean', description: 'Send from the shielded balance to a shielded address' },
    },
    {
      name: 'verbose',
      takesValue: false,
      help: ['--verbose           Print diagnostic lines about the sync to stderr'],
      // Its lines go to the server's stderr, which no agent reads.
      agent: { notForAgents: 'diagnostics for a person at a terminal' },
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name|file> Wallet name or path'],
      agent: { type: 'string' },
    },
    {
      name: 'node',
      takesValue: true,
      help: ['--node <url>          Override substrate node RPC URL'],
      agent: ENDPOINT_PARAMS.node,
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>    Override indexer WebSocket URL'],
      agent: ENDPOINT_PARAMS['indexer-ws'],
    },
    {
      name: 'proof-server',
      takesValue: true,
      help: ['--proof-server <url>  Override proof server URL'],
      agent: ENDPOINT_PARAMS['proof-server'],
    },
  ],
  help: {
    description: 'Send NIGHT tokens to another address (unshielded or --shielded)',
    usage: 'midnight transfer <to> <amount> [--shielded [--force-shielded]] [--wallet <name|file>] [--network <name>] [--proof-server <url>] [--node <url>] [--indexer-ws <url>] [--verbose]',
    flags: [
      '<to>                Recipient bech32m address (unshielded or shielded)',
      '<amount>            Amount in NIGHT to send',
      { flag: 'shielded' },
      { flag: 'force-shielded' },
      { flag: 'wallet' },
      { flag: 'network' },
      { flag: 'proof-server' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'verbose' },
    ],
    examples: [
      'midnight transfer mn_addr_undeployed1... 100',
      'midnight transfer mn_shield-addr_undeployed1... 50 --shielded',
    ],
    jsonFields: {
      txHash: 'The transaction\'s identifier (midnight tx status takes it)',
      receipt: 'The transaction once the indexer lists it: blockHeight, blockHash, blockTime, fee (DUST, exact), feeSpecks, result; null when it has not within 60 s',
      receiptMissing: 'Why receipt is null; check later with midnight tx status <txHash>',
      amount: 'Amount transferred (NIGHT string)',
      recipient: 'Recipient address (bech32m)',
      network: 'Network name',
    },
  },
  intro: { brief: 'Send NIGHT tokens', order: 8 },
  needsWalletSdk: true,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND'] },
  load: () => import('./transfer.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_transfer',
        description: 'Send NIGHT (returns pending token; see skill).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { name: 'to', schema: { type: 'string', description: 'bech32m' } },
          { name: 'amount', schema: { type: 'string', description: 'NIGHT' } },
          { flag: 'wallet' },
        ],
        required: ['to', 'amount'],
        argv: { subcommand: { param: 'to' }, positionals: ['amount'], flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            return `Send ${params.amount} NIGHT from ${wallet} to ${params.to} on ${network}`;
          },
          async check(_params, call) {
            const { resolveTransferRequest } = await import('../lib/transfer-request.ts');
            await resolveTransferRequest(call.argv(), call.host.paths().stateRoot, call.host);
          },
        },
        order: 12,
      },
    ],
  },
};
