// The `wallet` command, described once.

import { getValidNetworkNames, type CommandDefinition, NETWORK_PARAM } from '@kuiralabs/midnight-cli-core';
import { LOADS_ENGINE, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { OPENS_WALLET } from './wallet.codes.ts';

export const walletDefinition: CommandDefinition = {
  name: 'wallet',
  order: 10,
  subcommands: ['generate', 'list', 'use', 'info', 'remove', 'seed', 'protect'],
  subcommandAliases: { ls: 'list', rm: 'remove' },
  flags: [
    {
      name: 'entropy',
      takesValue: false,
      subcommands: ['seed'],
      help: [
        '--entropy           Also output the 32-byte BIP-39 entropy alongside the',
        '                    64-byte PBKDF2 seed (use when another tool expects',
        '                    the shorter entropy format — NB: the two derive',
        '                    DIFFERENT Midnight wallets from the same mnemonic)',
      ],
    },
    {
      name: 'force',
      takesValue: false,
      subcommands: ['generate'],
      help: ['--force             Overwrite existing wallet file'],
      agent: { type: 'boolean', description: 'Replace an existing wallet of that name (asks for confirmation: its seed is deleted)' },
    },
    {
      name: 'mnemonic',
      takesValue: true,
      subcommands: ['generate'],
      help: ['--mnemonic "..."    Restore from BIP-39 mnemonic (24 words)'],
      agent: { type: 'string', description: 'BIP-39 24 words' },
    },
    {
      name: 'network',
      takesValue: true,
      // list and info show the addresses for it.
      subcommands: ['generate', 'list', 'info'],
      help: [`--network <name>    Network: ${getValidNetworkNames().join(', ')}`],
      agent: NETWORK_PARAM,
    },
    {
      name: 'seed',
      takesValue: true,
      subcommands: ['generate'],
      help: [
        '--seed <hex>        Restore from a seed: 64 or 128 hex chars (32-byte raw or 64-byte BIP-39)',
      ],
      agent: { type: 'string', description: '64 or 128 hex chars (32-byte raw or 64-byte BIP-39)' },
    },
    { name: 'wallet', takesValue: true, subcommands: ['info', 'seed'] },
  ],
  help: {
    description: 'Manage named wallets (generate, list, use, info, remove, seed, protect)',
    usage: 'midnight wallet <generate|list|use|info|remove|seed|protect> [args]',
    flags: [
      'generate <name>     Create a new named wallet and set it as active',
      'list                Show all wallets with active marker',
      'use <name>          Set active wallet',
      'info [name]         Show wallet details (active wallet if no name)',
      'remove <name>       Delete a wallet (refuses active or last wallet)',
      'seed [name]         Reveal the seed + mnemonic (prompts for confirmation)',
      'protect             Set mn\'s passphrase and encrypt every plain-text wallet',
      '                    under it (new wallets are always encrypted). The',
      '                    passphrase is asked at a terminal, or read from',
      '                    MN_PASSPHRASE; every secret mn keeps uses this one',
      '',
      'generate flags:',
      { flag: 'network' },
      { flag: 'seed' },
      { flag: 'mnemonic' },
      { flag: 'force' },
      '',
      'seed flags:',
      { flag: 'entropy' },
      '--json              Print JSON (skips interactive confirmation)',
    ],
    examples: [
      'midnight wallet generate alice --network preprod',
      'midnight wallet list',
      'midnight wallet use alice',
      'midnight wallet info alice',
      'midnight wallet remove bob',
      'midnight wallet seed alice --entropy',
      'midnight wallet protect',
    ],
    jsonFields: {
      name: 'Wallet name (generate, info, seed)',
      active: 'Whether this is the active wallet (generate, use, info)',
      network: 'Network the address is for (info, slim output over MCP)',
      address: 'Unshielded address on that network (info, slim output over MCP)',
      shieldedAddress: 'Shielded address on that network, or null before the first sync (info, slim output over MCP)',
      addresses: `Per-network unshielded addresses { ${getValidNetworkNames().join(', ')} } (generate, info)`,
      shieldedAddresses: `Per-network shielded addresses { ${getValidNetworkNames().join(', ')} } (generate, info)`,
      activeAddress: 'Unshielded address on the active network (generate, info)',
      activeNetwork: 'The active network (generate, list, info)',
      createdAt: 'ISO 8601 creation timestamp (generate, info)',
      file: 'Wallet file path (generate, info)',
      seed: 'Hex-encoded seed (generate, seed; never over MCP)',
      mnemonic: 'BIP-39 mnemonic, 24 words, when the wallet has one (generate, seed; never over MCP)',
      seedShown: 'Over MCP (generate): that the seed and mnemonic are not returned, and the command that shows them',
      entropy: 'The 32-byte BIP-39 entropy (seed with --entropy)',
      wallets: 'Array of wallet info objects (list)',
      wallet: 'The wallet acted on (use, remove)',
      removed: 'true once the wallet is removed (remove)',
      sealed: 'Wallets encrypted by this run (protect)',
      alreadySealed: 'Wallets that were already encrypted (protect)',
      accounts: "What protect did to grant's account records (protect)",
    },
  },
  intro: { brief: 'Manage named wallets', order: 1 },
  needsWalletSdk: false,
  shell: { protectors: true },
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, 'NETWORK_ERROR'] },
  load: () => import('./wallet.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_wallet_generate',
        description: 'Create a wallet and make it the active wallet, as `midnight wallet generate` does. Its seed and mnemonic are not returned; the user sees them at a terminal with `midnight wallet seed <name>`.',
        annotations: { destructiveHint: true },
        params: [
          { name: 'name', schema: { type: 'string' } },
          { flag: 'network' },
          { flag: 'seed' },
          { flag: 'mnemonic' },
          { flag: 'force' },
        ],
        required: ['name'],
        argv: { subcommand: 'generate', positionals: ['name'], flags: 'rest' },
        // Replacing a wallet deletes its seed, so a call with force is confirmed like remove.
        confirmation: {
          when: (params) => params.force === true,
          async check(params, call) {
            const fs = await import('node:fs');
            const { walletFilePath } = await import('../lib/wallet-create.ts');
            const name = String(params.name);
            return fs.existsSync(walletFilePath(call.host.paths().stateRoot, name))
              ? `Replace wallet ${name}: its file, and the seed in it, is deleted from this machine and a new wallet written in its place`
              : `Create wallet ${name} (no wallet of that name exists, so nothing is replaced)`;
          },
        },
        order: 1,
      },
      {
        name: 'midnight_wallet_list',
        description: 'List wallets. Default: per-wallet { name, active, network, address, shieldedAddress } scoped to the active network. Pass { full: true } for the 3-network addresses + shieldedAddresses maps.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        params: [
          {
            name: 'full',
            schema: {
              type: 'boolean',
              description: 'Return full per-network addresses + shieldedAddresses maps (the same shape `mn wallet list --json` emits). Default false (slim).',
            },
          },
        ],
        argv: { subcommand: 'list', flags: ['full'] },
        order: 2,
      },
      {
        name: 'midnight_wallet_use',
        description: 'Set active wallet.',
        annotations: { idempotentHint: true },
        params: [{ name: 'name', schema: { type: 'string' } }],
        required: ['name'],
        argv: { subcommand: 'use', positionals: ['name'], flags: [] },
        order: 3,
      },
      {
        name: 'midnight_wallet_info',
        description: 'Show wallet details. Default: { name, active, network, address, shieldedAddress } scoped to the active network. Pass { full: true } for the per-network maps + createdAt + file path.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        params: [
          { name: 'name', schema: { type: 'string' } },
          {
            name: 'full',
            schema: {
              type: 'boolean',
              description: 'Return the full per-network addresses + shieldedAddresses maps and bookkeeping fields (matches `mn wallet info <name> --json`). Default false (slim).',
            },
          },
        ],
        argv: { subcommand: 'info', positionals: ['name'], flags: ['full'] },
        order: 4,
      },
      {
        // Destructive, so confirmed like the other destructive tools.
        name: 'midnight_wallet_remove',
        description: 'Remove wallet.',
        annotations: { destructiveHint: true },
        params: [{ name: 'name', schema: { type: 'string' } }],
        required: ['name'],
        argv: { subcommand: 'remove', positionals: ['name'], flags: [] },
        confirmation: {
          describe: (params) => `Remove wallet ${params.name}: its file, and the seed in it, is deleted from this machine`,
          // A wallet that can't be removed is refused before the agent asks the user.
          async check(params, call) {
            const { assertWalletRemovable } = await import('../lib/wallet-config.ts');
            assertWalletRemovable(call.host.paths().stateRoot, String(params.name));
          },
        },
        order: 5,
      },
    ],
  },
};
