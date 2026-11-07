// The `address` command, described once.

import { type CommandDefinition, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core';
import { LOADS_ENGINE, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { OPENS_WALLET } from './wallet.codes.ts';

export const addressDefinition: CommandDefinition = {
  name: 'address',
  order: 50,
  flags: [
    {
      name: 'index',
      takesValue: true,
      help: ['--index <n>         Key derivation index (default: 0)'],
      agent: { type: 'string' },
    },
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Network for address prefix (default: resolved)'],
      agent: NETWORK_PARAM,
    },
    {
      name: 'seed',
      takesValue: true,
      help: [
        '--seed <hex>        Seed to derive from: 64 or 128 hex chars (32-byte raw or 64-byte BIP-39); or set MN_SEED',
      ],
      agent: { type: 'string', description: '64 or 128 hex chars (32-byte raw or 64-byte BIP-39)' },
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name>     A saved wallet to derive from instead of a seed'],
      agent: { type: 'string', description: 'A saved wallet to derive from instead of a seed' },
    },
  ],
  help: {
    description: 'Derive and display an unshielded address from a seed or a saved wallet (one of --seed, MN_SEED or --wallet is needed)',
    usage: 'midnight address (--seed <hex> | --wallet <name>) [--network <name>] [--index <n>]',
    flags: [{ flag: 'seed' }, { flag: 'wallet' }, { flag: 'network' }, { flag: 'index' }],
    examples: [
      'midnight address --seed 0123456789abcdef... --network preprod',
      'midnight address --seed 0123456789abcdef... --index 1',
      'midnight address --wallet alice --network preview',
    ],
    jsonFields: {
      address: 'Derived address (bech32m)',
      network: 'Network name',
      index: 'Key derivation index',
      path: 'BIP-44 derivation path',
    },
  },
  intro: { brief: 'Derive address from a seed or wallet', order: 4 },
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, 'NETWORK_ERROR'] },
  load: () => import('./address.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_address',
        description: 'Derive an unshielded address from a saved wallet (wallet) or a seed (seed). Prefer wallet: a seed passed here is a secret in the conversation.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        params: [{ flag: 'wallet' }, { flag: 'seed' }, { flag: 'network' }, { flag: 'index' }],
        argv: { flags: 'rest' },
        order: 8,
      },
    ],
  },
};
