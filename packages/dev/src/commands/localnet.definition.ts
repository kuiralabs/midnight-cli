// The `localnet` command, described once.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core';
import { LOADS_ENGINE, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';

export const localnetDefinition: CommandDefinition = {
  name: 'localnet',
  order: 180,
  subcommands: ['up', 'stop', 'down', 'status', 'logs', 'clean'],
  flags: [
    {
      name: 'tail',
      takesValue: true,
      subcommands: ['logs'],
      agent: { type: 'string', description: 'Number of lines to retrieve (default 200)' },
    },
  ],
  help: {
    description: 'Manage a local Midnight network via Docker Compose (up is refused on this ledger-9 build)',
    usage: 'midnight localnet <up|stop|down|status|logs|clean>',
    flags: [
      'up              Refused on this build: mn\'s compose stack is ledger 8, and no',
      '                published indexer image runs ledger 9 yet. Run a ledger-9 stack',
      '                yourself and point mn at it with --node/--indexer-ws/--proof-server',
      '                or midnight config set node|indexer-ws|proof-server <url>',
      'stop            Stop containers (preserves state for fast restart)',
      'down            Full teardown: containers, networks, volumes, + undeployed wallet cache',
      'status          Show service status and ports',
      'logs            Stream service logs (Ctrl+C to stop)',
      'clean           Remove mn\'s own localnet containers (any others named',
      '                node / indexer / proof-server are left alone and listed)',
    ],
    examples: [
      'midnight localnet status',
      'midnight localnet stop',
      'midnight localnet down',
      'midnight localnet clean',
    ],
    jsonFields: {
      subcommand: 'up, stop, down, status, or clean',
      services: 'Array of { name, state, port, health? } (up/status only)',
      status: 'Operation result message (stop/down/clean)',
      removed: 'Array of removed container names (clean only)',
      kept: 'Array of { name, project } containers with those names that are not mn\'s, left alone (clean only)',
    },
  },
  intro: { brief: 'Manage local network', order: 15 },
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, LOADS_ENGINE, 'NETWORK_ERROR', 'SYNC_TIMEOUT', 'LOCALNET_UNAVAILABLE'] },
  load: () => import('./localnet.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_localnet_up',
        description: 'Refused on this ledger-9 build: mn\'s localnet is ledger 8 and no ledger-9 indexer image is published. Run a ledger-9 stack yourself and point mn at it (config_set node / indexer-ws / proof-server).',
        annotations: { openWorldHint: true },
        params: [],
        argv: { subcommand: 'up', flags: [] },
        order: 19,
      },
      {
        name: 'midnight_localnet_stop',
        description: 'Stop localnet (preserves state).',
        annotations: { idempotentHint: true, openWorldHint: true },
        params: [],
        argv: { subcommand: 'stop', flags: [] },
        order: 20,
      },
      {
        name: 'midnight_localnet_down',
        description: 'Localnet teardown (volumes + undeployed cache).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [],
        argv: { subcommand: 'down', flags: [] },
        order: 21,
      },
      {
        name: 'midnight_localnet_status',
        description: 'Localnet status.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [],
        argv: { subcommand: 'status', flags: [] },
        order: 22,
      },
      {
        name: 'midnight_localnet_clean',
        description: 'Remove stray containers.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [],
        argv: { subcommand: 'clean', flags: [] },
        order: 23,
      },
      {
        name: 'midnight_localnet_logs',
        description: 'Snapshot of recent localnet logs (last N lines per service, no streaming). Returns { tail, lines: string[] }.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [{ flag: 'tail' }],
        argv: { subcommand: 'logs', flags: 'rest', defaultFlags: { tail: '200' } },
        order: 37,
      },
    ],
  },
};
