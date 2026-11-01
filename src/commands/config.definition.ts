// The `config` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';
import { INDEXER_GRAPHQL_WS_PATH } from '../lib/constants.ts';

export const configDefinition: CommandDefinition = {
  name: 'config',
  subcommands: ['get', 'set', 'unset'],
  flags: [{ name: 'network', takesValue: true }],
  help: {
    description: 'Manage persistent config (default network, endpoints, etc.)',
    usage: 'midnight config <get|set|unset> <key> [value] [--network <name>]',
    flags: [
      'get <key>           Read a config value',
      'set <key> <value>   Write a config value',
      'unset <key>         Reset a config value to its default',
      '',
      'Keys: network, wallet, proof-server, node, indexer-ws,',
      '      blockfrost-project-id',
      '',
      'Endpoint keys (proof-server, node, indexer-ws) are scoped to a',
      'network: the selected one, or the one given with --network — a',
      'preprod node URL never applies to --network undeployed runs.',
      '',
      'blockfrost-project-id: preprod\'s indexer and node are served by Blockfrost,',
      'which needs your own project id (create a Midnight preprod project at',
      'https://blockfrost.io). It is filed under the network its prefix names,',
      'shown masked, and never printed. MN_BLOCKFROST_PROJECT_ID or',
      'BLOCKFROST_PROJECT_ID in the environment is used instead when set.',
    ],
    examples: [
      'midnight config get network',
      'midnight config set network preprod',
      'midnight config set wallet alice',
      'midnight config set blockfrost-project-id nightpreprod...',
      'midnight config set proof-server http://localhost:6300',
      'midnight config set node wss://rpc.preview.midnight.network',
      `midnight config set indexer-ws wss://indexer.preview.midnight.network${INDEXER_GRAPHQL_WS_PATH}`,
      'midnight config unset proof-server',
    ],
    jsonFields: { action: 'get, set, or unset', key: 'Config key name', value: 'Config value' },
  },
  intro: { brief: 'Manage CLI config', order: 13 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./config.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_config_get',
        description: 'Read config.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            network: {
              type: 'string',
              description: 'For node / indexer-ws / proof-server: the network to read or write them for (default: the selected network)',
            },
          },
          required: ['key'],
        },
        argv: { subcommand: 'get', positionals: ['key'], flags: ['network'] },
        order: 15,
      },
      {
        name: 'midnight_config_set',
        description: 'Write config.',
        annotations: { idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            network: {
              type: 'string',
              description: 'For node / indexer-ws / proof-server: the network to read or write them for (default: the selected network)',
            },
            value: { type: 'string' },
          },
          required: ['key', 'value'],
        },
        argv: { subcommand: 'set', positionals: ['key', 'value'], flags: ['network'] },
        order: 16,
      },
      {
        name: 'midnight_config_unset',
        description: 'Reset config.',
        annotations: { idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            network: {
              type: 'string',
              description: 'For node / indexer-ws / proof-server: the network to read or write them for (default: the selected network)',
            },
          },
          required: ['key'],
        },
        argv: { subcommand: 'unset', positionals: ['key'], flags: ['network'] },
        order: 18,
      },
    ],
  },
};
