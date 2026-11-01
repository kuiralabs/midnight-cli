// The `transfer` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM, confirmationTarget } from '../lib/command-definition.ts';

export const transferDefinition: CommandDefinition = {
  name: 'transfer',
  order: 90,
  flags: [
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded    Allow --shielded on preview/preprod (blocked by default — no faucet there)',
      ],
      agent: { type: 'boolean', description: 'With shielded: allow it on preview/preprod (blocked there by default)' },
    },
    {
      name: 'network',
      takesValue: true,
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
    usage: 'midnight transfer <to> <amount> [--shielded] [--wallet <name|file>] [--proof-server <url>] [--node <url>] [--indexer-ws <url>]',
    flags: [
      '<to>                Recipient bech32m address (unshielded or shielded)',
      '<amount>            Amount in NIGHT to send',
      { flag: 'shielded' },
      { flag: 'force-shielded' },
      { flag: 'wallet' },
      { flag: 'proof-server' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
    ],
    examples: [
      'midnight transfer mn_addr_undeployed1... 100',
      'midnight transfer mn_shield-addr_undeployed1... 50 --shielded',
    ],
    jsonFields: {
      txHash: 'Transaction hash',
      amount: 'Amount transferred (NIGHT string)',
      recipient: 'Recipient address (bech32m)',
      network: 'Network name',
    },
  },
  intro: { brief: 'Send NIGHT tokens', order: 8 },
  needsWalletSdk: true,
  shell: {},
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
            resolveTransferRequest(call.argv());
          },
        },
        order: 12,
      },
    ],
  },
};
