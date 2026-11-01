// The `dev` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const devDefinition: CommandDefinition = {
  name: 'dev',
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
  needsWalletSdk: true,
  shell: { signal: true, payer: true },
  load: () => import('./dev.ts'),
};
