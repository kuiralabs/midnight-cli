// The `dust` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from './wallet.codes.ts';

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
      // Help says register only, but every subcommand resolves its network with it (commands/dust.ts).
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
      // Help says register only, but every subcommand resolves its network with it (commands/dust.ts).
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
      'Native dust reader: Dust syncs run the native dust-sync sidecar',
      '  (@kuiralabs/dust-sync-<os>-<arch>, built on ledger 9) when it reports ledger 9',
      '  and the chain is past its fork; otherwise, or if it fails, the WASM reader',
      '  syncs (on a hosted network mn says so). MN_DUST_SYNC_BIN=<path> runs a binary',
      '  of your own; MN_DISABLE_NATIVE_DUST=1 always uses the WASM reader.',
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
      network: 'The network read or registered on (status, register, export)',
      dustBalance: 'Dust balance in DUST, a decimal string with 6 to 15 places, e.g. "12.500000" (status when registered, register, and export)',
      dustAvailable: 'Whether dust tokens are available (status only when registered)',
      eventsApplied: 'Dust events applied by this read: all of them on a cold read, the new ones on a read from the cache (status when registered; not in slim output)',
      ownedUtxos: 'Dust UTXOs the wallet owns (status when registered; not in slim output)',
      cached: 'Whether a cache took part in the read (mn\'s Dust cache on disk, or one already read in this process); false only for a cold read from the first event (status when registered; not in slim output)',
      eventCount: 'Dust events applied by this export: all of them on a cold read, the new ones when it extended mn\'s cache (export only)',
      fromCache: 'Whether the export extended mn\'s Dust cache; false when it synced from the first event (export only)',
      partial: 'true when the sync stopped before the chain tip: the snapshot is incomplete; export again to finish it (export only)',
      txHash: 'The registration transaction\'s identifier (register only, if submitted; midnight tx status takes it)',
      dustNeeds: 'What the Dust is ready for once registered (register only): `transfer` and `counterDeploy`, each `{dust, waitSeconds}` (what it takes in DUST, and the seconds until the wallet has it: 0 now, null not within a day; a counter contract\'s deploy is a guide, `contract deploy --dry-run` prices one), and `generatedPerSecond` (DUST a second)',
      receipt: 'The transaction once the indexer lists it: blockHeight, blockHash, blockTime, fee (DUST, exact), feeSpecks, result; null when it has not within 60 s (register, if submitted)',
      receiptMissing: 'Why receipt is null; check later with midnight tx status <txHash>',
      dustPublicKey: 'Dust public key hex the snapshot belongs to (export only)',
      offset: 'Last dust event id the snapshot covers, -1 if none (export only)',
      snapshot: 'Facade-restorable dust snapshot JSON — pass as the SDK dustSerializedState (export only)',
    },
  },
  intro: { brief: 'Manage dust (fee tokens)', order: 9 },
  needsWalletSdk: true,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND'] },
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
          { flag: 'no-cache' },
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
