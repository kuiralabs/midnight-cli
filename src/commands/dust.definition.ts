// The `dust` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM } from '../lib/command-definition.ts';

export const dustDefinition: CommandDefinition = {
  name: 'dust',
  order: 100,
  subcommands: ['register', 'status', 'export'],
  flags: [
    { name: 'network', takesValue: true, agent: { ...NETWORK_PARAM, description: 'Network (default: the selected one)' } },
    {
      name: 'no-cache',
      takesValue: false,
      subcommands: ['status'],
      help: ['--no-cache            Bypass wallet state cache (status only)'],
      agent: { type: 'boolean', description: 'Bypass the wallet state cache (a fresh sync)' },
    },
    {
      name: 'seed',
      takesValue: true,
      subcommands: ['export'],
      help: [
        '--seed <hex>          64 or 128 hex chars, 32-byte raw or 64-byte BIP-39 (export only; or set MN_SEED env to keep it off argv)',
      ],
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
      // Help says register only, but every subcommand resolves its network with it (src/commands/dust.ts).
      name: 'node',
      takesValue: true,
      help: ['--node <url>          Override substrate node RPC URL (register only)'],
      agent: ENDPOINT_PARAMS.node,
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>    Override indexer WebSocket URL'],
      agent: ENDPOINT_PARAMS['indexer-ws'],
    },
    {
      // Help says register only, but every subcommand resolves its network with it (src/commands/dust.ts).
      name: 'proof-server',
      takesValue: true,
      help: ['--proof-server <url>  Override proof server URL (register only)'],
      agent: ENDPOINT_PARAMS['proof-server'],
    },
  ],
  help: {
    description: 'Register UTXOs for dust (fee token) generation, check status, or export a restorable snapshot',
    usage: 'midnight dust <register|status|export> [--wallet <name|file>] [--seed <hex> (export only)] [--proof-server <url>] [--node <url>] [--indexer-ws <url>] [--no-cache (status only)]',
    flags: [
      'register            Register NIGHT UTXOs for dust generation',
      'status              Check dust registration; if registered, also shows dust balance',
      'export              Fast-sync dust and emit a restorable snapshot (dustSerializedState)',
      { flag: 'wallet' },
      { flag: 'seed' },
      { flag: 'proof-server' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'no-cache' },
      '',
      'Native dust sidecar: not used on this ledger-9 build (it is built for ledger 8);',
      '  MN_DUST_SYNC_BIN and MN_DISABLE_NATIVE_DUST are ignored. Dust sync runs in WASM.',
    ],
    examples: [
      'midnight dust register',
      'midnight dust status',
      'midnight dust export --json',
      'midnight dust export --seed <hex> --json',
    ],
    jsonFields: {
      subcommand: 'register, status, or export',
      registered: 'true if at least one NIGHT UTXO is registered for dust generation (status only)',
      registeredUtxos: 'Number of registered UTXOs (status only)',
      unregisteredUtxos: 'Number of unregistered UTXOs (status only)',
      dustBalance: 'Dust balance (raw bigint string; status when registered, register, and export)',
      nightBalance: 'NIGHT balance (raw bigint string; status only when registered)',
      dustAvailable: 'Whether dust tokens are available (status only when registered)',
      txHash: 'Registration transaction hash (register only, if submitted)',
      dustPublicKey: 'Dust public key hex the snapshot belongs to (export only)',
      offset: 'Last dust event id the snapshot covers, -1 if none (export only)',
      snapshot: 'Facade-restorable dust snapshot JSON — pass as the SDK dustSerializedState (export only)',
    },
  },
  intro: { brief: 'Manage dust (fee tokens)', order: 9 },
  needsWalletSdk: true,
  shell: {},
  load: () => import('./dust.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_dust_register',
        description: 'Register for dust.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [{ flag: 'wallet' }],
        argv: { subcommand: 'register', flags: 'rest' },
        order: 13,
      },
      {
        name: 'midnight_dust_status',
        description: 'Dust status. Default: { network, registered, registeredUtxos, unregisteredUtxos, dustBalance, dustAvailable }. Pass { full: true } for sync internals (eventsApplied, ownedUtxos, cached).',
        annotations: { readOnlyHint: true, openWorldHint: true },
        // As this tool showed them before tool schemas came from the flags.
        params: [
          { flag: 'wallet' },
          { flag: 'proof-server', schema: { type: 'string' } },
          { flag: 'node', schema: { type: 'string' } },
          { flag: 'indexer-ws', schema: { type: 'string' } },
          { flag: 'no-cache', schema: { type: 'string' } },
          {
            name: 'full',
            schema: {
              type: 'boolean',
              description: 'Include sync internals (eventsApplied, ownedUtxos, cached) in the response (matches `mn dust status --json`). Default false (slim).',
            },
          },
        ],
        argv: { subcommand: 'status', flags: 'rest' },
        order: 14,
      },
    ],
  },
};
