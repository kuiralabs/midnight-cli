// The `tx` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core/lib/command-definition';
import { RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands/core.codes';

export const txDefinition: CommandDefinition = {
  name: 'tx',
  order: 167,
  subcommands: ['status'],
  flags: [
    {
      name: 'wait',
      takesValue: false,
      help: ['--wait                        Wait until the transaction is on chain, up to --timeout'],
      agent: { type: 'boolean', description: 'Wait until the transaction is on chain, up to timeout' },
    },
    {
      name: 'timeout',
      takesValue: true,
      help: ['--timeout <seconds>           How long --wait waits (default: 120)'],
      agent: { type: 'string', description: 'Seconds to wait (default 120)' },
    },
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>              Network (default: the selected one)'],
      agent: { ...NETWORK_PARAM, description: 'Network (default: the selected one)' },
    },
    {
      name: 'node',
      takesValue: true,
      help: ['--node <url>                  Node RPC endpoint (accepted like every command\'s; tx reads the indexer only)'],
      agent: ENDPOINT_PARAMS.node,
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>            Indexer WebSocket endpoint'],
      agent: ENDPOINT_PARAMS['indexer-ws'],
    },
    {
      name: 'proof-server',
      takesValue: true,
      help: ['--proof-server <url>          Proof server endpoint (accepted like every command\'s; unused)'],
      agent: ENDPOINT_PARAMS['proof-server'],
    },
  ],
  help: {
    description: 'What became of a transaction: its block, time, fee and result',
    usage: 'midnight tx status <hash or identifier> [options]',
    flags: [
      'status <hash or identifier>   A transaction by its hash (64 hex characters) or an identifier',
      '                              (66; the txHash mn prints after a submit). Found means final;',
      '                              not found means not on chain yet, dropped, or never sent',
      { flag: 'wait' },
      { flag: 'timeout' },
      { flag: 'network' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'proof-server' },
      '--json                        Output structured JSON',
    ],
    examples: [
      'midnight tx status 00408d0e…559086',
      'midnight tx status 00408d0e…559086 --wait --timeout 60 --json',
    ],
    jsonFields: {
      subcommand: 'The tx subcommand that ran',
      network: 'Network name',
      transaction: 'The hash or identifier asked about',
      state: '"final" (in a finalized block) or "notFound"',
      kind: '"regular" or "system" (final)',
      hash: 'The transaction\'s hash (final)',
      identifiers: 'The transaction\'s identifiers (final, regular)',
      result: '"SUCCESS", "PARTIAL_SUCCESS" or "FAILURE" (final, regular)',
      segments: 'Each segment\'s success, for a partial success',
      fee: 'The fee paid, in DUST, exact (final, regular; a failed transaction pays it too)',
      feeSpecks: 'The fee paid, in specks (final, regular)',
      blockHeight: 'The block\'s height (final)',
      blockHash: 'The block\'s hash (final)',
      blockTime: 'The block\'s time, ISO 8601 (final)',
    },
  },
  intro: { brief: 'What became of a transaction', order: 12.6 },
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, 'NETWORK_ERROR'] },
  load: () => import('./tx.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_tx_status',
        description: 'What became of a transaction, by its hash or identifier (the txHash a submit returns): its block, time, fee in DUST and result. Found means final; notFound means not on chain yet, dropped, or never sent.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [
          { name: 'transaction', schema: { type: 'string', description: 'The transaction\'s hash (64 hex) or identifier (66 hex)' } },
          { flag: 'wait' },
          { flag: 'timeout' },
          { flag: 'network' },
        ],
        required: ['transaction'],
        argv: { subcommand: 'status', positionals: ['transaction'], flags: 'rest' },
        order: 45,
      },
    ],
  },
};
