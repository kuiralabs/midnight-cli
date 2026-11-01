// The `generate` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

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
      help: ['--mnemonic "..."    Restore from BIP-39 mnemonic (24 words)'],
    },
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>    Network: preprod, preview, undeployed'],
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
      address: 'Generated wallet address (bech32m)',
      network: 'Network name',
      seed: 'Hex-encoded seed (32-byte raw, or 64-byte if mnemonic-derived)',
      mnemonic: 'BIP-39 mnemonic (24 words, only if generated or provided)',
      file: 'Path where wallet file was saved',
      createdAt: 'ISO 8601 creation timestamp',
    },
  },
  needsWalletSdk: false,
  shell: { notice: '\n  Note: "midnight generate" is deprecated.\n  Use "midnight wallet generate <name>" instead.\n\n' },
  load: () => import('./generate.ts'),
  // Y29: the MCP server can load generate's handler, but its tool was removed (agents use midnight_wallet_generate).
  mcp: { tools: [] },
};
