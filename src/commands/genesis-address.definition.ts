// The `genesis-address` command, described once.

import { type CommandDefinition, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core/lib/command-definition';
import { LOADS_ENGINE, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands/core.codes';

export const genesisAddressDefinition: CommandDefinition = {
  name: 'genesis-address',
  order: 60,
  flags: [
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Network for address prefix (default: resolved)'],
      agent: NETWORK_PARAM,
    },
  ],
  help: {
    description: 'Display the genesis wallet address (seed 0x01) for a network',
    usage: 'midnight genesis-address [--network <name>]',
    flags: [{ flag: 'network' }],
    examples: [
      'midnight genesis-address --network undeployed',
      'midnight genesis-address --network preprod',
    ],
    jsonFields: { address: 'Genesis wallet address (bech32m)', network: 'Network name' },
  },
  intro: { brief: 'Show genesis address', order: 5 },
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, LOADS_ENGINE, 'NETWORK_ERROR'] },
  load: () => import('./genesis-address.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_genesis_address',
        description: 'Genesis address.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        params: [{ flag: 'network' }],
        argv: { flags: 'rest' },
        order: 9,
      },
    ],
  },
};
