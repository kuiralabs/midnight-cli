// The `help` command, described once.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core/lib/command-definition';
import { RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands/core.codes';

export const helpDefinition: CommandDefinition = {
  name: 'help',
  order: 200,
  flags: [
    { name: 'agent', takesValue: false },
    { name: 'intro', takesValue: false },
    { name: 'no-intro', takesValue: false },
  ],
  help: {
    description: 'Show usage for all commands or a specific command',
    usage: 'midnight help [command]',
    examples: ['midnight help', 'midnight help balance'],
    jsonFields: {
      cli: 'CLI metadata (name, version, description)',
      globalFlags: 'Array of global flag descriptions',
      commands: 'Array of command specs with jsonFields',
    },
  },
  intro: { brief: 'Show command usage', order: 18 },
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK] },
  load: () => import('./help.ts'),
};
