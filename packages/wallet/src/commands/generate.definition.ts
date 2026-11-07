// The `generate` command, described once.

import { getValidNetworkNames, type CommandDefinition } from '@kuiralabs/midnight-cli-core';
import { LOADS_ENGINE, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { OPENS_WALLET } from './wallet.codes.ts';

export const generateDefinition: CommandDefinition = {
  name: 'generate',
  order: 20,
  flags: [
    {
      name: 'force',
      takesValue: false,
      help: ['--force             Overwrite existing wallet file'],
    },
    {
      name: 'mnemonic',
      takesValue: true,
      help: ['--mnemonic "..."    Restore from a BIP-39 mnemonic (12 to 24 words; a new wallet gets 24)'],
    },
    {
      name: 'network',
      takesValue: true,
      help: [`--network <name>    Network: ${getValidNetworkNames().join(', ')}`],
    },
    {
      name: 'output',
      takesValue: true,
      help: ['--output <file>     Custom output path (default: ~/.midnight/wallet.json)'],
    },
    {
      name: 'seed',
      takesValue: true,
      help: [
        '--seed <hex>        Restore from a seed: 64 or 128 hex chars (32-byte raw or 64-byte BIP-39)',
      ],
    },
  ],
  help: {
    description: '(Deprecated — use "midnight wallet generate <name>" instead)',
    usage: 'midnight generate [--network <name>] [--seed <hex>] [--mnemonic "..."] [--output <file>] [--force]',
    flags: [
      { flag: 'network' },
      { flag: 'seed' },
      { flag: 'mnemonic' },
      { flag: 'output' },
      { flag: 'force' },
    ],
    examples: ['midnight generate --network preprod'],
    jsonFields: {
      addresses: `Per-network unshielded addresses { ${getValidNetworkNames().join(', ')} }`,
      activeAddress: 'Unshielded address on the active network (bech32m)',
      activeNetwork: 'The active network',
      seed: 'Hex-encoded seed (32-byte raw, or 64-byte if mnemonic-derived)',
      mnemonic: 'BIP-39 mnemonic (24 words when generated; as given when restored)',
      file: 'Path where wallet file was saved',
      createdAt: 'ISO 8601 creation timestamp',
    },
  },
  needsWalletSdk: false,
  shell: { notice: '\n  Note: "midnight generate" is deprecated.\n  Use "midnight wallet generate <name>" instead.\n\n' },
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, 'NETWORK_ERROR'] },
  load: () => import('./generate.ts'),
  // The MCP server can load generate's handler, but its tool was removed (agents use midnight_wallet_generate).
  mcp: { tools: [] },
};
