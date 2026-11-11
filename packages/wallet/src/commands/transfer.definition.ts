// The `transfer` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM, confirmationTarget, nightAmountText, parseAmount, UsageError } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from './wallet.codes.ts';
import { assertRecipientCount, MAX_TRANSFER_RECIPIENTS } from '../lib/transfer-recipients.ts';

export const transferDefinition: CommandDefinition = {
  name: 'transfer',
  order: 90,
  flags: [
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded    Allow --shielded on preview and preprod, where the shielded',
        '                    wallet is not synced by default (the first sync takes a while)',
      ],
      agent: { type: 'boolean', description: 'With shielded: allow it on preview and preprod, where the shielded wallet is not synced by default (the first sync takes a while)' },
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
      name: 'to-file',
      takesValue: true,
      help: [
        '--to-file <file>    Read the recipients from a JSON file instead of pairs:',
        '                    [{"to": "alice", "amount": "10"}, {"to": "mn_addr_...", "amount": "2.5"}]',
      ],
      // The tool takes the list itself, as recipients.
      agent: { notForAgents: 'midnight_transfer takes the list as its recipients parameter' },
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
    description: 'Send NIGHT tokens to another address, or to several in one transaction (unshielded or --shielded)',
    usage: 'midnight transfer <to> <amount> [<to> <amount> ...] | --to-file <file> [--shielded [--force-shielded]] [--wallet <name|file>] [--network <name>] [--proof-server <url>] [--node <url>] [--indexer-ws <url>] [--verbose]',
    flags: [
      '<to>                Recipient: a bech32m address (unshielded or shielded) or a wallet name',
      '<amount>            Amount in NIGHT to send',
      `<to> <amount> ...   More pairs pay more recipients in the same transaction (at most ${MAX_TRANSFER_RECIPIENTS})`,
      { flag: 'to-file' },
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
      'midnight transfer alice 10 bob 5 mn_addr_undeployed1... 2.5',
      'midnight transfer --to-file payments.json',
    ],
    jsonFields: {
      txHash: 'The transaction\'s identifier (midnight tx status takes it)',
      receipt: 'The transaction once the indexer lists it: blockHeight, blockHash, blockTime, fee (DUST, exact), feeSpecks, result; null when it has not within 60 s',
      receiptMissing: 'Why receipt is null; check later with midnight tx status <txHash>',
      amount: 'Amount transferred (NIGHT string); with several recipients, their total',
      recipient: 'Recipient address (bech32m); with one recipient only',
      recipients: 'With several recipients: each as { recipient, amount }, in order, plus selfTransfer: true on one that is the sending wallet itself',
      network: 'Network name',
      type: '"shielded" with --shielded (absent otherwise)',
      selfTransfer: 'With one recipient: true when it is the sending wallet itself (absent otherwise)',
      note: 'With selfTransfer: the NIGHT paid to the sending wallet itself stays in it',
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
          {
            name: 'recipients',
            schema: {
              type: 'array',
              description: `Instead of to/amount: up to ${MAX_TRANSFER_RECIPIENTS}, one tx`,
              items: { type: 'object', properties: { to: { type: 'string' }, amount: { type: 'string' } }, required: ['to', 'amount'] },
            },
          },
          { flag: 'wallet' },
        ],
        argv: { subcommand: { param: 'to' }, positionals: ['amount'], pairs: { param: 'recipients', fields: ['to', 'amount'] }, flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            const recipients = params.recipients as readonly { to: unknown; amount: unknown }[] | undefined;
            if (recipients === undefined) return `Send ${params.amount} NIGHT from ${wallet} to ${params.to} on ${network}`;
            // The check parsed every amount before this runs.
            const total = recipients.reduce((sum, { amount }) => sum + parseAmount(String(amount)), 0n);
            const each = recipients.map(({ to, amount }) => `${amount} NIGHT to ${to}`).join(', ');
            return `Send ${nightAmountText(total)} NIGHT in all from ${wallet} on ${network}, in one transaction: ${each}`;
          },
          async check(params, call) {
            if (params.recipients !== undefined && (params.to !== undefined || params.amount !== undefined)) {
              throw new UsageError('Give either to and amount, or recipients, not both.');
            }
            // An empty list maps to no words, which the command would call a missing recipient.
            if (Array.isArray(params.recipients)) assertRecipientCount(params.recipients.length);
            const { resolveTransferRequest } = await import('../lib/transfer-request.ts');
            await resolveTransferRequest(call.argv(), call.host.paths().stateRoot, call.host);
          },
        },
        order: 12,
      },
    ],
  },
};
