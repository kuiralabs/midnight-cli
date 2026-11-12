// The `dev` command, described once.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { RUNS_CONTRACTS } from '@kuiralabs/midnight-contract/commands';
import { OPENS_WALLET } from '@kuiralabs/midnight-wallet/commands';

export const devDefinition: CommandDefinition = {
  name: 'dev',
  order: 150,
  flags: [],
  help: {
    description: 'Iteration loop for Compact contract development (localnet + compile-on-save + one-key deploy)',
    usage: 'midnight dev [path]',
    flags: [
      '[path]          Project directory (default: cwd)',
      '',
      'Needs a running ledger-9 stack at the configured endpoints; mn dev does not start one: start it with midnight localnet up (see: midnight help localnet).',
      '',
      'Keystrokes (while running):',
      '  d             Deploy the current compiled artifact (dev-alice on undeployed)',
      '  t             Run the project\'s npm test script (test:dev preferred, then test)',
      '  q             Quit cleanly',
      '  Ctrl+C        Quit cleanly',
    ],
    examples: ['midnight dev', 'midnight dev ./contract'],
    // An interactive loop at a terminal: it writes no JSON result, --json or not.
    jsonFields: {},
  },
  intro: { brief: 'Contract dev loop (watch + deploy)', order: 11 },
  // It provisions wallets itself (airdrop, Dust registration), whose facades' WebSocket handles aren't reliably reclaimed.
  needsWalletSdk: true,
  shell: { payer: true },
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND', RUNS_CONTRACTS, 'WITNESSES_NOT_FOUND', 'NO_PAYER'] },
  load: () => import('./dev.ts'),
};
