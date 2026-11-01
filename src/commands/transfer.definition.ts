// The `transfer` command, described once (plan 2B, spec §4.1).

import { type CommandDefinition, confirmationTarget } from '../lib/command-definition.ts';

export const transferDefinition: CommandDefinition = {
  name: 'transfer',
  flags: [
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded    Allow --shielded on preview/preprod (blocked by default — no faucet there)',
      ],
    },
    { name: 'network', takesValue: true },
    { name: 'no-cache', takesValue: false },
    {
      name: 'shielded',
      takesValue: false,
      help: ['--shielded          Send from shielded balance to a shielded address'],
    },
    { name: 'verbose', takesValue: false },
    { name: 'wallet', takesValue: true, help: ['--wallet <name|file> Wallet name or path'] },
    {
      name: 'node',
      takesValue: true,
      help: ['--node <url>          Override substrate node RPC URL'],
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>    Override indexer WebSocket URL'],
    },
    {
      name: 'proof-server',
      takesValue: true,
      help: ['--proof-server <url>  Override proof server URL'],
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
  shell: { signal: true },
  load: () => import('./transfer.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_transfer',
        description: 'Send NIGHT (returns pending token; see skill).',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'bech32m' },
            amount: { type: 'string', description: 'NIGHT' },
            wallet: { type: 'string' },
          },
          required: ['to', 'amount'],
        },
        argv: { subcommand: { param: 'to' }, positionals: ['amount'], flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            return `Send ${params.amount} NIGHT from ${wallet} to ${params.to} on ${network}`;
          },
        },
        order: 12,
      },
    ],
  },
};
