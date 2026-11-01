// The `balance` command, described once (plan 2B, spec §4.1).

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM } from '../lib/command-definition.ts';

export const balanceDefinition: CommandDefinition = {
  name: 'balance',
  order: 40,
  flags: [
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded    Sync shielded even on preview/preprod (skipped by default — no faucet there)',
      ],
      agent: { type: 'boolean', description: 'With shielded: sync the shielded balance on preview/preprod too (skipped there by default)' },
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
      agent: { type: 'string', description: 'Seed to check instead of a wallet: 64 or 128 hex chars (32-byte raw or 64-byte BIP-39)' },
    },
    {
      name: 'shielded',
      takesValue: false,
      help: [
        '--shielded          Include shielded balance — needs the seed, so the address must be one of your wallets',
      ],
      agent: { type: 'boolean', description: 'Include the shielded balance (needs the seed: the wallet, or an address of one of your wallets)' },
    },
    {
      name: 'verbose',
      takesValue: false,
      // Its lines go to the server's stderr, which no agent reads, and it switches verbose on for the whole process (2F).
      agent: { notForAgents: 'diagnostics for a person at a terminal' },
    },
    { name: 'wallet', takesValue: true, agent: { type: 'string' } },
    { name: 'node', takesValue: true, agent: ENDPOINT_PARAMS.node },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>  Custom indexer WebSocket URL'],
      agent: { type: 'string' },
    },
    { name: 'proof-server', takesValue: true, agent: ENDPOINT_PARAMS['proof-server'] },
  ],
  help: {
    description: 'Check unshielded + shielded balance (full wallet sync)',
    usage: 'midnight balance [address] [--network <name>] [--indexer-ws <url>]',
    flags: [
      '<address>           Check a specific address (unshielded only, no wallet sync)',
      { flag: 'shielded' },
      { flag: 'force-shielded' },
      { flag: 'no-cache' },
      { flag: 'network' },
      { flag: 'indexer-ws' },
    ],
    examples: [
      'midnight balance',
      'midnight balance mn_addr_preprod1...',
      'midnight balance --wallet alice --shielded',
    ],
    jsonFields: {
      address: 'Unshielded address (bech32m)',
      shieldedAddress: 'Shielded address',
      network: 'Network name',
      unshielded: '{ NIGHT, utxoCount }',
      shielded: '{ NIGHT, availableCoins, pendingCoins }',
    },
  },
  intro: { brief: 'Check balance', order: 3 },
  needsWalletSdk: true,
  shell: {},
  load: () => import('./balance.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_balance',
        description: 'NIGHT balance. Default: { network, unshielded, shielded } — no echoed addresses. Pass { full: true } for the human shape including address + shieldedAddress.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [
          { name: 'address', schema: { type: 'string' } },
          { flag: 'wallet' },
          { flag: 'network' },
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
