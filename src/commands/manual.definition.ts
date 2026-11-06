// The `manual` command, described once.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core';
import { RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';

export const manualDefinition: CommandDefinition = {
  name: 'manual',
  order: 210,
  flags: [
    {
      name: 'no-pager',
      takesValue: false,
      help: ['--no-pager   Print straight to stdout, do not pipe through less'],
    },
    {
      name: 'raw',
      takesValue: false,
      help: ['--raw        Strip ANSI colors (useful for piping to a file)'],
    },
  ],
  help: {
    description: 'Full reference manual (long form, paged through $PAGER)',
    usage: 'midnight manual [--no-pager] [--raw] [--json]',
    flags: [
      { flag: 'no-pager' },
      { flag: 'raw' },
      '--json       Emit the manual text wrapped in a JSON object',
    ],
    examples: [
      'midnight manual',
      'midnight manual --no-pager | grep -i dust',
      'midnight manual --raw > MANUAL.txt',
    ],
    jsonFields: {
      name: 'CLI package name',
      version: 'CLI version',
      manual: 'Manual text (with ANSI colors)',
    },
  },
  intro: { brief: 'Full reference manual', order: 19 },
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK] },
  load: () => import('./manual.ts'),
};
