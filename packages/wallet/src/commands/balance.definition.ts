// The `balance` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from './wallet.codes.ts';

export const balanceDefinition: CommandDefinition = {
  name: 'balance',
  order: 40,
  flags: [
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded    Read the shielded balance on preview and preprod too: not read there by',
        '                    default, since the first read takes a while; a wallet can hold shielded tokens there',
      ],
      agent: { type: 'boolean', description: 'Read the shielded balance on preview and preprod too (not read there by default, since the first read takes a while; a wallet can hold shielded tokens there, minted by contracts)' },
    },
    { name: 'network', takesValue: true, help: ['--network <name>    Override network'], agent: NETWORK_PARAM },
    {
      name: 'no-cache',
      takesValue: false,
      help: ['--no-cache          Bypass wallet state cache (force a fresh sync)'],
      agent: { type: 'boolean', description: 'Bypass the wallet state cache (a fresh sync)' },
    },
    {
      name: 'seed',
      takesValue: true,
      help: ['--seed <hex>        Check the wallet of this seed instead of a saved one (or set MN_SEED)'],
      agent: { type: 'string', description: 'Seed to check instead of a wallet: 64 or 128 hex chars (32-byte raw or 64-byte BIP-39)' },
    },
    {
      name: 'shielded',
      takesValue: false,
      help: [
        '--shielded          With <address>: read its shielded balance too, from the wallet of yours that owns it',
        '                    (a wallet\'s own balance always includes shielded where it is read)',
      ],
      agent: { type: 'boolean', description: 'With an address: read its shielded balance too, from the wallet of yours that owns it (a wallet\'s own balance always includes shielded where it is read)' },
    },
    {
      name: 'verbose',
      takesValue: false,
      help: ['--verbose           Print diagnostic lines about the sync to stderr'],
      // Its lines go to the server's stderr, which no agent reads.
      agent: { notForAgents: 'diagnostics for a person at a terminal' },
    },
    { name: 'wallet', takesValue: true, help: ['--wallet <name|file>', '                    Wallet to check (default: the active wallet)'], agent: { type: 'string' } },
    { name: 'node', takesValue: true, help: ['--node <url>        Custom node RPC URL'], agent: ENDPOINT_PARAMS.node },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>  Custom indexer WebSocket URL'],
      agent: { type: 'string' },
    },
    { name: 'proof-server', takesValue: true, help: ['--proof-server <url>', '                    Accepted like the other endpoints; a balance read proves nothing'], agent: ENDPOINT_PARAMS['proof-server'] },
  ],
  help: {
    description: 'Check a wallet\'s unshielded + shielded balance, or an address\'s unshielded balance',
    usage: 'midnight balance [address] [--wallet <name|file> | --seed <hex>] [--shielded] [--force-shielded] [--network <name>] [--no-cache] [--node <url>] [--indexer-ws <url>] [--proof-server <url>] [--verbose]',
    flags: [
      '<address>           Check a specific address (unshielded only, no wallet sync)',
      { flag: 'wallet' },
      { flag: 'seed' },
      { flag: 'shielded' },
      { flag: 'force-shielded' },
      { flag: 'no-cache' },
      { flag: 'network' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'proof-server' },
      { flag: 'verbose' },
    ],
    examples: [
      'midnight balance',
      'midnight balance --wallet alice',
      'midnight balance mn_addr_preprod1...',
      'midnight balance mn_addr_preprod1... --shielded',
      'midnight balance --network preview --force-shielded',
    ],
    jsonFields: {
      address: 'Unshielded address (bech32m)',
      shieldedAddress: 'Shielded address',
      network: 'Network name',
      unshielded: '{ NIGHT, utxoCount }',
      shielded: '{ NIGHT, availableCoins, pendingCoins, tokens: { <raw token type>: amount } }',
    },
  },
  intro: { brief: 'Check balance', order: 3 },
  needsWalletSdk: true,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND'] },
  load: () => import('./balance.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_balance',
        description: 'NIGHT balance, and any other shielded tokens by raw type (shielded.tokens). Default: { network, unshielded, shielded } — no echoed addresses. Pass { full: true } for the human shape including address + shieldedAddress.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [
          { name: 'address', schema: { type: 'string' } },
          { flag: 'wallet' },
          { flag: 'network' },
          { flag: 'force-shielded' },
          { flag: 'indexer-ws' },
          {
            name: 'full',
            schema: {
              type: 'boolean',
              description: 'Include the queried address + shieldedAddress in the response (matches `mn balance --json`). Default false (slim).',
            },
          },
        ],
        argv: { subcommand: { param: 'address' }, flags: 'rest' },
        order: 7,
      },
    ],
  },
};
