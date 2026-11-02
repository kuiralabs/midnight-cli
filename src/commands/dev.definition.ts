// The `dev` command, described once.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core/lib/command-definition';

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
      'Needs a running ledger-9 stack at the configured endpoints; this build cannot start one (see: midnight help localnet).',
      '',
      'Keystrokes (while running):',
      '  d             Deploy the current compiled artifact (dev-alice on undeployed)',
      '  t             Run the project\'s npm test script (test:dev preferred, then test)',
      '  q             Quit cleanly',
      '  Ctrl+C        Quit cleanly',
    ],
    examples: ['midnight dev', 'midnight dev ./contract'],
  },
  intro: { brief: 'Contract dev loop (watch + deploy)', order: 11 },
  // It provisions wallets itself (airdrop, Dust registration), whose facades' WebSocket handles aren't reliably reclaimed.
  needsWalletSdk: true,
  shell: { payer: true },
  load: () => import('./dev.ts'),
};
